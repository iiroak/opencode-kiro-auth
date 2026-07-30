import { readFile, writeFile, chmod, open, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { SSO_CACHE_DIR, TOKEN_FILE, EXPIRY_SKEW_MS } from "./constants"

export type KiroToken = {
  accessToken: string
  refreshToken: string
  expiresAt: string
  profileArn?: string
  provider?: string
  // legacy fields kept for compat
  clientIdHash?: string
  authMethod?: string
  region?: string
}

type ClientRegistration = {
  clientId: string
  clientSecret: string
  expiresAt: string
}

export class KiroAuthError extends Error {}

const KAS_DIR = join(homedir(), ".local", "share", "kiro-cli")

// In-memory token cache to avoid hitting the refresh endpoint on every request,
// and a single-flight refresh promise so concurrent requests share one refresh.
let cachedToken: { token: KiroToken; expiresAt: number } | null = null
let inflightRefresh: Promise<KiroToken> | null = null
const MEMORY_TTL_MS = 30 * 1000
const SQLITE_DB = join(KAS_DIR, "data.sqlite3")
const SOCIAL_TOKEN_FILE = join(homedir(), ".kiro", "social_token.json")
const SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
const KAS_DB_TIMEOUT_MS = 3000

/** Cross-process refresh lock. Several opencode instances share one kiro account,
 *  so an in-process promise is not enough to keep them off the refresh endpoint. */
const REFRESH_LOCK_FILE = join(homedir(), ".kiro", "refresh.lock")
const LOCK_STALE_MS = 60 * 1000
const LOCK_WAIT_TOTAL_MS = 30 * 1000
const LOCK_POLL_MS = 250

/** Backoff after a 429 so we stop hammering an endpoint that is already angry.
 *  Shared across the process; honours Retry-After when the server sends one. */
let refreshBlockedUntil = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readFromSqlite(): KiroToken | null {
  try {
    const db = new Database(SQLITE_DB, { readonly: true })
    const row = db.query("SELECT value FROM auth_kv WHERE key = 'kirocli:social:token'").get() as { value: string } | null
    db.close()
    if (!row) return null
    const data = JSON.parse(row.value) as {
      access_token: string
      refresh_token: string
      expires_at: string
      provider?: string
      profile_arn?: string
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      provider: data.provider,
      profileArn: data.profile_arn,
    }
  } catch {
    return null
  }
}

async function readFromEnv(): Promise<KiroToken | null> {
  const apiKey = process.env.KIRO_API_KEY
  if (!apiKey) return null
  const parts = apiKey.split("::")
  if (parts.length >= 2) {
    return { accessToken: parts[0], refreshToken: parts[1], expiresAt: parts[2] || "2099-01-01T00:00:00Z", profileArn: parts[3] || undefined }
  }
  return { accessToken: apiKey, refreshToken: "", expiresAt: "2099-01-01T00:00:00Z" }
}

async function readSocialFile(): Promise<KiroToken | null> {
  try {
    const raw = await readFile(SOCIAL_TOKEN_FILE, "utf8")
    const token = JSON.parse(raw) as KiroToken
    return token.accessToken ? token : null
  } catch {
    return null
  }
}

/** Epoch ms a token expires at, or 0 when unparseable (treated as oldest). */
function expiryOf(token: KiroToken): number {
  const t = Date.parse(token.expiresAt)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Read the token cache.
 *
 * Sources are NOT tried in fixed precedence: kiro-cli's SQLite DB and our own
 * social_token.json drift apart because refreshSocial() can only write the file
 * (the DB is owned by kiro-cli and mode 600). Preferring the DB unconditionally
 * meant reading a token that expired hours ago, refreshing it on every request,
 * and ignoring the perfectly valid token already sitting in the file — which is
 * what produced the sustained 429 storm.
 *
 * So: read every available source and pick the one that expires LAST.
 * KIRO_API_KEY still wins outright, since it is an explicit manual override.
 */
export async function readToken(): Promise<KiroToken> {
  // 1. KIRO_API_KEY env var (manual override, always wins)
  const envToken = await readFromEnv()
  if (envToken) return envToken

  // 2. Every managed source, newest expiry wins.
  const candidates = [readFromSqlite(), await readSocialFile()].filter(
    (t): t is KiroToken => t !== null && Boolean(t.accessToken),
  )

  if (candidates.length > 0) {
    return candidates.reduce((best, t) => (expiryOf(t) > expiryOf(best) ? t : best))
  }

  // 3. Legacy AWS SSO token (~/.aws/sso/cache/kiro-auth-token.json)
  try {
    const raw = await readFile(TOKEN_FILE, "utf8")
    const token = JSON.parse(raw) as KiroToken
    if (!token.accessToken || !token.refreshToken) {
      throw new KiroAuthError("kiro-cli token cache is missing accessToken/refreshToken.")
    }
    return token
  } catch (e) {
    if (e instanceof KiroAuthError) throw e
  }

  throw new KiroAuthError(
    `No kiro-cli token found. Options:\n` +
    `  1. Run: kiro-cli login\n` +
    `  2. Export: KIRO_API_KEY="ACCESS_TOKEN::REFRESH_TOKEN"\n` +
    `  3. Create file: ${SOCIAL_TOKEN_FILE}`,
  )
}

function isExpired(token: KiroToken): boolean {
  const expiresAt = Date.parse(token.expiresAt)
  if (Number.isNaN(expiresAt)) return false
  return expiresAt - EXPIRY_SKEW_MS <= Date.now()
}

/**
 * Return a valid access token, refreshing when needed.
 * For social tokens, refresh against kiro's auth server.
 * For legacy AWS SSO tokens, use the SSO-OIDC refresh flow.
 *
 * Results are cached in memory for MEMORY_TTL_MS so concurrent requests don't
 * all hit the refresh endpoint. Refreshes are single-flight: if a refresh is
 * already in progress, callers await the same promise instead of firing their
 * own request (this is what prevents the 429 storm when multiple opencode
 * requests arrive at once while the token is about to expire).
 */
export async function getValidAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now && !isExpired(cachedToken.token)) {
    return cachedToken.token.accessToken
  }

  const onDisk = await readToken()
  if (!isExpired(onDisk)) {
    cachedToken = { token: onDisk, expiresAt: now + MEMORY_TTL_MS }
    return onDisk.accessToken
  }
  if (!onDisk.refreshToken) {
    cachedToken = { token: onDisk, expiresAt: now + MEMORY_TTL_MS }
    return onDisk.accessToken
  }

  const refreshed = await getOrStartRefresh(onDisk)
  cachedToken = { token: refreshed, expiresAt: Date.now() + MEMORY_TTL_MS }
  return refreshed.accessToken
}

async function getOrStartRefresh(token: KiroToken): Promise<KiroToken> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = (async () => {
    try {
      return await refreshWithLock(token)
    } finally {
      inflightRefresh = null
    }
  })()
  return inflightRefresh
}

/**
 * Acquire the cross-process lock, then refresh — but re-read disk first, because
 * whoever held the lock before us has probably already written a fresh token and
 * ours would be a redundant (and rate-limited) call.
 */
async function refreshWithLock(token: KiroToken): Promise<KiroToken> {
  const held = await acquireLock()
  try {
    const onDisk = await readToken().catch(() => null)
    if (onDisk && !isExpired(onDisk)) return onDisk

    if (Date.now() < refreshBlockedUntil) {
      const waitS = Math.ceil((refreshBlockedUntil - Date.now()) / 1000)
      throw new KiroAuthError(
        `kiro refresh endpoint rate-limited this client; backing off ${waitS}s. ` +
        `If this persists, run: kiro-cli login`,
      )
    }

    return await refresh(onDisk ?? token)
  } finally {
    if (held) await unlink(REFRESH_LOCK_FILE).catch(() => {})
  }
}

/** Returns true if we own the lock (and must release it), false if we gave up
 *  waiting and are proceeding anyway rather than failing the request outright. */
async function acquireLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_TOTAL_MS
  for (;;) {
    try {
      // wx: fails if the file exists — atomic create, our mutex.
      const fh = await open(REFRESH_LOCK_FILE, "wx", 0o600)
      await fh.writeFile(String(process.pid))
      await fh.close()
      return true
    } catch {
      // Someone holds it. Break a stale lock left behind by a killed process.
      const age = await stat(REFRESH_LOCK_FILE)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY)
      if (age > LOCK_STALE_MS) {
        await unlink(REFRESH_LOCK_FILE).catch(() => {})
        continue
      }
      if (Date.now() > deadline) return false
      await sleep(LOCK_POLL_MS)
      // A holder that finished may have written a fresh token; caller re-reads.
      const onDisk = await readToken().catch(() => null)
      if (onDisk && !isExpired(onDisk)) return false
    }
  }
}

async function refresh(token: KiroToken): Promise<KiroToken> {
  // Social token refresh (kiro-cli v2.10.0+)
  if (!token.clientIdHash) {
    return refreshSocial(token)
  }
  // Legacy AWS SSO token refresh
  return refreshSso(token)
}

async function refreshSocial(token: KiroToken): Promise<KiroToken> {
  const res = await fetch(SOCIAL_REFRESH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "opencode-kiro-auth/1.0",
    },
    body: JSON.stringify({ refreshToken: token.refreshToken, provider: token.provider || "Github" }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"))
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000
      refreshBlockedUntil = Date.now() + backoffMs
    }
    throw new KiroAuthError(`Failed to refresh kiro social token (${res.status}). ${detail}`)
  }

  const body = (await res.json()) as {
    accessToken: string
    refreshToken?: string
    expiresIn: number
    profileArn?: string
  }

  const next: KiroToken = {
    ...token,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? token.refreshToken,
    expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString(),
    profileArn: body.profileArn ?? token.profileArn,
  }

  refreshBlockedUntil = 0
  await persistSocial(next)
  return next
}

/** Write the refreshed token, 600 — it is a bearer credential. */
async function persistSocial(token: KiroToken): Promise<void> {
  await writeFile(SOCIAL_TOKEN_FILE, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 }).catch(
    () => {},
  )
  await chmod(SOCIAL_TOKEN_FILE, 0o600).catch(() => {})
}

async function refreshSso(token: KiroToken): Promise<KiroToken> {
  const region = token.region ?? "us-east-1"
  const client = await readClientRegistration(token.clientIdHash!)

  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      grantType: "refresh_token",
      refreshToken: token.refreshToken,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new KiroAuthError(`Failed to refresh kiro-cli token (${res.status}). ${detail}`)
  }

  const body = (await res.json()) as {
    accessToken: string
    refreshToken?: string
    expiresIn: number
  }

  const next: KiroToken = {
    ...token,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? token.refreshToken,
    expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString(),
  }

  await writeFile(TOKEN_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {})
  return next
}

async function readClientRegistration(clientIdHash: string): Promise<ClientRegistration> {
  const file = join(SSO_CACHE_DIR, `${clientIdHash}.json`)
  const raw = await readFile(file, "utf8").catch(() => {
    throw new KiroAuthError(`Client registration not found at ${file}. Re-run kiro-cli login.`)
  })
  return JSON.parse(raw) as ClientRegistration
}

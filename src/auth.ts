import { readFile, writeFile } from "node:fs/promises"
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
const SQLITE_DB = join(KAS_DIR, "data.sqlite3")
const SOCIAL_TOKEN_FILE = join(homedir(), ".kiro", "social_token.json")
const SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
const KAS_DB_TIMEOUT_MS = 3000

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

/** Read the token cache. Tries: env var, SQLite DB, file, legacy AWS SSO. */
export async function readToken(): Promise<KiroToken> {
  // 1. KIRO_API_KEY env var (manual override)
  const envToken = await readFromEnv()
  if (envToken) return envToken

  // 2. kiro-cli v2 SQLite database (~/.local/share/kiro-cli/data.sqlite3)
  const sqliteToken = readFromSqlite()
  if (sqliteToken) return sqliteToken

  // 3. Social token file (~/.kiro/social_token.json)
  try {
    const raw = await readFile(SOCIAL_TOKEN_FILE, "utf8")
    const token = JSON.parse(raw) as KiroToken
    if (token.accessToken) return token
  } catch {}

  // 4. Legacy AWS SSO token (~/.aws/sso/cache/kiro-auth-token.json)
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
 */
export async function getValidAccessToken(): Promise<string> {
  const token = await readToken()
  if (!isExpired(token)) return token.accessToken
  if (!token.refreshToken) return token.accessToken
  const refreshed = await refresh(token)
  return refreshed.accessToken
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

  await writeFile(SOCIAL_TOKEN_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {})
  return next
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

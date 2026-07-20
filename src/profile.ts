import {
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_LIST_PROFILES_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_MGMT_USER_AGENT,
  KIRO_PROFILE_ARN_PLACEHOLDER,
} from "./constants"
import { readToken, type KiroToken } from "./auth"

let cached: string | undefined
let cachedToken: KiroToken | null = null

/**
 * Resolve the profileArn the same way kiro-cli does, supporting every account type:
 *   - Social tokens (GitHub/Google login): profileArn is embedded in the token itself.
 *   - IdC / enterprise accounts: use the real ARN from ListAvailableProfiles.
 *   - Builder ID accounts (incl. Builder-ID-backed Pro): the API is not authorized,
 *     so fall back to the fixed placeholder kiro-cli itself uses.
 * The result is cached for the process lifetime.
 */
export async function getProfileArn(accessToken: string): Promise<string> {
  if (cached) return cached

  // Check if the token has an embedded profileArn (kiro-cli v2 social login)
  try {
    if (!cachedToken) cachedToken = await readToken()
    if (cachedToken?.profileArn) {
      cached = cachedToken.profileArn
      return cached
    }
  } catch {}

  // Fall back to ListAvailableProfiles API
  cached = await listFirstProfileArn(accessToken).catch(() => KIRO_PROFILE_ARN_PLACEHOLDER)
  return cached
}

async function listFirstProfileArn(accessToken: string): Promise<string> {
  const res = await fetch(`${KIRO_MANAGEMENT_ENDPOINT}?origin=KIRO_CLI`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": KIRO_CONTENT_TYPE,
      "x-amz-target": KIRO_LIST_PROFILES_TARGET,
      "user-agent": KIRO_MGMT_USER_AGENT,
      "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
      "x-amzn-codewhisperer-optout": "false",
    },
    body: "{}",
  })
  if (!res.ok) return KIRO_PROFILE_ARN_PLACEHOLDER
  const data = (await res.json().catch(() => null)) as { profiles?: Array<{ arn?: string }> } | null
  const arn = data?.profiles?.find((p) => typeof p.arn === "string" && p.arn.length > 0)?.arn
  return arn ?? KIRO_PROFILE_ARN_PLACEHOLDER
}

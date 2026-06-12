// Run: bun run script/check-auth.ts
// Verifies the plugin can read + refresh kiro-cli credentials. Never prints the token.
import { readToken, getValidAccessToken } from "../src/auth"

const token = await readToken()
console.log("kiro-cli token found:")
console.log("  provider   :", token.provider)
console.log("  region     :", token.region)
console.log("  authMethod :", token.authMethod)
console.log("  expiresAt  :", token.expiresAt)

const access = await getValidAccessToken()
console.log("access token usable: yes (length=" + access.length + ")")

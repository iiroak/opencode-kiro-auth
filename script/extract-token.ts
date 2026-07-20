// Run: bun run script/extract-token.ts
// Extracts the kiro-cli social token from the SQLite database
// and saves it to ~/.kiro/social_token.json for the plugin to use.
import { join } from "node:path"
import { homedir } from "node:os"
import { writeFileSync, existsSync, mkdirSync } from "node:fs"
import { Database } from "bun:sqlite"

const KIRO_DIR = join(homedir(), ".kiro")
const SOCIAL_TOKEN_FILE = join(KIRO_DIR, "social_token.json")
const SQLITE_DB = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")

function log(msg: string) { console.log(`  ${msg}`) }
function err(msg: string) { console.error(`  [ERROR] ${msg}`) }

console.log("kiro-cli token extractor (SQLite)")
console.log("==================================\n")

if (!existsSync(KIRO_DIR)) mkdirSync(KIRO_DIR, { recursive: true })

try {
  const db = new Database(SQLITE_DB, { readonly: true })
  const row = db.query("SELECT value FROM auth_kv WHERE key = 'kirocli:social:token'").get() as { value: string } | null
  db.close()

  if (!row) {
    err("No social token found in kiro-cli database")
    console.log(`\nRun: kiro-cli login`)
    process.exit(1)
  }

  const data = JSON.parse(row.value)
  if (!data.access_token) {
    err("Token data is missing access_token")
    process.exit(1)
  }

  const token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    provider: data.provider,
    profileArn: data.profile_arn,
  }

  writeFileSync(SOCIAL_TOKEN_FILE, JSON.stringify(token, null, 2), "utf8")
  log("Token extracted successfully!")
  log(`Saved to ${SOCIAL_TOKEN_FILE}`)
  console.log(`  Provider: ${data.provider || "unknown"}`)
  console.log(`  Profile ARN: ${data.profile_arn || "none"}`)
  console.log(`  Expires: ${data.expires_at || "unknown"}`)
  console.log(`  Access token length: ${data.access_token.length}`)
  console.log(`\nThe plugin can now use this token.`)
  process.exit(0)
} catch (e) {
  err(`Failed: ${e}`)
  console.log(`\nAlternative: Export KIRO_API_KEY="ACCESS_TOKEN::REFRESH_TOKEN::EXPIRES::PROFILE_ARN"`)
  process.exit(1)
}

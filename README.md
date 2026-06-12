# opencode-kiro-auth

> **Disclaimer — use at your own risk.** This is an unofficial tool, not affiliated
> with Kiro/Amazon/AWS. Using a Kiro subscription outside its official client may
> violate the provider''s Terms of Service and **could get your account suspended or
> banned**. It is intended for personal, local use only. You assume all risk.

Use the credentials `kiro-cli` already stored (AWS SSO / Builder ID) as an opencode
provider. No separate login: opencode keeps only a sentinel marker, and the real
bearer token is read and refreshed live from `~/.aws/sso/cache/kiro-auth-token.json`
on every request. Requests are shaped to match kiro-cli''s wire format.

## Setup

1. Log in with kiro-cli once: `kiro-cli login`
2. Verify the plugin can read/refresh the token (never prints it):
   `bun run script/check-auth.ts`
3. Add the plugin and the `provider` block to `~/.config/opencode/opencode.json`
   (see `opencode.example.jsonc`). Pick one plugin spec form:
   - Local folder: `"file:///ABSOLUTE/PATH/TO/opencode-kiro-auth"`
   - Git: `"github:<user>/opencode-kiro-auth"` (optionally `#<tag>` to pin)
   - npm (if published): `"opencode-kiro-auth@latest"`
4. Connect: `opencode auth login` -> pick **Kiro** -> "Use existing kiro-cli login".
5. Run: `opencode run "hello" --model kiro/claude-sonnet-4.6`

## How it works

- `auth.ts` reads/refreshes kiro-cli''s SSO token in place (shared cache).
- `profile.ts` resolves the profileArn like kiro-cli: real ARN for accounts that
  have one, else the fixed Builder-ID placeholder.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro''s
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream.
- `plugin.ts` registers the opencode `auth` hook whose loader returns the
  intercepting `fetch`.

## Author

Toan Doan <toandev.95@gmail.com>

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

## Kiro usage command

The package also provides an optional OpenCode TUI target that exposes `/kiro-usage`.
It runs Kiro's own non-interactive usage command and displays the result in an OpenCode
dialog, preserving Kiro's usage colors and progress bar. Configure the TUI target
separately in `tui.json` (see `tui.example.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["github:iiroak/opencode-kiro-auth"]
}
```

The command uses `kiro-cli chat --no-interactive "/usage"`, which is the supported
invocation in current Kiro CLI releases. Verify it directly with:

```text
bun run script/test-usage.ts
```

If `kiro-cli` is not in `PATH`, the command displays an actionable error instead of
blocking the TUI.

## How it works

- `auth.ts` reads/refreshes kiro-cli''s SSO token in place (shared cache).
- `profile.ts` resolves the profileArn like kiro-cli: real ARN for accounts that
  have one, else the fixed Builder-ID placeholder.
- `models.ts` reads Kiro''s model catalog (`ListAvailableModels`) to learn which
  reasoning effort levels each model accepts and which request field to send them in.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro''s
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream.
- `plugin.ts` registers the opencode `auth` hook whose loader returns the
  intercepting `fetch`.

## Reasoning effort (variants)

opencode''s variant picker maps to Kiro''s per-model reasoning effort. Configure a
variant with an `effort` value and the plugin forwards it:

```jsonc
"claude-opus-5": {
  "variants": {
    "low": { "effort": "low" },
    "max": { "effort": "max" },
  },
},
```

Kiro takes the level as a top-level `additionalModelRequestFields` alongside
`conversationState` — not inside it — and the field name differs per model family:
Claude models use `output_config.effort` (sent with an adaptive `thinking` block,
matching kiro-cli), GPT models use `reasoning.effort`.

Both the field name and the valid levels are read at runtime from
`ListAvailableModels` (cached per process), so new models and changed level sets
work without touching the plugin. Levels genuinely differ: `claude-opus-5` accepts
`low…max` including `xhigh`, `claude-opus-4.6` has no `xhigh`, `gpt-5.6-*` add
`none`, and models like `claude-sonnet-4.5` or `glm-5` expose no effort control.

Requesting an unsupported level is clamped to the closest supported one rather than
failing — Kiro rejects a bad level with a 400 `ValidationException`. If no effort is
requested, or the model has none, the field is omitted and Kiro applies its own
default.

## Large images and long sessions

Kiro caps the total size of a request (history plus images), returning a 400
`CONTENT_LENGTH_EXCEEDS_THRESHOLD` when exceeded. Because opencode resends the full
history — including every prior image — image-heavy sessions can hit this limit even
when the token count looks small. To avoid it, the plugin keeps images only on the most
recent image-bearing turns and replaces older ones with an `[image omitted]` marker.

- Tune with `KIRO_KEEP_IMAGE_TURNS` (default `2`; `0` strips all images).
- If a request still overflows, the error is surfaced as a context-overflow message, so
  opencode suggests starting a new session or running `/compact`.

## Web search (no API key)

The plugin also registers a `web_search` tool backed by Kiro''s built-in web search,
the same one kiro-cli uses. It runs server-side on Kiro''s backend through the
CodeWhisperer `InvokeMCP` operation, authenticated with your existing kiro-cli login,
so it needs no third-party search API key.

- `mcp.ts` calls `InvokeMCP` (JSON-RPC `tools/call` for `web_search`) and parses the
  `{ "results": [...] }` payload.
- `tools.ts` exposes it to opencode as the `web_search` tool, returning titles, URLs,
  and snippets with inline citation hints.

Verify it end to end (uses your live login, prints no token):
`bun run script/test-websearch.ts "latest Node.js LTS version"`

## Author

Toan Doan <toandev.95@gmail.com>

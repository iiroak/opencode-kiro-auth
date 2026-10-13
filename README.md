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
- `models.ts` reads Kiro''s model catalog (`ListAvailableModels`) for available model
  IDs, context/output limits, input modalities, and reasoning effort levels.
- `transform.ts` maps the Anthropic Messages request opencode sends into Kiro''s
  CodeWhisperer `GenerateAssistantResponse` request (text, tool calls, images), and
  converts the AWS event-stream response back into an Anthropic SSE stream.
- `plugin.ts` refreshes the configured Kiro model list during OpenCode startup and
  registers the `auth` hook whose loader returns the intercepting `fetch`.

The catalog is cached for five minutes inside the server process. Restart OpenCode
to refresh model availability after Kiro publishes a new model. If discovery fails,
the plugin logs the failure and keeps the model entries already in the config.

## Usage estimates and auto-compaction

Kiro streams `contextUsageEvent` as a percentage, while OpenCode treats Anthropic
`usage.input_tokens` as a token count when deciding whether to compact. The plugin
estimates input usage from the outgoing request instead: it counts the serialized
prompt at roughly 3.5 ASCII characters per token, counts non-ASCII characters
conservatively, and budgets 8,000 tokens per image. Base64 image bytes are removed
before estimating, so the encoded file size cannot turn into hundreds of thousands
of apparent tokens. This remains an estimate and can differ from Kiro's own `/context`
display.

## Reasoning effort (variants)

OpenCode''s model picker is populated from Kiro''s live model catalog, so there is no
per-model list to maintain in `opencode.json`. The plugin creates each model''s
available variants from the same API schema used for requests.

Kiro takes the level as a top-level `additionalModelRequestFields` alongside
`conversationState` — not inside it — and the field name differs per model family:
Claude models use `output_config.effort` (sent with an adaptive `thinking` block,
matching kiro-cli), GPT models use `reasoning.effort`.

Both the field name and valid levels are read from `ListAvailableModels`, so new
models and changed level sets appear after restarting OpenCode without editing the
plugin or model config. Levels genuinely differ: `claude-opus-5` accepts
`low…max` including `xhigh`, `claude-opus-4.6` has no `xhigh`, `gpt-5.6-*` add
`none`, and models like `claude-sonnet-4.5` or `glm-5` expose no effort control.

Requesting an unsupported level is clamped to the closest supported one rather than
failing — Kiro rejects a bad level with a 400 `ValidationException`. If no effort is
requested, or the model has none, the field is omitted and Kiro applies its own
default.

## Live reasoning with Kiro ACP

The direct HTTP transport forwards Kiro's `reasoningContentEvent` frames as soon as
the endpoint sends them. Kiro's HTTP endpoint can deliver the complete thinking block
in one short burst near the end of a response, so it may appear only after the model
finishes reasoning. To use Kiro CLI's live `agent_thought_chunk` updates instead,
select its ACP transport:

```jsonc
"plugin": [
  ["file:///ABSOLUTE/PATH/TO/opencode-kiro-auth", { "transport": "acp" }]
]
```

ACP requires `kiro-cli` to be installed and logged in. It rebuilds the conversation as
a text transcript and passes images through ACP. Kiro CLI starts a fresh ACP session
for each completion, so expect extra startup latency. The tools OpenCode enabled for
that request are exposed through a short-lived MCP bridge. Kiro's tool calls return as
ordinary OpenCode tool calls, and OpenCode executes them with its existing permissions
and MCP setup. The bridge listens only on localhost, uses a per-request random token,
and removes its temporary configuration when the request ends. For bridged tool calls,
Node.js must be available in the OpenCode server's `PATH`; set `KIRO_ACP_NODE_PATH` if
the `node` executable is elsewhere.

Kiro's own built-in tools remain disabled by default, so file access, shell commands,
and other actions still go through OpenCode. To additionally allow Kiro CLI to run its
built-in tools outside OpenCode's per-call permission prompts, set
`"trustAcpTools": true` in the plugin options, or set `KIRO_ACP_TRUST_TOOLS=1` in the
OpenCode server environment.

For a temporary switch, set `KIRO_TRANSPORT=acp` before starting OpenCode. An explicit
plugin option of `"transport": "api"` keeps the direct HTTP transport even when that
environment variable is set.

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

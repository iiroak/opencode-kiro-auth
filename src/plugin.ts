import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROVIDER_ID, DEFAULT_MODEL } from "./constants"
import { getValidAccessToken, readToken, KiroAuthError } from "./auth"
import { toKiroRequest, kiroToAnthropicStream, mapKiroError } from "./transform"
import { getProfileArn } from "./profile"
import { resolveContextLimit } from "./limits"
import { tools } from "./tools"

// TEMP diagnostic: dump a failing request (long strings + image bytes truncated).
function dumpInvalid(anthropic: any, kiroBody: string) {
  try {
    const trunc = (_k: string, v: any) => {
      if (typeof v === "string" && v.length > 300) return `[str ${v.length}] ${v.slice(0, 120)}`
      return v
    }
    const inSeq = (anthropic?.messages ?? []).map((m: any) => {
      const blocks = Array.isArray(m.content)
        ? m.content.map((b: any) => {
            if (b.type === "tool_use") return { tool_use: b.id, name: b.name, inputType: typeof b.input, input: b.input }
            if (b.type === "tool_result")
              return { tool_result: b.tool_use_id, contentType: Array.isArray(b.content) ? "array" : typeof b.content, is_error: b.is_error }
            if (b.type === "text") return { text: (b.text ?? "").slice(0, 120), len: (b.text ?? "").length }
            return { type: b.type }
          })
        : [{ text: String(m.content).slice(0, 120) }]
      return { role: m.role, blocks }
    })
    const payload = JSON.parse(kiroBody)
    writeFileSync(
      join(tmpdir(), "kiro-invalid-request.json"),
      JSON.stringify({ input: inSeq, kiroPayload: payload }, trunc, 2),
    )
  } catch {
    // diagnostics must never throw
  }
}

/**
 * opencode plugin that lets you use kiro-cli''s existing AWS SSO/IdC credentials
 * as a normal opencode provider, without a separate login. opencode stores only a
 * sentinel auth marker; the real bearer token is always read (and refreshed) straight
 * from kiro-cli''s own cache on every request.
 */
export async function KiroAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    tool: tools,
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Use existing kiro-cli login (no browser)",
          authorize: async () => ({
            url: "",
            instructions: "Reusing the credentials kiro-cli already stored.",
            method: "auto",
            callback: async () => {
              await readToken().catch((error) => {
                throw error instanceof KiroAuthError ? error : new KiroAuthError(String(error))
              })
              return { type: "success", refresh: "kiro-cli-managed", access: "", expires: 0 }
            },
          }),
        },
      ],
      loader: async () => ({
        apiKey: "",
        async fetch(_input: Parameters<typeof fetch>[0], init?: RequestInit) {
          const accessToken = await getValidAccessToken()
          const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {}
          const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL

          const profileArn = await getProfileArn(accessToken)
          const request = toKiroRequest(body, accessToken, profileArn)
          const response = await fetch(request.url, request.init)

          if (!response.ok) {
            // Reshape known Kiro errors (e.g. content-length overflow) into an actionable
            // message; opencode persists the raw body in its session store for anything else.
            const detail = await response.text().catch(() => "")
            if (/REQUEST_BODY_INVALID|Invalid tool use/.test(detail)) dumpInvalid(body, request.init.body as string)
            const mapped = mapKiroError(detail, response.status)
            return new Response(mapped.body, {
              status: mapped.status,
              headers: { "content-type": "application/json" },
            })
          }

          // Context window is read from the live opencode config so the synthesized usage
          // percentage matches what opencode shows.
          const contextLimit = await resolveContextLimit(input.client, PROVIDER_ID, model)
          return kiroToAnthropicStream(response, model, contextLimit)
        },
      }),
    },
  }
}

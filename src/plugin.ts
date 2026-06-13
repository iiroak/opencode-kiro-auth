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

// TEMP diagnostic: dump the post-transform Kiro payload (contents truncated) on a tool-format error.
function dumpInvalid(_anthropic: any, kiroBody: string) {
  try {
    const cs = JSON.parse(kiroBody).conversationState
    const sum = (e: any) =>
      e.userInputMessage
        ? {
            role: "user",
            content: (e.userInputMessage.content ?? "").slice(0, 200),
            contentLen: (e.userInputMessage.content ?? "").length,
            res: (e.userInputMessage.userInputMessageContext?.toolResults ?? []).map((t: any) => ({ id: t.toolUseId, status: t.status, text: (t.content?.[0]?.text ?? "").slice(0, 80) })),
            nTools: (e.userInputMessage.userInputMessageContext?.tools ?? []).length,
          }
        : {
            role: "assistant",
            content: (e.assistantResponseMessage.content ?? "").slice(0, 200),
            contentLen: (e.assistantResponseMessage.content ?? "").length,
            use: (e.assistantResponseMessage.toolUses ?? []).map((t: any) => ({ id: t.toolUseId, name: t.name, inputKeys: Object.keys(t.input ?? {}) })),
          }
    writeFileSync(
      join(tmpdir(), "kiro-invalid-request.json"),
      JSON.stringify([...cs.history.map(sum), { current: true, ...sum(cs.currentMessage) }], null, 2),
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

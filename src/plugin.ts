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

// TEMP diagnostic: structural dump of a failing request (no heavy payloads).
function dumpInvalid(anthropic: any, kiroBody: string) {
  try {
    const inSeq = (anthropic?.messages ?? []).map((m: any) => {
      const blocks = Array.isArray(m.content)
        ? m.content.map((b: any) =>
            b.type === "tool_use"
              ? `tool_use#${b.id}(${b.name})`
              : b.type === "tool_result"
                ? `tool_result#${b.tool_use_id}`
                : b.type,
          )
        : ["text"]
      return { role: m.role, blocks }
    })
    const cs = JSON.parse(kiroBody).conversationState
    const sumEntry = (e: any) =>
      e.userInputMessage
        ? {
            role: "user",
            textLen: (e.userInputMessage.content || "").length,
            toolResults: (e.userInputMessage.userInputMessageContext?.toolResults ?? []).map((t: any) => t.toolUseId),
            tools: (e.userInputMessage.userInputMessageContext?.tools ?? []).map((t: any) => t.toolSpecification.name),
          }
        : {
            role: "assistant",
            textLen: (e.assistantResponseMessage.content || "").length,
            toolUses: (e.assistantResponseMessage.toolUses ?? []).map((t: any) => `${t.toolUseId}(${t.name})`),
          }
    const out = { input: inSeq, kiro: [...cs.history.map(sumEntry), { current: true, ...sumEntry(cs.currentMessage) }] }
    writeFileSync(join(tmpdir(), "kiro-invalid-request.json"), JSON.stringify(out, null, 2))
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

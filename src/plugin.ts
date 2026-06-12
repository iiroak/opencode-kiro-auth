import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { PROVIDER_ID } from "./constants"
import { getValidAccessToken, readToken, KiroAuthError } from "./auth"
import { toKiroRequest, kiroToAnthropicStream } from "./transform"
import { getProfileArn } from "./profile"

/**
 * opencode plugin that lets you use kiro-cli''s existing AWS SSO/IdC credentials
 * as a normal opencode provider, without a separate login. opencode stores only a
 * sentinel auth marker; the real bearer token is always read (and refreshed) straight
 * from kiro-cli''s own cache on every request.
 */
export async function KiroAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
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
          const model = typeof body.model === "string" ? body.model : "claude-sonnet-4.6"

          const profileArn = await getProfileArn(accessToken)
          const request = toKiroRequest(body, accessToken, profileArn)
          const response = await fetch(request.url, request.init)

          if (!response.ok) {
            const detail = await response.text().catch(() => "")
            return new Response(detail || `Kiro request failed (${response.status})`, {
              status: response.status,
              headers: { "content-type": "application/json" },
            })
          }

          return kiroToAnthropicStream(response, model)
        },
      }),
    },
  }
}

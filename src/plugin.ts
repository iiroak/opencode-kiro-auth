import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { PROVIDER_ID, DEFAULT_MODEL } from "./constants"
import { getValidAccessToken, readToken, KiroAuthError } from "./auth"
import { toKiroRequest, kiroToAnthropicStream, mapKiroError, requestedEffort } from "./transform"
import { getProfileArn } from "./profile"
import {
  getAvailableModels,
  getDefaultModel,
  getModelEffort,
  resolveEffortLevel,
  buildEffortRequestFields,
  toProviderModels,
  type ProviderModelConfig,
} from "./models"
import { resolveContextLimit } from "./limits"
import { tools } from "./tools"

/**
 * Resolve the `additionalModelRequestFields` payload for the effort opencode asked
 * for, or undefined when no effort applies (none requested, model advertises none,
 * or the catalog was unreachable) — in which case Kiro uses the model's default.
 */
async function resolveEffortFields(
  accessToken: string,
  profileArn: string,
  model: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const requested = requestedEffort(body)
  if (!requested) return undefined

  const effort = await getModelEffort(accessToken, profileArn, model)
  if (!effort) return undefined

  const level = resolveEffortLevel(effort, requested)
  if (!level) return undefined

  return buildEffortRequestFields(level, effort.schemaPath)
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
    // OpenCode 1.18.x skips provider.models for custom provider IDs absent from
    // models.dev. Its config hook runs before provider initialization, so mutate
    // the configured model map here instead.
    config: async (config: Config) => {
      const provider = config.provider?.[PROVIDER_ID] as unknown as
        | { models?: Record<string, Partial<ProviderModelConfig>> }
        | undefined
      if (!provider) return

      try {
        const accessToken = await getValidAccessToken()
        const profileArn = await getProfileArn(accessToken)
        const catalog = await getAvailableModels(accessToken, profileArn)
        const models = toProviderModels(catalog.models)

        // Keep user-authored display/request overrides for models Kiro still lists,
        // while availability, limits, modalities, and effort levels stay live.
        for (const [id, model] of Object.entries(models)) {
          const configured = provider.models?.[id]
          if (!configured) continue
          if (configured.id) model.id = configured.id
          if (configured.name) model.name = configured.name
          if (configured.options) model.options = configured.options
          if (configured.headers) model.headers = configured.headers
        }

        provider.models = models
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        console.warn(
          `[opencode-kiro-auth] Could not refresh Kiro's model catalog; keeping configured models. ${detail}`,
        )
      }
    },
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
          const profileArn = await getProfileArn(accessToken)
          const model =
            typeof body.model === "string"
              ? body.model
              : await getDefaultModel(accessToken, profileArn).catch(() => DEFAULT_MODEL)

          // Translate the variant opencode selected into Kiro's per-model effort field.
          // The level set and the field name are both read from Kiro's model catalog,
          // and an unsupported level is clamped rather than rejected.
          const effortFields = await resolveEffortFields(accessToken, profileArn, model, body)

          const request = toKiroRequest(body, accessToken, profileArn, effortFields)
          const response = await fetch(request.url, request.init)

          if (!response.ok) {
            // Reshape known Kiro errors (e.g. content-length overflow) into an actionable
            // message; opencode persists the raw body in its session store for anything else.
            const detail = await response.text().catch(() => "")
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

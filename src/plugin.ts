import type { Config, Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { PROVIDER_ID, DEFAULT_MODEL } from "./constants"
import { getValidAccessToken, readToken, KiroAuthError } from "./auth"
import { toKiroRequest, kiroToAnthropicStream, mapKiroError, requestedEffort } from "./transform"
import { kiroAcpToAnthropicStream } from "./acp"
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
export async function KiroAuthPlugin(input: PluginInput, options: PluginOptions = {}): Promise<Hooks> {
  const configuredTransport = options.transport
  const transport = configuredTransport === "acp" ||
    (configuredTransport !== "api" && process.env.KIRO_TRANSPORT === "acp")
      ? "acp"
      : "api"
  const trustAcpTools = options.trustAcpTools === true || process.env.KIRO_ACP_TRUST_TOOLS === "1"

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
          const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : {}
          const requestedModel = typeof body.model === "string" ? body.model : undefined

          if (transport === "acp") {
            return kiroAcpToAnthropicStream(
              body,
              requestedModel ?? DEFAULT_MODEL,
              requestedEffort(body),
              input.directory,
              trustAcpTools,
              init?.signal,
            )
          }

          const accessToken = await getValidAccessToken()
          const profileArn = await getProfileArn(accessToken)
          const model = requestedModel ?? await getDefaultModel(accessToken, profileArn).catch(() => DEFAULT_MODEL)

          // Translate the variant opencode selected into Kiro's per-model effort field.
          // The level set and the field name are both read from Kiro's model catalog,
          // and an unsupported level is clamped rather than rejected.
          const effortFields = await resolveEffortFields(accessToken, profileArn, model, body)

          const request = toKiroRequest(body, accessToken, profileArn, effortFields)
          // Preserve OpenCode's abort signal (timeouts, user cancellation, and
          // stream-idle watchdogs) through this custom fetch to Kiro's endpoint.
          const streamAbort = new AbortController()
          const signal = init?.signal
            ? AbortSignal.any([init.signal, streamAbort.signal])
            : streamAbort.signal
          const response = await fetch(request.url, { ...request.init, signal })

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

          // Kiro supplies context occupancy as a percentage, which OpenCode would mistake
          // for exact input tokens and use to trigger compaction. Use the request estimate
          // calculated with image base64 bytes excluded instead.
          return kiroToAnthropicStream(response, model, request.estimatedInputTokens, streamAbort)
        },
      }),
    },
  }
}

import type { PluginInput } from "@opencode-ai/plugin"

/**
 * Resolve a model's context window.
 *
 * Kiro reports context usage as a percentage; opencode's gauge is token-based, so we convert
 * the percentage into a token count using the model's context window. Those window sizes are
 * already defined in the user's opencode provider config, so we read them live (cached for the
 * process lifetime) rather than duplicating a table here. If the config can't be read we fall
 * back to a generous default — this only affects the cosmetic usage gauge, never correctness.
 */
const DEFAULT_CONTEXT_LIMIT = 1_000_000

type Client = PluginInput["client"]

let limitsPromise: Promise<Record<string, number>> | null = null

async function loadConfiguredLimits(client: Client, providerId: string): Promise<Record<string, number>> {
  const res = (await client.config.providers()) as any
  const body = res?.data ?? res
  const providers: any[] = Array.isArray(body?.providers) ? body.providers : []
  const provider = providers.find((p) => p?.id === providerId)
  const out: Record<string, number> = {}
  for (const [id, model] of Object.entries<any>(provider?.models ?? {})) {
    const ctx = model?.limit?.context
    if (typeof ctx === "number" && ctx > 0) out[id] = ctx
  }
  return out
}

/** Resolve the context window for `model` from opencode config; defaults if unavailable. Never throws. */
export async function resolveContextLimit(
  client: Client | undefined,
  providerId: string,
  model: string,
): Promise<number> {
  if (client && !limitsPromise) limitsPromise = loadConfiguredLimits(client, providerId).catch(() => ({}))
  const configured = limitsPromise ? await limitsPromise : {}
  return configured[model] ?? DEFAULT_CONTEXT_LIMIT
}

import {
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_LIST_MODELS_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_MGMT_USER_AGENT,
} from "./constants"

/**
 * Per-model reasoning-effort capabilities, read from Kiro's own model catalog.
 *
 * Kiro advertises the effort levels a model accepts inside each model's
 * `additionalModelRequestFieldsSchema` (a JSON Schema), and the request field it
 * expects them in differs per family:
 *
 *   Claude:  { properties: { output_config: { properties: { effort: { enum, default } } } } }
 *   GPT:     { properties: { reasoning:     { properties: { effort: { enum, default } } } } }
 *
 * kiro-cli resolves this at runtime from `ListAvailableModels` (see
 * `parseEffortLevels` / `EFFORT_SCHEMA_PATHS` in its bundled agent) rather than
 * hardcoding a table, so new models and changed level sets work without a client
 * update. We do the same, and cache the catalog for the process lifetime.
 *
 * Verified live against the API: `claude-opus-5` exposes
 * output_config.effort ∈ [low, medium, high, xhigh, max] (default high), while
 * `claude-opus-4.6` omits xhigh, `gpt-5.6-*` use reasoning.effort and add `none`,
 * and models like `claude-sonnet-4.5` / `glm-5` advertise no effort at all.
 */

/** Where in the request the model expects its effort level. */
export type EffortSchemaPath = "output_config" | "reasoning"

export type ModelEffort = {
  /** Levels the model accepts, in the order Kiro lists them (weakest first). */
  levels: string[]
  schemaPath: EffortSchemaPath
  /** Level the backend applies when the field is omitted. */
  defaultLevel?: string
}

/** Order matters: the first matching path wins, exactly like kiro-cli. */
const EFFORT_SCHEMA_PATHS: Array<{
  path: EffortSchemaPath
  extract: (schema: Record<string, any>) => Record<string, any> | undefined
}> = [
  { path: "output_config", extract: (s) => s?.properties?.output_config?.properties?.effort },
  { path: "reasoning", extract: (s) => s?.properties?.reasoning?.properties?.effort },
]

type CatalogModel = {
  modelId?: string
  additionalModelRequestFieldsSchema?: unknown
}

type CatalogResponse = {
  models?: CatalogModel[]
  nextToken?: string
}

/** Pagination cap, matching kiro-cli's own guard against a runaway nextToken loop. */
const MAX_PAGES = 10

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Pull the effort levels + request field out of a model's advertised JSON Schema. */
export function parseEffortLevels(schema: unknown): ModelEffort | undefined {
  if (!isRecord(schema)) return undefined
  for (const { path, extract } of EFFORT_SCHEMA_PATHS) {
    const field = extract(schema)
    if (isRecord(field) && Array.isArray(field.enum) && field.enum.length > 0) {
      return {
        levels: field.enum.filter((l: unknown): l is string => typeof l === "string"),
        schemaPath: path,
        defaultLevel: typeof field.default === "string" ? field.default : undefined,
      }
    }
  }
  return undefined
}

let catalogPromise: Promise<Map<string, ModelEffort>> | null = null

async function fetchPage(
  accessToken: string,
  profileArn: string,
  nextToken?: string,
): Promise<CatalogResponse> {
  const body: Record<string, unknown> = { origin: "KIRO_CLI", profileArn }
  if (nextToken) body.nextToken = nextToken

  const res = await fetch(`${KIRO_MANAGEMENT_ENDPOINT}?origin=KIRO_CLI`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": KIRO_CONTENT_TYPE,
      "x-amz-target": KIRO_LIST_MODELS_TARGET,
      "user-agent": KIRO_MGMT_USER_AGENT,
      "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
      "x-amzn-codewhisperer-optout": "false",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`ListAvailableModels failed (${res.status})`)
  return (await res.json()) as CatalogResponse
}

async function loadCatalog(accessToken: string, profileArn: string): Promise<Map<string, ModelEffort>> {
  const out = new Map<string, ModelEffort>()
  let nextToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(accessToken, profileArn, nextToken)
    for (const model of data.models ?? []) {
      if (!model.modelId) continue
      const effort = parseEffortLevels(model.additionalModelRequestFieldsSchema)
      if (effort) out.set(model.modelId, effort)
    }
    nextToken = data.nextToken
    if (!nextToken) break
  }
  return out
}

/**
 * Effort capabilities for `modelId`, or undefined when the model advertises none
 * (or the catalog is unreachable). Cached for the process lifetime; a failed load
 * degrades to "no effort support", which means we simply omit the field and let
 * Kiro apply its own default — never a hard error on the chat path.
 */
export async function getModelEffort(
  accessToken: string,
  profileArn: string,
  modelId: string,
): Promise<ModelEffort | undefined> {
  if (!catalogPromise) {
    catalogPromise = loadCatalog(accessToken, profileArn).catch(() => new Map<string, ModelEffort>())
  }
  return (await catalogPromise).get(modelId)
}

/**
 * Pick the level to send for a requested one.
 *
 * opencode's variant list is static config, so it can ask for a level a given
 * model doesn't have (e.g. `xhigh` on claude-opus-4.6, whose enum stops at
 * `high`/`max`). Rather than let Kiro reject the request, clamp to the closest
 * supported level at or below the request, using Kiro's own ordering. If the
 * requested level is below everything on offer, take the weakest level available.
 */
export function resolveEffortLevel(effort: ModelEffort, requested: string): string | undefined {
  if (effort.levels.includes(requested)) return requested
  if (effort.levels.length === 0) return undefined

  // Rank against the union so unknown names still land somewhere sensible.
  const KNOWN_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  const rank = (level: string) => KNOWN_ORDER.indexOf(level)
  const wanted = rank(requested)
  if (wanted === -1) return undefined

  const ranked = effort.levels
    .map((level) => ({ level, rank: rank(level) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank)
  if (ranked.length === 0) return undefined

  let best = ranked[0]!.level
  for (const entry of ranked) {
    if (entry.rank <= wanted) best = entry.level
    else break
  }
  return best
}

/**
 * Build the `additionalModelRequestFields` payload for a level, mirroring
 * kiro-cli's `buildEffortRequestFields`. The Claude path ships the adaptive
 * `thinking` block alongside `output_config`, exactly as kiro-cli does.
 */
export function buildEffortRequestFields(
  level: string,
  schemaPath: EffortSchemaPath,
): Record<string, unknown> {
  switch (schemaPath) {
    case "output_config":
      return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: level } }
    case "reasoning":
      return { reasoning: { effort: level } }
  }
}

import {
  KIRO_MANAGEMENT_ENDPOINT,
  KIRO_LIST_MODELS_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_MGMT_USER_AGENT,
  DEFAULT_MODEL,
} from "./constants"

/**
 * Model inventory and per-model reasoning capabilities, read from Kiro's own
 * ListAvailableModels catalog. Keeping one normalized catalog here means the
 * picker and request transformer always use the same source of truth.
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
 * update. The config hook also maps the catalog into OpenCode's provider models.
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

export type CatalogModel = {
  modelId?: string
  modelName?: string
  description?: string
  tokenLimits?: {
    maxInputTokens?: number
    maxOutputTokens?: number
  }
  supportedInputTypes?: string[]
  additionalModelRequestFieldsSchema?: unknown
}

type CatalogResponse = {
  models?: CatalogModel[]
  nextToken?: string
  defaultModel?: string
}

export type KiroModelCatalog = {
  models: CatalogModel[]
  defaultModel?: string
}

type ModelModality = "text" | "audio" | "image" | "video" | "pdf"

export type ProviderModelConfig = {
  id?: string
  name: string
  limit: { context: number; output: number }
  modalities: { input: ModelModality[]; output: ModelModality[] }
  reasoning?: boolean
  attachment?: boolean
  temperature?: boolean
  tool_call?: boolean
  experimental?: boolean
  variants?: Record<string, { effort: string }>
  options?: Record<string, unknown>
  headers?: Record<string, string>
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

const CATALOG_CACHE_MS = 5 * 60 * 1000
const catalogCache = new Map<string, { expiresAt: number; value: KiroModelCatalog }>()
const catalogInflight = new Map<string, Promise<KiroModelCatalog>>()

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
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ListAvailableModels failed (${res.status})`)
  return (await res.json()) as CatalogResponse
}

async function loadCatalog(accessToken: string, profileArn: string): Promise<KiroModelCatalog> {
  const models = new Map<string, CatalogModel>()
  let nextToken: string | undefined
  let defaultModel: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(accessToken, profileArn, nextToken)
    for (const model of data.models ?? []) {
      if (!model.modelId) continue
      models.set(model.modelId, model)
    }
    defaultModel ??= data.defaultModel
    nextToken = data.nextToken
    if (!nextToken) break
  }
  if (models.size === 0) throw new Error("ListAvailableModels returned no models")
  return { models: [...models.values()], defaultModel }
}

/**
 * Read the current Kiro model catalog, sharing an in-flight request and caching
 * successful results briefly. Failed requests are not cached, so a later call can
 * recover after login/network state changes.
 */
export async function getAvailableModels(
  accessToken: string,
  profileArn: string,
): Promise<KiroModelCatalog> {
  const cached = catalogCache.get(profileArn)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let pending = catalogInflight.get(profileArn)
  if (!pending) {
    pending = loadCatalog(accessToken, profileArn).then((value) => {
      catalogCache.set(profileArn, { value, expiresAt: Date.now() + CATALOG_CACHE_MS })
      return value
    })
    catalogInflight.set(profileArn, pending)
    void pending.finally(() => {
      if (catalogInflight.get(profileArn) === pending) catalogInflight.delete(profileArn)
    }).catch(() => {})
  }
  return pending
}

/** Current default model from Kiro, falling back to its known `auto` default. */
export async function getDefaultModel(accessToken: string, profileArn: string): Promise<string> {
  try {
    return (await getAvailableModels(accessToken, profileArn)).defaultModel || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

function positiveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^[a-z]/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ")
}

/** Kiro model IDs are lowercase; use stable readable names in OpenCode's picker. */
function displayName(modelId: string): string {
  if (modelId === "auto") return "Auto"

  const claude = modelId.match(/^claude-(opus|sonnet|haiku)-(.+)$/i)
  if (claude) {
    const family = claude[1]![0]!.toUpperCase() + claude[1]!.slice(1)
    return `Claude ${family} ${claude[2]}`
  }

  const gpt = modelId.match(/^gpt-(.+)$/i)
  if (gpt) return `GPT ${titleCase(gpt[1]!)}`

  const deepseek = modelId.match(/^deepseek-(.+)$/i)
  if (deepseek) return `DeepSeek ${titleCase(deepseek[1]!)}`

  const minimax = modelId.match(/^minimax-(.+)$/i)
  if (minimax) return `MiniMax ${titleCase(minimax[1]!)}`

  const glm = modelId.match(/^glm-(.+)$/i)
  if (glm) return `GLM-${glm[1]}`

  const qwen = modelId.match(/^qwen3-(.+)$/i)
  if (qwen) return `Qwen3 ${titleCase(qwen[1]!)}`

  return titleCase(modelId)
}

const INPUT_MODALITIES: Record<string, ModelModality> = {
  TEXT: "text",
  AUDIO: "audio",
  IMAGE: "image",
  VIDEO: "video",
  PDF: "pdf",
}

/** Convert Kiro's live catalog record to OpenCode's legacy provider config shape. */
export function toProviderModels(models: CatalogModel[]): Record<string, ProviderModelConfig> {
  const out: Record<string, ProviderModelConfig> = {}
  for (const model of models) {
    const id = model.modelId
    if (!id) continue

    const effort = parseEffortLevels(model.additionalModelRequestFieldsSchema)
    const input = [...new Set(
      (model.supportedInputTypes ?? ["TEXT"])
        .map((type) => INPUT_MODALITIES[type.toUpperCase()])
        .filter((type): type is ModelModality => type !== undefined),
    )]
    if (!input.includes("text")) input.unshift("text")

    out[id] = {
      name: displayName(id),
      limit: {
        context: positiveLimit(model.tokenLimits?.maxInputTokens, 200_000),
        output: positiveLimit(model.tokenLimits?.maxOutputTokens, 64_000),
      },
      modalities: { input, output: ["text"] },
      reasoning: Boolean(effort),
      attachment: input.includes("image"),
      temperature: false,
      tool_call: true,
      ...(model.description?.toLowerCase().includes("experimental preview")
        ? { experimental: true }
        : {}),
      ...(effort
        ? { variants: Object.fromEntries(effort.levels.map((level) => [level, { effort: level }])) }
        : {}),
    }
  }
  return out
}

/**
 * Effort capabilities for `modelId`, or undefined when the model advertises none
 * (or the catalog is unreachable). The shared catalog cache expires after five
 * minutes; a failed load degrades to "no effort support", so we omit the field and
 * let Kiro apply its own default — never a hard error on the chat path.
 */
export async function getModelEffort(
  accessToken: string,
  profileArn: string,
  modelId: string,
): Promise<ModelEffort | undefined> {
  try {
    const catalog = await getAvailableModels(accessToken, profileArn)
    const model = catalog.models.find((entry) => entry.modelId === modelId)
    return model ? parseEffortLevels(model.additionalModelRequestFieldsSchema) : undefined
  } catch {
    return undefined
  }
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

/**
 * Kiro model metadata registry.
 *
 * Populated from the Kiro ListAvailableModels API response at startup
 * and on account switch. Provides per-model token limits, supported
 * input types, and prompt caching configuration.
 */

import { DEFAULT_MAX_INPUT_TOKENS } from "./constants"
import { staticKiroEffortDescriptor } from "./static-models"

export interface KiroModelMetadata {
  modelId: string
  modelName: string
  description: string
  maxInputTokens: number
  maxOutputTokens: number
  supportedInputTypes: string[]
  supportsImages: boolean
  promptCaching: {
    supportsPromptCaching: boolean
    minimumTokensPerCacheCheckpoint: number | null
    maximumCacheCheckpointsPerRequest: number | null
  }
  rateMultiplier: number
  rateUnit: string
  effort?: KiroModelEffortMetadata
  /** Whether the live entry answered the question "which additional request fields do you take?". */
  effortSchemaDisclosure: KiroEffortSchemaDisclosure
  richMetadata: boolean
}

export type KiroEffortSchemaPath = "output_config" | "reasoning"

/**
 * Whether the live catalog entry said anything at all about `additionalModelRequestFields`.
 *
 * The distinction exists for exactly one decision — may the bundled static catalog fill an effort
 * gap for this model? — and it is the difference between "I have no information" and "there are no
 * additional request fields":
 *
 * - `silent` — the entry carries **no** `additionalModelRequestFieldsSchema` key (or carries it as
 *   `undefined`). The endpoint said nothing, so a bundled descriptor is filling a hole in our
 *   knowledge, which is what a fallback is for.
 * - `answered` — the key is **present**. Measured on 2026-09-03, the live entry for
 *   `claude-sonnet-4.5` reads `additionalModelRequestFieldsSchema: null`: the key is there with an
 *   explicit `null`. That is the endpoint stating it takes no additional request fields, not the
 *   endpoint failing to tell us — nine other entries in the same response publish a real effort
 *   enum at the two paths `parseEffortMetadata()` reads, so the API is perfectly capable of saying
 *   so when it is true. A present-but-null schema is therefore a **denial**.
 *
 * A present schema object that simply contains no effort enum is `answered` too, and so is a
 * present value of any other shape. The reason is the asymmetry of the two mistakes: sending a
 * field the endpoint has denied costs the user a `400 REQUEST_BODY_INVALID`
 * (`additionalModelRequestFields.output_config is not supported for this model`, measured on this
 * exact model), while withholding a field we were merely unsure about costs a notice and still
 * returns 200. So whenever the endpoint answered, its answer stands.
 */
export type KiroEffortSchemaDisclosure = "silent" | "answered"

/**
 * Where an effort descriptor came from.
 *
 * - `live` — parsed from this account's `ListAvailableModels` response. A measurement.
 * - `static` — read from the bundled `kiro-models.json` because the live entry published no effort
 *   vocabulary for the model. A shipped assumption, not a measurement.
 *
 * Carried because the two are different claims, and the capability layer of this feature exists to
 * stop the gateway from asserting things it did not measure: a client comparing two descriptors is
 * entitled to know which one the endpoint actually said.
 *
 * Optional in the type, and always set on descriptors the registry produces. Absent means the
 * descriptor was hand-built (a test arbitrary, a caller assembling one by hand) and makes no
 * provenance claim at all.
 */
export type KiroEffortProvenance = "live" | "static"

export interface KiroModelEffortMetadata {
  schemaPath: KiroEffortSchemaPath
  levels: string[]
  defaultLevel?: string
  provenance?: KiroEffortProvenance
}

/**
 * Registry that caches parsed Kiro model metadata for the current session.
 */
export class KiroModelMetadataRegistry {
  private models = new Map<string, KiroModelMetadata>()
  private defaultModel?: KiroModelMetadata
  private populatedAt?: number

  /** Whether the registry has been populated with data from the API. */
  get isPopulated(): boolean {
    return this.populatedAt !== undefined
  }

  /** Timestamp of last population. */
  get lastPopulatedAt(): number | undefined {
    return this.populatedAt
  }

  /**
   * Populate the registry from a raw Kiro ListAvailableModels response body.
   */
  populate(responseBody: unknown): void {
    this.models.clear()
    this.defaultModel = undefined

    if (!responseBody || typeof responseBody !== "object") return
    const body = responseBody as { models?: unknown; defaultModel?: unknown }

    if (body.defaultModel && typeof body.defaultModel === "object") {
      this.defaultModel = parseModelEntry(body.defaultModel)
    }

    if (Array.isArray(body.models)) {
      for (const raw of body.models) {
        // Handle both object entries (rich metadata) and string entries (ID only)
        if (typeof raw === "string") {
          this.models.set(raw, createMinimalEntry(raw))
          continue
        }
        const entry = parseModelEntry(raw)
        if (entry) this.models.set(entry.modelId, entry)
      }
    }

    // Also handle modelIds array format (older API responses)
    const modelIds = (responseBody as { modelIds?: unknown }).modelIds
    if (Array.isArray(modelIds)) {
      for (const raw of modelIds) {
        if (typeof raw === "string" && !this.models.has(raw)) {
          this.models.set(raw, createMinimalEntry(raw))
        }
      }
    }

    this.fillEffortGapsFromStaticCatalog()

    this.populatedAt = Date.now()
  }

  /**
   * Give an effort descriptor to every model the live response was **silent** about.
   *
   * Runs after the whole response has been parsed, and only ever **adds**: a model whose live entry
   * published an effort enum keeps it untouched, including its `schemaPath` and its `defaultLevel`.
   * Live wins where it exists; the static file fills gaps. A model absent from the static file keeps
   * today's behaviour exactly — no `effort` key, so `validateKiroEffort()` still reaches
   * `effort_unsupported` for it.
   *
   * ## A gap is not the same thing as a denial
   *
   * The fallback fills a gap only where `effortSchemaDisclosure` is `silent`. Where the live entry
   * **answered** — the `additionalModelRequestFieldsSchema` key present, `null` included — the
   * absence of an effort enum is the endpoint's own statement and nothing may override it, however
   * confidently `kiro-models.json` disagrees.
   *
   * This narrowing is a fix, not a caution. Filling on a present-but-null schema made the gateway
   * send `additionalModelRequestFields.output_config` to `claude-sonnet-4.5`, and that model answers
   * `400 REQUEST_BODY_INVALID` / `additionalModelRequestFields.output_config is not supported for
   * this model` — measured, and measured to be a rejection of the **field**, not of the value: two
   * requests carrying `xhigh` and `high` came back with byte-identical message lengths, so no effort
   * value reaches 200 on that model. Two requests that previously returned 200 returned 400. The
   * whole point of this capability layer is to stop the gateway asserting things the endpoint did not
   * say, and a bundled file that contradicts a live denial is the loudest possible version of that
   * mistake. Withholding a field instead degrades to a notice plus a 200, so the two errors are not
   * symmetric and silence is the safe direction.
   *
   * Deliberately not scoped to `richMetadata` entries: a string-only entry is still a model the
   * account can call, there is no reason to know less about it than about its neighbour, and such an
   * entry carries no schema information at all, so it is `silent` by construction rather than by
   * assumption.
   */
  private fillEffortGapsFromStaticCatalog(): void {
    for (const [modelId, entry] of this.models) {
      if (entry.effort || entry.effortSchemaDisclosure === "answered") continue
      const fallback = staticKiroEffortDescriptor(modelId)
      if (fallback) this.models.set(modelId, { ...entry, effort: fallback })
    }
    if (this.defaultModel && !this.defaultModel.effort && this.defaultModel.effortSchemaDisclosure === "silent") {
      const fallback = staticKiroEffortDescriptor(this.defaultModel.modelId)
      if (fallback) this.defaultModel = { ...this.defaultModel, effort: fallback }
    }
  }

  /** Clear all cached metadata. */
  clear(): void {
    this.models.clear()
    this.defaultModel = undefined
    this.populatedAt = undefined
  }

  /** Get metadata for a specific model ID. */
  get(modelId: string): KiroModelMetadata | undefined {
    return this.models.get(modelId)
  }

  /** Get the default model metadata. */
  getDefault(): KiroModelMetadata | undefined {
    return this.defaultModel
  }

  /** Get all model IDs. */
  modelIds(): string[] {
    return [...this.models.keys()]
  }

  /** Get all model metadata entries. */
  all(): KiroModelMetadata[] {
    return [...this.models.values()]
  }

  /**
   * Get maxInputTokens for a model, falling back to default model,
   * then to the hardcoded DEFAULT_MAX_INPUT_TOKENS.
   */
  maxInputTokens(modelId: string): number {
    return this.get(modelId)?.maxInputTokens
      ?? this.defaultModel?.maxInputTokens
      ?? DEFAULT_MAX_INPUT_TOKENS
  }

  /**
   * Check if a model supports image input.
   * Returns true if unknown (conservative — don't block images for unrecognized models).
   */
  supportsImages(modelId: string): boolean {
    const meta = this.get(modelId)
    if (!meta) return true // unknown model — assume it supports images
    return meta.supportsImages
  }

  /**
   * Check if a model supports prompt caching.
   */
  supportsPromptCaching(modelId: string): boolean {
    return this.get(modelId)?.promptCaching.supportsPromptCaching ?? false
  }
}

function createMinimalEntry(modelId: string): KiroModelMetadata {
  return {
    modelId,
    modelName: modelId,
    description: "",
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: 64_000,
    supportedInputTypes: [],
    supportsImages: true,
    promptCaching: { supportsPromptCaching: false, minimumTokensPerCacheCheckpoint: null, maximumCacheCheckpointsPerRequest: null },
    rateMultiplier: 1.0,
    rateUnit: "Credit",
    // A string entry carries no schema information at all, so the endpoint has said nothing about
    // this model's additional request fields — a gap the static catalog may fill, not a denial.
    effortSchemaDisclosure: "silent",
    richMetadata: false,
  }
}

function parseModelEntry(raw: unknown): KiroModelMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const entry = raw as Record<string, unknown>

  const modelId = typeof entry.modelId === "string" ? entry.modelId : undefined
  if (!modelId) return undefined

  const tokenLimits = entry.tokenLimits && typeof entry.tokenLimits === "object"
    ? entry.tokenLimits as Record<string, unknown>
    : {}
  const promptCaching = entry.promptCaching && typeof entry.promptCaching === "object"
    ? entry.promptCaching as Record<string, unknown>
    : {}
  const supportedInputTypes = Array.isArray(entry.supportedInputTypes)
    ? entry.supportedInputTypes.filter((t): t is string => typeof t === "string")
    : []
  const effort = parseEffortMetadata(entry.additionalModelRequestFieldsSchema)

  return {
    modelId,
    modelName: typeof entry.modelName === "string" ? entry.modelName : modelId,
    description: typeof entry.description === "string" ? entry.description : "",
    maxInputTokens: typeof tokenLimits.maxInputTokens === "number" ? tokenLimits.maxInputTokens : DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: typeof tokenLimits.maxOutputTokens === "number" ? tokenLimits.maxOutputTokens : 64_000,
    supportedInputTypes,
    supportsImages: supportedInputTypes.length === 0 || supportedInputTypes.includes("IMAGE"),
    promptCaching: {
      supportsPromptCaching: typeof promptCaching.supportsPromptCaching === "boolean" ? promptCaching.supportsPromptCaching : false,
      minimumTokensPerCacheCheckpoint: typeof promptCaching.minimumTokensPerCacheCheckpoint === "number" ? promptCaching.minimumTokensPerCacheCheckpoint : null,
      maximumCacheCheckpointsPerRequest: typeof promptCaching.maximumCacheCheckpointsPerRequest === "number" ? promptCaching.maximumCacheCheckpointsPerRequest : null,
    },
    rateMultiplier: typeof entry.rateMultiplier === "number" ? entry.rateMultiplier : 1.0,
    rateUnit: typeof entry.rateUnit === "string" ? entry.rateUnit : "Credit",
    ...(effort ? { effort } : {}),
    effortSchemaDisclosure: effortSchemaDisclosure(entry),
    richMetadata: true,
  }
}

/**
 * Did this live entry answer the question of which additional request fields the model takes?
 *
 * `in` rather than a truthiness or `!= null` test, because the whole distinction lives in the
 * difference between an absent key and a key holding `null` — see {@link KiroEffortSchemaDisclosure}.
 * An explicit `undefined` is read as silence: it is indistinguishable from an absent key once the
 * body has been through `JSON.stringify`/`parse`, so treating the two differently would make the
 * verdict depend on how the body reached us.
 */
function effortSchemaDisclosure(entry: Record<string, unknown>): KiroEffortSchemaDisclosure {
  if (!("additionalModelRequestFieldsSchema" in entry)) return "silent"
  return entry.additionalModelRequestFieldsSchema === undefined ? "silent" : "answered"
}

function parseEffortMetadata(schema: unknown): KiroModelEffortMetadata | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined
  const properties = objectProperty(schema, "properties")
  if (!properties) return undefined

  for (const schemaPath of ["output_config", "reasoning"] as const) {
    const section = objectProperty(properties, schemaPath)
    const sectionProperties = section ? objectProperty(section, "properties") : undefined
    const effort = sectionProperties ? objectProperty(sectionProperties, "effort") : undefined
    const levels = effort && Array.isArray(effort.enum)
      ? effort.enum.filter((level): level is string => typeof level === "string")
      : []
    if (!levels.length) continue
    const defaultLevel = typeof effort?.default === "string" && levels.includes(effort.default) ? effort.default : undefined
    return {
      schemaPath,
      levels,
      ...(defaultLevel ? { defaultLevel } : {}),
      // Measured from this account's endpoint response, so it outranks anything the bundled
      // descriptor file says about the same model.
      provenance: "live",
    }
  }

  return undefined
}

function objectProperty(value: object, key: string): Record<string, unknown> | undefined {
  const property = (value as Record<string, unknown>)[key]
  return property && typeof property === "object" && !Array.isArray(property) ? property as Record<string, unknown> : undefined
}

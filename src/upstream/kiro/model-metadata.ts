/**
 * Kiro model metadata registry.
 *
 * Populated from the Kiro ListAvailableModels API response at startup
 * and on account switch. Provides per-model token limits, supported
 * input types, and prompt caching configuration.
 */

import { DEFAULT_MAX_INPUT_TOKENS } from "./constants"

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

    this.populatedAt = Date.now()
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
  }
}

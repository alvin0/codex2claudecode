/**
 * Codex model metadata registry.
 *
 * Populated from the Codex /backend-api/models response at startup
 * and on account switch. Provides per-model token limits, reasoning
 * capabilities, supported input types, and thinking effort levels.
 */

export interface CodexModelMetadata {
  slug: string
  title: string
  description: string
  maxTokens: number
  reasoningType: "auto" | "none" | "reasoning" | "pro" | string
  configurableThinkingEffort: boolean
  thinkingEfforts: CodexThinkingEffort[]
  supportedImageTypes: string[]
  supportedDocumentTypes: string[]
  supportsImages: boolean
  supportsPdf: boolean
  enabledTools: string[]
  tags: string[]
}

export interface CodexThinkingEffort {
  thinkingEffort: string
  fullLabel: string
  shortLabel: string
  description: string
}

/**
 * Registry that caches parsed Codex model metadata for the current session.
 */
export class CodexModelMetadataRegistry {
  private models = new Map<string, CodexModelMetadata>()
  private defaultModelSlug?: string
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
   * Populate the registry from a raw Codex /backend-api/models response body.
   */
  populate(responseBody: unknown): void {
    this.models.clear()
    this.defaultModelSlug = undefined

    if (!responseBody || typeof responseBody !== "object") return
    const body = responseBody as Record<string, unknown>

    if (typeof body.default_model_slug === "string") {
      this.defaultModelSlug = body.default_model_slug
    }

    if (Array.isArray(body.models)) {
      for (const raw of body.models) {
        const entry = parseCodexModelEntry(raw)
        if (entry) this.models.set(entry.slug, entry)
      }
    }

    this.populatedAt = Date.now()
  }

  /** Clear all cached metadata. */
  clear(): void {
    this.models.clear()
    this.defaultModelSlug = undefined
    this.populatedAt = undefined
  }

  /** Get metadata for a specific model slug. */
  get(slug: string): CodexModelMetadata | undefined {
    return this.models.get(slug)
  }

  /** Get the default model slug. */
  getDefaultSlug(): string | undefined {
    return this.defaultModelSlug
  }

  /** Get all model slugs. */
  modelSlugs(): string[] {
    return [...this.models.keys()]
  }

  /** Get all model metadata entries. */
  all(): CodexModelMetadata[] {
    return [...this.models.values()]
  }

  /**
   * Get maxTokens (context window) for a model.
   * Falls back to 128000 for unknown models.
   */
  maxTokens(slug: string): number {
    return this.get(slug)?.maxTokens ?? 128_000
  }

  /**
   * Check if a model supports image input.
   * Returns true if unknown (conservative).
   */
  supportsImages(slug: string): boolean {
    const meta = this.get(slug)
    if (!meta) return true
    return meta.supportsImages
  }

  /**
   * Check if a model supports PDF input.
   * Returns true if unknown (conservative).
   */
  supportsPdf(slug: string): boolean {
    const meta = this.get(slug)
    if (!meta) return true
    return meta.supportsPdf
  }

  /**
   * Check if a model supports reasoning/thinking.
   */
  supportsReasoning(slug: string): boolean {
    const meta = this.get(slug)
    if (!meta) return false
    return meta.reasoningType === "reasoning" || meta.reasoningType === "pro"
  }

  /**
   * Get available thinking effort levels for a model.
   */
  thinkingEfforts(slug: string): CodexThinkingEffort[] {
    return this.get(slug)?.thinkingEfforts ?? []
  }
}

function parseCodexModelEntry(raw: unknown): CodexModelMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const entry = raw as Record<string, unknown>

  const slug = typeof entry.slug === "string" ? entry.slug : undefined
  if (!slug) return undefined

  const productFeatures = entry.product_features && typeof entry.product_features === "object"
    ? entry.product_features as Record<string, unknown>
    : {}
  const attachments = productFeatures.attachments && typeof productFeatures.attachments === "object"
    ? productFeatures.attachments as Record<string, unknown>
    : {}

  const imageMimeTypes = Array.isArray(attachments.image_mime_types)
    ? attachments.image_mime_types.filter((t): t is string => typeof t === "string")
    : []
  const acceptedMimeTypes = Array.isArray(attachments.accepted_mime_types)
    ? attachments.accepted_mime_types.filter((t): t is string => typeof t === "string")
    : []

  const thinkingEfforts = Array.isArray(entry.thinking_efforts)
    ? entry.thinking_efforts.flatMap((te) => {
        if (!te || typeof te !== "object") return []
        const item = te as Record<string, unknown>
        if (typeof item.thinking_effort !== "string") return []
        return [{
          thinkingEffort: item.thinking_effort,
          fullLabel: typeof item.full_label === "string" ? item.full_label : item.thinking_effort,
          shortLabel: typeof item.short_label === "string" ? item.short_label : item.thinking_effort,
          description: typeof item.description === "string" ? item.description : "",
        }]
      })
    : []

  const enabledTools = Array.isArray(entry.enabled_tools)
    ? entry.enabled_tools.filter((t): t is string => typeof t === "string")
    : []

  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((t): t is string => typeof t === "string")
    : []

  return {
    slug,
    title: typeof entry.title === "string" ? entry.title : slug,
    description: typeof entry.description === "string" ? entry.description : "",
    maxTokens: typeof entry.max_tokens === "number" ? entry.max_tokens : 128_000,
    reasoningType: typeof entry.reasoning_type === "string" ? entry.reasoning_type : "auto",
    configurableThinkingEffort: entry.configurable_thinking_effort === true,
    thinkingEfforts,
    supportedImageTypes: imageMimeTypes,
    supportedDocumentTypes: acceptedMimeTypes.filter((t) => !t.startsWith("image/")),
    supportsImages: imageMimeTypes.length > 0,
    supportsPdf: acceptedMimeTypes.includes("application/pdf"),
    enabledTools,
    tags,
  }
}

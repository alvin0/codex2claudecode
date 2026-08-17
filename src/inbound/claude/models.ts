import { readTextFile } from "../../core/bun-fs"
import type { ProviderModelDescriptor } from "../../core/interfaces"
import { bunPath as path, homeDir } from "../../core/paths"

import kiroModelsConfig from "../../../kiro-models.json"
import modelsConfig from "../../../models.json"

// ---------------------------------------------------------------------------
// Types – Claude Models API format
// Reference: https://platform.claude.com/docs/en/api/models
//
// The proxy returns model information in Claude API format so that Claude Code
// and other Claude API consumers work seamlessly, while the actual upstream
// models are GPT models served by Codex.
//
// All model data is driven by models.json at the project root.
// The /v1/models endpoint reads ~/.claude/settings.json to determine which
// models the user has actually configured, and only returns those.
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  capabilities: ModelCapabilities
  created_at: string
  display_name: string
  max_input_tokens: number
  max_tokens: number
  type: "model"
}

export interface ListModelsResponse {
  data: ModelInfo[]
  first_id: string | null
  has_more: boolean
  last_id: string | null
}

interface JsonModelEntry {
  id: string
  display_name: string
  created_at: string
  max_input_tokens: number
  max_tokens: number
  capabilities: JsonModelCapabilities
}

interface JsonModelCatalog {
  aliases?: Record<string, string>
  models: JsonModelEntry[]
}

export interface CapabilitySupport {
  supported: boolean
}

export interface ThinkingTypes {
  adaptive: CapabilitySupport
  enabled: CapabilitySupport
}

export interface ThinkingCapability extends CapabilitySupport {
  types: ThinkingTypes
}

export interface ContextManagementCapability extends CapabilitySupport {
  clear_thinking_20251015: CapabilitySupport
  clear_tool_uses_20250919: CapabilitySupport
  compact_20260112: CapabilitySupport
}

export interface EffortCapability extends CapabilitySupport {
  high: CapabilitySupport
  low: CapabilitySupport
  max: CapabilitySupport
  medium: CapabilitySupport
  none: CapabilitySupport
  ultra: CapabilitySupport
  xhigh: CapabilitySupport
}

export interface ModelCapabilities {
  batch: CapabilitySupport
  citations: CapabilitySupport
  code_execution: CapabilitySupport
  context_management: ContextManagementCapability
  effort: EffortCapability
  image_input: CapabilitySupport
  pdf_input: CapabilitySupport
  structured_outputs: CapabilitySupport
  thinking: ThinkingCapability
}

/** Flat capability flags as stored in models.json */
interface JsonModelCapabilities {
  batch: boolean
  citations: boolean
  code_execution: boolean
  image_input: boolean
  pdf_input: boolean
  structured_outputs: boolean
  thinking: boolean
  thinking_adaptive: boolean
  effort_low: boolean
  effort_medium: boolean
  effort_high: boolean
  effort_xhigh: boolean
  effort_max: boolean
  effort_ultra?: boolean
  context_management: boolean
}

function expandCapabilities(c: JsonModelCapabilities): ModelCapabilities {
  return {
    batch: { supported: c.batch },
    citations: { supported: c.citations },
    code_execution: { supported: c.code_execution },
    context_management: {
      clear_thinking_20251015: { supported: c.context_management },
      clear_tool_uses_20250919: { supported: c.context_management },
      compact_20260112: { supported: c.context_management },
      supported: c.context_management,
    },
    effort: {
      high: { supported: c.effort_high },
      low: { supported: c.effort_low },
      max: { supported: c.effort_max },
      medium: { supported: c.effort_medium },
      none: { supported: false },
      supported: c.effort_low || c.effort_medium || c.effort_high || c.effort_xhigh || c.effort_max || c.effort_ultra === true,
      ultra: { supported: c.effort_ultra === true },
      xhigh: { supported: c.effort_xhigh },
    },
    image_input: { supported: c.image_input },
    pdf_input: { supported: c.pdf_input },
    structured_outputs: { supported: c.structured_outputs },
    thinking: {
      supported: c.thinking,
      types: {
        adaptive: { supported: c.thinking_adaptive },
        enabled: { supported: c.thinking },
      },
    },
  }
}

const SYNTHETIC_MODEL_CAPABILITIES = expandCapabilities({
  batch: false,
  citations: false,
  code_execution: false,
  image_input: false,
  pdf_input: false,
  structured_outputs: false,
  thinking: true,
  thinking_adaptive: true,
  effort_low: true,
  effort_medium: true,
  effort_high: true,
  effort_xhigh: true,
  effort_max: false,
  context_management: true,
})

// ---------------------------------------------------------------------------
// Build full catalog from JSON (used for lookups)
// ---------------------------------------------------------------------------

function buildModelCatalog(config: JsonModelCatalog): ModelInfo[] {
  return config.models.map((entry) => ({
    id: entry.id,
    capabilities: expandCapabilities(entry.capabilities),
    created_at: entry.created_at,
    display_name: entry.display_name,
    max_input_tokens: entry.max_input_tokens,
    max_tokens: entry.max_tokens,
    type: "model" as const,
  }))
}

const CODEX_MODEL_CATALOG = buildModelCatalog(modelsConfig as JsonModelCatalog)
const KIRO_MODEL_CATALOG = buildModelCatalog(kiroModelsConfig as JsonModelCatalog)
const MODEL_CATALOG: ModelInfo[] = [...CODEX_MODEL_CATALOG, ...KIRO_MODEL_CATALOG]

const MODEL_ALIASES: Record<string, string> = {
  ...((modelsConfig as JsonModelCatalog).aliases ?? {}),
  ...((kiroModelsConfig as JsonModelCatalog).aliases ?? {}),
}

// Build a lookup map for O(1) access
const MODEL_MAP = new Map<string, ModelInfo>()
for (const model of MODEL_CATALOG) {
  MODEL_MAP.set(model.id, model)
}

// ---------------------------------------------------------------------------
// Client defaults (consumed by claude-code-env.config.ts)
// ---------------------------------------------------------------------------

export const MODEL_CLIENT_DEFAULTS = modelsConfig.clientDefaults as {
  ANTHROPIC_MODEL: string
  ANTHROPIC_DEFAULT_OPUS_MODEL: string
  ANTHROPIC_DEFAULT_SONNET_MODEL: string
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string
}

/** The env keys in ~/.claude/settings.json that hold model IDs */
const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const

// ---------------------------------------------------------------------------
// Read active models from ~/.claude/settings.json
// ---------------------------------------------------------------------------

function resolveModelId(raw: string): string {
  return MODEL_ALIASES[raw] ?? raw
}

/**
 * Reads ~/.claude/settings.json and extracts the unique model IDs that the
 * user has configured via ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL env
 * vars. Falls back to clientDefaults from models.json when the file is
 * missing or a key is not set.
 */
async function readActiveModelIds(): Promise<string[]> {
  let envMap: Record<string, unknown> = {}
  try {
    const settingsPath = path.join(homeDir(), ".claude", "settings.json")
    const parsed = JSON.parse(await readTextFile(settingsPath)) as { env?: Record<string, unknown> }
    if (parsed.env && typeof parsed.env === "object") {
      envMap = parsed.env
    }
  } catch {
    // File missing or unreadable — use defaults only
  }

  const defaults = MODEL_CLIENT_DEFAULTS as Record<string, string>
  const seen = new Set<string>()
  const ids: string[] = []

  for (const key of MODEL_ENV_KEYS) {
    const raw = typeof envMap[key] === "string" ? (envMap[key] as string) : defaults[key]
    if (!raw) continue
    const resolved = resolveModelId(raw)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      ids.push(resolved)
    }
  }

  return ids
}

export type ModelResolverEntry = string | ProviderModelDescriptor

export interface ModelResolverFn {
  (): Promise<ModelResolverEntry[]>
}

export class Model_Catalog {
  private readonly catalog = MODEL_CATALOG
  private readonly aliases = MODEL_ALIASES
  private readonly modelMap = MODEL_MAP
  private readonly resolvedModelMap = new Map<string, ModelInfo>()

  getModel(modelId: string): ModelInfo | undefined {
    const resolvedId = this.resolveAlias(modelId)
    return this.resolvedModelMap.get(resolvedId) ?? this.modelMap.get(resolvedId)
  }

  async resolveModel(modelId: string, resolver?: ModelResolverFn): Promise<ModelInfo | undefined> {
    if (resolver) this.rememberResolvedModels(resolveModelInfos(await resolver()))
    return this.getModel(modelId)
  }

  resolveAlias(raw: string): string {
    return this.aliases[raw] ?? raw
  }

  async listModels(
    resolver?: ModelResolverFn,
    pagination?: { afterId?: string; beforeId?: string; limit?: number },
  ): Promise<ListModelsResponse> {
    const afterId = pagination?.afterId
    const beforeId = pagination?.beforeId
    const limit = Math.min(Math.max(1, pagination?.limit ?? 20), 1000)

    let data = resolver ? resolveModelInfos(await resolver()) : [...this.catalog]
    if (resolver) this.rememberResolvedModels(data)

    if (afterId) {
      const idx = data.findIndex((m) => m.id === afterId)
      if (idx >= 0) data = data.slice(idx + 1)
    } else if (beforeId) {
      const idx = data.findIndex((m) => m.id === beforeId)
      if (idx >= 0) {
        data = data.slice(0, idx)
        if (data.length > limit) data = data.slice(data.length - limit)
      }
    }

    const hasMore = data.length > limit
    const page = data.slice(0, limit)
    return {
      data: page,
      first_id: page.length > 0 ? page[0].id : null,
      has_more: hasMore,
      last_id: page.length > 0 ? page[page.length - 1].id : null,
    }
  }

  private rememberResolvedModels(models: ModelInfo[]) {
    for (const model of models) this.resolvedModelMap.set(model.id, model)
  }
}

export async function claudeSettingsModelResolver(): Promise<string[]> {
  return readActiveModelIds()
}

/**
 * Look up ModelInfo entries for a list of IDs. Unknown IDs are returned as
 * a minimal synthetic entry so the user can still see what is configured
 * even if the model is not in models.json.
 */
function resolveModelInfos(entries: ModelResolverEntry[]): ModelInfo[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return resolveProviderModelDescriptor(entry)
    const known = MODEL_MAP.get(resolveModelId(entry))
    if (known) return known
    // Synthetic entry for models not in catalog (user set a custom model)
    return {
      id: entry,
      capabilities: SYNTHETIC_MODEL_CAPABILITIES,
      created_at: "1970-01-01T00:00:00Z",
      display_name: displayNameFromModelId(entry),
      max_input_tokens: 0,
      max_tokens: 0,
      type: "model" as const,
    }
  })
}

function resolveProviderModelDescriptor(descriptor: ProviderModelDescriptor): ModelInfo {
  const known = MODEL_MAP.get(resolveModelId(descriptor.id))
  const baseCapabilities = known?.capabilities ?? SYNTHETIC_MODEL_CAPABILITIES
  return {
    id: descriptor.id,
    capabilities: {
      ...baseCapabilities,
      effort: effortCapabilities(descriptor.effort?.levels ?? []),
      image_input: { supported: descriptor.supportsImages ?? baseCapabilities.image_input.supported },
    },
    created_at: known?.created_at ?? "1970-01-01T00:00:00Z",
    display_name: descriptor.displayName ?? known?.display_name ?? displayNameFromModelId(descriptor.id),
    max_input_tokens: descriptor.maxInputTokens ?? known?.max_input_tokens ?? 0,
    max_tokens: descriptor.maxOutputTokens ?? known?.max_tokens ?? 0,
    type: "model",
  }
}

function effortCapabilities(levels: string[]): EffortCapability {
  const supported = new Set(levels)
  return {
    high: { supported: supported.has("high") },
    low: { supported: supported.has("low") },
    max: { supported: supported.has("max") },
    medium: { supported: supported.has("medium") },
    none: { supported: supported.has("none") },
    supported: supported.size > 0,
    ultra: { supported: supported.has("ultra") },
    xhigh: { supported: supported.has("xhigh") },
  }
}

function displayNameFromModelId(id: string) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "gpt") return "GPT"
      if (lower === "glm") return "GLM"
      if (lower === "ai") return "AI"
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/models
 *
 * Reads ~/.claude/settings.json env vars to determine which models the user
 * has configured, then returns only those models from the catalog.
 *
 * Query params (matching Claude API):
 *   after_id  – cursor for forward pagination
 *   before_id – cursor for backward pagination
 *   limit     – items per page (default 20, max 1000)
 */
export async function handleListModels(url: URL): Promise<Response> {
  return Response.json(await new Model_Catalog().listModels(claudeSettingsModelResolver, {
    afterId: url.searchParams.get("after_id") ?? undefined,
    beforeId: url.searchParams.get("before_id") ?? undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  }))
}

/**
 * GET /v1/models/:model_id
 *
 * Looks up any model in the full catalog (not limited to active models).
 * Resolves aliases (e.g. "gpt-5.4-latest" → "gpt-5.4").
 */
export function handleGetModel(modelId: string): Response {
  const model = new Model_Catalog().getModel(modelId)

  if (!model) {
    return Response.json(
      {
        type: "error",
        error: {
          type: "not_found_error",
          message: `Model '${modelId}' not found. Use GET /v1/models to list available models.`,
        },
      },
      { status: 404 },
    )
  }

  return Response.json(model)
}

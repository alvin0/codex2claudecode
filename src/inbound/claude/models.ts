import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

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
  context_management: boolean
}

interface JsonModelEntry {
  id: string
  display_name: string
  created_at: string
  max_input_tokens: number
  max_tokens: number
  capabilities: JsonModelCapabilities
}

// ---------------------------------------------------------------------------
// Transform flat JSON capabilities → nested Claude API capabilities
// ---------------------------------------------------------------------------

function expandCapabilities(c: JsonModelCapabilities): ModelCapabilities {
  return {
    batch: { supported: c.batch },
    citations: { supported: c.citations },
    code_execution: { supported: c.code_execution },
    context_management: {
      supported: c.context_management,
      clear_thinking_20251015: { supported: c.context_management },
      clear_tool_uses_20250919: { supported: c.context_management },
      compact_20260112: { supported: c.context_management },
    },
    effort: {
      supported: c.effort_low || c.effort_medium || c.effort_high || c.effort_xhigh || c.effort_max,
      high: { supported: c.effort_high },
      low: { supported: c.effort_low },
      max: { supported: c.effort_max },
      medium: { supported: c.effort_medium },
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

// ---------------------------------------------------------------------------
// Build full catalog from JSON (used for lookups)
// ---------------------------------------------------------------------------

const MODEL_CATALOG: ModelInfo[] = (modelsConfig.models as JsonModelEntry[]).map((entry) => ({
  id: entry.id,
  capabilities: expandCapabilities(entry.capabilities),
  created_at: entry.created_at,
  display_name: entry.display_name,
  max_input_tokens: entry.max_input_tokens,
  max_tokens: entry.max_tokens,
  type: "model" as const,
}))

const MODEL_ALIASES: Record<string, string> = modelsConfig.aliases as Record<string, string>

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
    const settingsPath = path.join(homedir(), ".claude", "settings.json")
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { env?: Record<string, unknown> }
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

export interface ModelResolverFn {
  (): Promise<string[]>
}

export class Model_Catalog {
  private readonly catalog = MODEL_CATALOG
  private readonly aliases = MODEL_ALIASES
  private readonly modelMap = MODEL_MAP

  getModel(modelId: string): ModelInfo | undefined {
    return this.modelMap.get(this.resolveAlias(modelId))
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
}

export async function claudeSettingsModelResolver(): Promise<string[]> {
  return readActiveModelIds()
}

/**
 * Look up ModelInfo entries for a list of IDs. Unknown IDs are returned as
 * a minimal synthetic entry so the user can still see what is configured
 * even if the model is not in models.json.
 */
function resolveModelInfos(ids: string[]): ModelInfo[] {
  return ids.map((id) => {
    const known = MODEL_MAP.get(id)
    if (known) return known
    // Synthetic entry for models not in catalog (user set a custom model)
    return {
      id,
      capabilities: expandCapabilities({
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
      }),
      created_at: new Date().toISOString(),
      display_name: id,
      max_input_tokens: 0,
      max_tokens: 0,
      type: "model" as const,
    }
  })
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

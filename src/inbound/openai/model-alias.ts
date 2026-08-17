import type { ProviderModelDescriptor } from "../../core/interfaces"
import type { JsonObject } from "../../core/types"

export const CODEX2CLAUDE_MODEL_PREFIX = "codex2claude-"

const EFFORT_SUFFIX = /_(none|low|medium|high|xhigh|max|ultra)$/

export type Codex2ClaudeNaming = "prefixed" | "plain" | "both"

/**
 * How models are named in the catalog Codex reads.
 *
 * Codex binds one provider per session, so every name in that picker reaches the
 * upstream through this gateway — `plain` and `both` only change the labels, they
 * do not give Codex a second route.
 */
export function codex2ClaudeNaming(): Codex2ClaudeNaming {
  const value = process.env.CODEX_MODEL_PREFIX
  if (value === "0") return "plain"
  if (value === "both") return "both"
  return "prefixed"
}

export function codex2ClaudeModelId(model: string, effort?: string) {
  return `${CODEX2CLAUDE_MODEL_PREFIX}${model}${effort ? `_${effort}` : ""}`
}

/** The names one upstream model is listed under. */
function namesFor(model: string): string[] {
  switch (codex2ClaudeNaming()) {
    case "plain": return [model]
    case "both": return [model, codex2ClaudeModelId(model)]
    default: return [codex2ClaudeModelId(model)]
  }
}

/**
 * Codex CLI and the Codex IDE pick a model by name only, so the reasoning effort
 * has to travel inside the model id (`codex2claude-gpt-5.6-sol_xhigh`).
 *
 * Strip the prefix back to the upstream slug and promote the suffix to
 * `reasoning.effort`. The suffix wins over the client's own `reasoning.effort`,
 * which Codex fills in from its global `model_reasoning_effort` setting and would
 * otherwise silently override the model the user picked.
 */
export function resolveCodex2ClaudeModel(body: JsonObject): JsonObject {
  if (typeof body.model !== "string" || !body.model.startsWith(CODEX2CLAUDE_MODEL_PREFIX)) return body

  const model = body.model.slice(CODEX2CLAUDE_MODEL_PREFIX.length)
  const effort = model.match(EFFORT_SUFFIX)?.[1]
  if (!effort) return { ...body, model }

  const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
    ? (body.reasoning as JsonObject)
    : {}

  return {
    ...body,
    model: model.replace(EFFORT_SUFFIX, ""),
    reasoning: { ...reasoning, effort },
  }
}

/**
 * The id a model is listed under. Reasoning effort is not baked into the name:
 * Codex sends its own `reasoning.effort`, so one entry per model is enough.
 */
export function codex2ClaudeModelIds(model: string | ProviderModelDescriptor): string[] {
  return namesFor(typeof model === "string" ? model : model.id)
}

/**
 * Codex asks a provider for its catalog at `GET <base_url>/models?client_version=…`
 * and expects its own `{ models: [{ slug, … }] }` shape — an OpenAI-style
 * `{ object: "list", data: [...] }` is silently ignored and Codex falls back to the
 * catalog bundled in its binary, which is why the picker showed the stock names.
 *
 * When the upstream serves that shape already (Codex), it is passed through with
 * the slugs renamed, so every field Codex relies on survives.
 */
export function codex2ClaudeCatalog(raw: unknown, models: Array<string | ProviderModelDescriptor>): JsonObject {
  const passthrough = renameCatalogSlugs(raw)
  if (passthrough) return passthrough

  const entries = models.flatMap((model) => catalogEntries(model))
  return {
    models: entries,
    ...(entries[0] ? { default_model_slug: entries[0].slug } : {}),
  }
}

function renameCatalogSlugs(raw: unknown): JsonObject | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const body = raw as JsonObject
  if (!Array.isArray(body.models)) return undefined

  const models = body.models.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [entry]
    const model = entry as JsonObject
    if (typeof model.slug !== "string") return [model]
    return namesFor(model.slug).map((slug) => ({ ...model, slug }))
  })

  const defaultSlug = typeof body.default_model_slug === "string" ? namesFor(body.default_model_slug)[0] : undefined

  return {
    ...body,
    models,
    ...(defaultSlug ? { default_model_slug: defaultSlug } : {}),
  }
}

const CODEX2CLAUDE_INSTRUCTIONS = "You are a coding agent running in the Codex CLI, served through codex2claudecode."

/**
 * Codex rejects the whole catalog if one entry fails to deserialize, and it silently
 * falls back to its bundled list. Every field below is required for it to be
 * accepted — `model_messages` in particular, which carries the instructions
 * template Codex uses as the system prompt.
 */
function catalogEntries(model: string | ProviderModelDescriptor): Array<JsonObject & { slug: string }> {
  const descriptor = typeof model === "string" ? { id: model } : model
  return namesFor(descriptor.id).map((slug) => ({ ...catalogEntry(descriptor), slug }))
}

function catalogEntry(descriptor: ProviderModelDescriptor): JsonObject & { slug: string } {
  const levels = descriptor.effort?.levels ?? ["low", "medium", "high"]
  const contextWindow = descriptor.maxInputTokens || 272_000

  return {
    slug: codex2ClaudeModelId(descriptor.id),
    display_name: descriptor.displayName ?? descriptor.id,
    description: `Served through codex2claudecode as ${descriptor.id}`,
    default_reasoning_level: descriptor.effort?.defaultLevel ?? levels[Math.floor(levels.length / 2)] ?? "medium",
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: `${effort} reasoning` })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: {
      instructions_template: CODEX2CLAUDE_INSTRUCTIONS,
      instructions_variables: { personality_default: "", personality_friendly: "", personality_pragmatic: "" },
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
    },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    max_output_tokens: descriptor.maxOutputTokens || 128_000,
    comp_hash: "3000",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: descriptor.supportsImages ? ["text", "image"] : ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: "direct",
  }
}

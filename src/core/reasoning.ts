import type { JsonObject } from "./types"

export function normalizeReasoningBody(body: JsonObject): JsonObject {
  return {
    ...Object.fromEntries(Object.entries(body).filter((entry) => entry[0] !== "reasoning_effort")),
    ...normalizeReasoningModel(body),
  }
}

function normalizeReasoningModel(body: JsonObject): JsonObject {
  if (typeof body.model !== "string") return {}

  const match = body.model.match(/^(gpt-5(?:\.[^_]+)?)(?:_(none|low|medium|high|xhigh|max|ultra))?$/)
  if (!match) return {}

  const [, model, effort = "medium"] = match
  const reasoning = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : {}

  return {
    model,
    reasoning: {
      ...reasoning,
      effort: normalizeReasoningEffort((reasoning as JsonObject).effort ?? body.reasoning_effort ?? effort),
    },
  }
}

function normalizeReasoningEffort(effort: unknown) {
  return effort === "ultra" ? "max" : effort
}

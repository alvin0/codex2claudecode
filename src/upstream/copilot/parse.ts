import type { Canonical_ContentBlock, Canonical_Request, Canonical_Response, Canonical_StreamResponse, Canonical_Usage } from "../../core/canonical"
import { canonicalUsageFromWireUsage } from "../../core/usage"
import type { JsonObject } from "../../core/types"
import { forwardCopilotHostedTools } from "./hosted-tools"
import { copilotSamplingFields } from "./sampling"

/**
 * Build the Responses body this upstream posts.
 *
 * Generation controls come from {@link copilotSamplingFields}, which owns the canonical → Responses
 * spellings (`max_output_tokens`, `temperature`, `top_p`) and the one canonical sub-member with no
 * target here (`stopSequences`). Spread rather than assigned field by field so this function stays
 * ignorant of which controls exist: adding one is an edit to `./sampling.ts` alone.
 */
export function buildCopilotResponsesBody(request: Canonical_Request): JsonObject {
  return {
    model: request.model,
    instructions: request.instructions ?? "You are a helpful assistant.",
    input: canonicalInputToResponsesInput(request.input),
    // Hosted tools keep their own `type` — `forwardCopilotHostedTools()` (`./hosted-tools.ts`) is
    // identity for every type this protocol has, and translates the one it does not: a canonical
    // fetch leaves as a search, reported under `webFetch`.
    ...(request.tools ? { tools: forwardCopilotHostedTools(request.tools) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    ...(request.include ? { include: request.include } : {}),
    ...(request.textFormat ? { text: { format: request.textFormat } } : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...copilotSamplingFields(request.sampling),
    stream: false,
    store: false,
  }
}

export async function collectCopilotResponse(response: Response, fallbackModel = "unknown"): Promise<Canonical_Response> {
  const body = await response.json().catch(() => undefined) as JsonObject | undefined
  return responseBodyToCanonicalResponse(body, fallbackModel, response.status)
}

export function streamCopilotResponse(response: Canonical_Response): Canonical_StreamResponse {
  return {
    type: "canonical_stream",
    status: 200,
    id: response.id,
    model: response.model,
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", id: response.id, model: response.model }
        let index = 0
        for (const block of response.content) {
          if (block.type === "text") {
            if (block.text) yield { type: "text_delta", delta: block.text }
          } else if (block.type === "tool_call") {
            yield { type: "tool_call_done", callId: block.callId, name: block.name, arguments: block.arguments }
          } else if (block.type === "thinking") {
            yield { type: "thinking_signature", signature: block.signature }
            yield { type: "thinking_delta", text: block.thinking }
          } else if (block.type === "server_tool") {
            yield { type: "server_tool_block", blocks: block.blocks }
          }
          index += 1
        }
        yield { type: "usage", usage: response.usage }
        yield { type: "completion", usage: response.usage, stopReason: response.stopReason }
        yield { type: "message_stop", stopReason: response.stopReason }
      },
    },
  }
}

export function responseBodyToCanonicalResponse(body: JsonObject | undefined, fallbackModel: string, status = 200): Canonical_Response {
  const output = Array.isArray(body?.output) ? body.output : []
  const content = output.flatMap((item) => canonicalContentFromOutputItem(item))
  const usage = canonicalUsageFromWireUsage(body?.usage)
  return {
    type: "canonical_response",
    id: typeof body?.id === "string" ? body.id : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    model: typeof body?.model === "string" ? body.model : fallbackModel,
    stopReason: status >= 400 ? "error" : responseStopReason(body),
    content,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      ...(usage.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
      ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
      ...(usage.outputReasoningTokens !== undefined ? { outputReasoningTokens: usage.outputReasoningTokens } : {}),
      ...(usage.serverToolUse ? { serverToolUse: usage.serverToolUse } : {}),
    },
  }
}

function canonicalInputToResponsesInput(input: Canonical_Request["input"]) {
  return input.flatMap((message) => {
    const content = message.content.flatMap((block) => canonicalBlockToResponsesContent(block))
    if (!content.length) return []
    return [{ role: message.role, content }]
  })
}

function canonicalBlockToResponsesContent(block: JsonObject): JsonObject[] {
  if (block.type === "text" && typeof block.text === "string") {
    return [{ type: "input_text", text: block.text }]
  }
  if (block.type === "tool_call" && typeof block.arguments === "string") {
    return [{
      type: "function_call",
      id: typeof block.id === "string" ? block.id : `fc_${crypto.randomUUID().replace(/-/g, "")}`,
      call_id: typeof block.callId === "string" ? block.callId : `call_${crypto.randomUUID().replace(/-/g, "")}`,
      name: typeof block.name === "string" ? block.name : "unknown",
      arguments: block.arguments,
    }]
  }
  return [block]
}

function canonicalContentFromOutputItem(item: JsonObject): Canonical_ContentBlock[] {
  if (!item || typeof item !== "object") return []
  if (item.type === "message") {
    const content = Array.isArray(item.content) ? item.content : []
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (part.type === "output_text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
      if (part.type === "refusal" && typeof part.refusal === "string") return [{ type: "text", text: part.refusal }]
      return []
    })
  }
  if (item.type === "function_call") {
    return [{
      type: "tool_call",
      id: typeof item.id === "string" ? item.id : `fc_${crypto.randomUUID().replace(/-/g, "")}`,
      callId: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${crypto.randomUUID().replace(/-/g, "")}`,
      name: typeof item.name === "string" ? item.name : "unknown",
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    }]
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary : []
    const thinking = summary.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("\n\n")
    return thinking ? [{ type: "thinking", thinking, signature: `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}` }] : []
  }
  return []
}

function responseStopReason(body: JsonObject | undefined) {
  if (!body) return "end_turn"
  if (body.status === "incomplete" && body.incomplete_details && typeof body.incomplete_details === "object" && (body.incomplete_details as JsonObject).reason === "max_output_tokens") return "max_tokens"
  const output = Array.isArray(body.output) ? body.output : []
  if (output.some((item) => item?.type === "function_call")) return "tool_use"
  return "end_turn"
}

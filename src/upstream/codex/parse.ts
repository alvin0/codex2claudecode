import type {
  Canonical_ContentBlock,
  Canonical_Event,
  Canonical_Request,
  Canonical_Response,
  Canonical_StreamResponse,
  Canonical_ToolCallBlock,
  Canonical_Usage,
} from "../../core/canonical"
import { consumeCodexSse, parseJsonObject, parseSseJson } from "../../core/sse"
import type { JsonObject, SseEvent } from "../../core/types"

const THINKING_SIGNATURE_PREFIX = "sig_"

const UPSTREAM_THINKING_EVENTS: Record<string, string> = {
  "response.queued": "**Queue** waiting for Codex slot",
  "response.created": "**Codex** session opened",
  "response.in_progress": "**Stream** events flowing",
  "response.output_item.added": "Preparing output",
  "response.content_part.added": "Preparing content",
  "response.reasoning_summary_part.added": "**Reasoning** sketching next step",
  "response.reasoning_summary_text.delta": "",
  "response.reasoning_summary_text.done": "",
  "response.reasoning_summary_part.done": "",
  "response.reasoning_text.delta": "",
  "response.reasoning_text.done": "",
  "response.file_search_call.in_progress": "**Search** scanning files",
  "response.file_search_call.searching": "**Search** scanning files",
  "response.file_search_call.completed": "",
  "response.web_search_call.in_progress": "**Search** querying web",
  "response.web_search_call.searching": "**Search** querying web",
  "response.web_search_call.completed": "",
  "response.code_interpreter_call.in_progress": "**Code** running interpreter",
  "response.code_interpreter_call.interpreting": "**Code** running interpreter",
  "response.code_interpreter_call_code.delta": "",
  "response.code_interpreter_call_code.done": "",
  "response.code_interpreter_call.completed": "",
  "response.mcp_call.in_progress": "**MCP** preparing tool call",
  "response.mcp_call.completed": "",
  "response.mcp_call.failed": "",
  "response.mcp_list_tools.in_progress": "**MCP** refreshing tool list",
  "response.mcp_list_tools.completed": "",
  "response.mcp_list_tools.failed": "",
  "response.mcp_call_arguments.delta": "",
  "response.mcp_call_arguments.done": "",
  "response.function_call_arguments.delta": "",
  "response.function_call_arguments.done": "",
  "response.image_generation_call.in_progress": "**Image** preparing generation",
  "response.image_generation_call.generating": "**Image** rendering pixels",
  "response.image_generation_call.completed": "",
}

const UPSTREAM_THINKING_TEXT_EVENTS = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
])

interface ParserState {
  id: string
  model: string
  content: Canonical_ContentBlock[]
  usage: Canonical_Usage
  stopReason: string
  incompleteReason?: string
  emittedText: string
  pendingServerCalls: unknown[]
  deferredText: string
  thinking: string
  thinkingSignature?: string
  thinkingOpen: boolean
  textBlockOpen: boolean
  contentIndex: number
  outputItems: Map<string, CodexOutputItemState>
}

interface CodexOutputItemState {
  type?: string
  name?: string
  arguments: string
}

export function canonicalToCodexBody(request: Canonical_Request): JsonObject {
  return {
    model: request.model,
    ...(request.reasoningEffort && { reasoning_effort: request.reasoningEffort }),
    ...(request.instructions && { instructions: request.instructions }),
    input: request.input.flatMap((message) => {
      const messageContent = message.content.filter((block) => !isRawInputItem(block))
      const rawItems = message.content.filter((block) => isRawInputItem(block))
      return [
        ...(messageContent.length
          ? [
              {
                role: message.role,
                content: messageContent,
              },
            ]
          : []),
        ...rawItems,
      ]
    }),
    store: false,
    stream: request.stream,
    ...(request.tools && { tools: request.tools }),
    ...(request.include && { include: request.include }),
    ...(request.toolChoice && { tool_choice: request.toolChoice }),
    ...(request.textFormat && { text: { format: request.textFormat } }),
  }
}

export async function collectCodexResponse(response: Response, fallbackModel = "unknown"): Promise<Canonical_Response> {
  const state = createParserState(fallbackModel)

  await consumeCodexSse(response.body, (event) => {
    const data = parseSseJson(event)
    if (!data) return
    applyEventToState(data, state)
  })

  finalizeState(state)
  return {
    type: "canonical_response",
    id: state.id,
    model: state.model,
    stopReason: state.stopReason,
    content: [...(state.thinking ? [{ type: "thinking", thinking: state.thinking, signature: state.thinkingSignature ?? createThinkingSignature() } satisfies Canonical_ContentBlock] : []), ...state.content],
    usage: state.usage,
  }
}

export function streamCodexResponse(response: Response, fallbackModel = "unknown"): Canonical_StreamResponse {
  const state = createParserState(fallbackModel)

  return {
    type: "canonical_stream",
    status: response.status,
    id: state.id,
    model: state.model,
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const event of iterateCodexEvents(response.body, state)) {
          yield event
        }
      },
    },
  }
}

function createParserState(fallbackModel: string): ParserState {
  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    model: fallbackModel,
    content: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
    emittedText: "",
    pendingServerCalls: [],
    deferredText: "",
    thinking: "",
    thinkingOpen: false,
    textBlockOpen: false,
    contentIndex: 0,
    outputItems: new Map(),
  }
}

async function* iterateCodexEvents(stream: ReadableStream<Uint8Array> | null, state: ParserState): AsyncIterable<Canonical_Event> {
  const queue: Canonical_Event[] = []
  let settled = false
  let failure: unknown
  let wake: (() => void) | undefined
  const controller = new AbortController()

  const notify = () => wake?.()

  const consume = consumeCodexSse(stream, (event) => {
    queue.push(...mapSseEventToCanonical(event, state))
    notify()
  }, { signal: controller.signal })
    .then(() => {
      finalizeState(state)
      settled = true
      notify()
    })
    .catch((error) => {
      failure = error
      settled = true
      notify()
    })

  try {
    while (!settled || queue.length > 0) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
        continue
      }
      const next = queue.shift()
      if (next) yield next
    }

    if (failure) throw failure
  } finally {
    if (!settled) {
      controller.abort("consumer cancelled")
      queue.length = 0
      notify()
      await consume.catch(() => undefined)
    }
  }
}

function mapSseEventToCanonical(event: SseEvent, state: ParserState): Canonical_Event[] {
  const data = parseSseJson(event)
  if (!data) return []
  return applyEventToState(data, state, true)
}

function applyEventToState(data: JsonObject, state: ParserState, emitStreamEvents = false): Canonical_Event[] {
  const events: Canonical_Event[] = []
  const type = typeof data.type === "string" ? data.type : ""
  trackOutputItemState(type, data, state.outputItems)

  if (type === "response.created") {
    const response = asJsonObject(data.response)
    if (typeof response.id === "string") state.id = response.id
    if (typeof response.model === "string") state.model = response.model
    if (emitStreamEvents) events.push({ type: "message_start", id: state.id, model: state.model })
  }

  if (type in UPSTREAM_THINKING_EVENTS) {
    const delta = thinkingDeltaForEvent(type, data, state.outputItems)
    if (delta) {
      if (!state.thinkingSignature) state.thinkingSignature = createThinkingSignature()
      state.thinking += delta
      if (emitStreamEvents) {
        if (!state.thinkingOpen) {
          closeText(state, events, emitStreamEvents)
          state.thinkingOpen = true
          events.push({ type: "content_block_start", blockType: "thinking", index: state.contentIndex, block: { type: "thinking" } })
          events.push({ type: "thinking_signature", signature: state.thinkingSignature })
        }
        events.push({ type: "thinking_delta", text: delta, label: UPSTREAM_THINKING_TEXT_EVENTS.has(type) ? undefined : delta })
      }
    }
    if (UPSTREAM_THINKING_TEXT_EVENTS.has(type) || UPSTREAM_THINKING_EVENTS[type] !== undefined) return events
  }

  if (type === "response.output_text.delta" && typeof data.delta === "string") {
    if (state.pendingServerCalls.length) {
      state.deferredText += data.delta
      return events
    }
    closeThinking(state, events, emitStreamEvents)
    openTextBlock(state, events, emitStreamEvents)
    appendTextBlock(state, data.delta)
    if (emitStreamEvents) events.push({ type: "text_delta", delta: data.delta })
    return events
  }

  if (type === "response.output_text.done" && typeof data.text === "string") {
    if (state.pendingServerCalls.length) {
      state.deferredText += remainingText(state, data.text)
      return events
    }
    closeThinking(state, events, emitStreamEvents)
    openTextBlock(state, events, emitStreamEvents)
    const next = remainingText(state, data.text)
    if (next) appendTextBlock(state, next)
    if (emitStreamEvents) events.push({ type: "text_done", text: data.text })
    return events
  }

  if (type === "response.function_call_arguments.delta" && typeof data.delta === "string") {
    const item = asJsonObject(data.item)
    if (emitStreamEvents) {
      events.push({
        type: "tool_call_delta",
        callId: typeof item.call_id === "string" ? item.call_id : "call_unknown",
        name: typeof item.name === "string" ? item.name : "unknown",
        argumentsDelta: data.delta,
      })
    }
    return events
  }

  if (type === "response.function_call_arguments.done") {
    const item = asJsonObject(data.item)
    if (emitStreamEvents) {
      events.push({
        type: "tool_call_done",
        callId: typeof item.call_id === "string" ? item.call_id : "call_unknown",
        name: typeof item.name === "string" ? item.name : "unknown",
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      })
    }
    return events
  }

  if (type === "response.output_item.added") {
    if (emitStreamEvents) {
      const item = asJsonObject(data.item)
      events.push({
        type: "content_block_start",
        blockType: typeof item.type === "string" ? item.type : "unknown",
        index: state.contentIndex,
        block: item,
      })
    }
    return events
  }

  if (type === "response.output_item.done") {
    closeThinking(state, events, emitStreamEvents)
    const item = data.item
    if (isServerToolOutputItem(item)) {
      const blocks = serverToolBlocksFromOutputItem(item)
      const hasImmediateResult = blocks.some((block) => block.type !== "server_tool_use" && block.type !== "mcp_tool_use")
      updateUsageFromOutput(state, [item])
      if (!hasImmediateResult) {
        state.pendingServerCalls.push(item)
        return events
      }
      closeText(state, events, emitStreamEvents)
      state.content.push({ type: "server_tool", blocks })
      if (emitStreamEvents) {
        events.push({ type: "server_tool_block", blocks })
        events.push({ type: "message_item_done", item: asJsonObject(item) })
        events.push({ type: "content_block_stop", index: state.contentIndex })
      }
      state.contentIndex += 1
      return events
    }

    const outputItem = asJsonObject(item)
    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      for (const block of messageOutputToCanonicalContent([{ type: "message", content: outputItem.content }])) {
        emitCanonicalBlock(block, state, events, emitStreamEvents)
      }
      if (emitStreamEvents) events.push({ type: "message_item_done", item: outputItem })
      return events
    }

    if (outputItem.type === "function_call" && typeof outputItem.call_id === "string") {
      closeText(state, events, emitStreamEvents)
      const block: Canonical_ToolCallBlock = {
        type: "tool_call",
        id: typeof outputItem.id === "string" ? outputItem.id : `fc_${outputItem.call_id}`,
        callId: outputItem.call_id,
        name: typeof outputItem.name === "string" ? outputItem.name : "unknown",
        arguments: typeof outputItem.arguments === "string" ? outputItem.arguments : "{}",
      }
      state.content.push(block)
      state.stopReason = "tool_use"
      if (emitStreamEvents) {
        events.push({ type: "tool_call_done", callId: block.callId, name: block.name, arguments: block.arguments })
        events.push({ type: "message_item_done", item: outputItem })
        events.push({ type: "content_block_stop", index: state.contentIndex })
      }
      state.contentIndex += 1
      return events
    }
  }

  if (type === "response.completed") {
    closeThinking(state, events, emitStreamEvents)
    const response = asJsonObject(data.response)
    updateUsageFromResponse(state, response)
    if (response.incomplete_details && asJsonObject(response.incomplete_details).reason === "max_output_tokens") {
      state.stopReason = "max_tokens"
      state.incompleteReason = "max_output_tokens"
    }

    if (Array.isArray(response.output)) {
      const content = outputToCanonicalContent(response.output)
      if (content.length) state.content = content
      updateUsageFromOutput(state, response.output)
      state.pendingServerCalls.length = 0
      state.deferredText = ""
      state.textBlockOpen = false
    }

    finalizeState(state)
    if (emitStreamEvents) {
      closeText(state, events, emitStreamEvents)
      events.push({ type: "usage", usage: state.usage })
      events.push({
        type: "completion",
        output: response.output,
        usage: state.usage,
        stopReason: state.stopReason,
        incompleteReason: state.incompleteReason,
      })
      events.push({ type: "message_stop", stopReason: state.stopReason })
    }
    return events
  }

  if (type === "response.incomplete") {
    closeThinking(state, events, emitStreamEvents)
    const response = asJsonObject(data.response)
    updateUsageFromResponse(state, response)
    state.stopReason = "max_tokens"
    state.incompleteReason = typeof asJsonObject(response.incomplete_details).reason === "string" ? String(asJsonObject(response.incomplete_details).reason) : "max_output_tokens"
    if (emitStreamEvents) {
      closeText(state, events, emitStreamEvents)
      events.push({ type: "usage", usage: state.usage })
      events.push({ type: "message_stop", stopReason: state.stopReason })
    }
    return events
  }

  if (type === "response.failed") {
    closeThinking(state, events, emitStreamEvents)
    const response = asJsonObject(data.response)
    updateUsageFromResponse(state, response)
    const message = typeof asJsonObject(response.error).message === "string" ? String(asJsonObject(response.error).message) : "Upstream generation failed"
    if (emitStreamEvents) {
      closeText(state, events, emitStreamEvents)
      events.push({ type: "error", message })
    }
    return events
  }

  if (type.startsWith("response.") && emitStreamEvents) {
    const label = UPSTREAM_THINKING_EVENTS[type]
    events.push({ type: "lifecycle", label: label ?? type })
  }

  return events
}

function emitCanonicalBlock(block: Canonical_ContentBlock, state: ParserState, events: Canonical_Event[], emitStreamEvents: boolean) {
  closeThinking(state, events, emitStreamEvents)
  if (block.type === "text") {
    openTextBlock(state, events, emitStreamEvents)
    const next = remainingText(state, block.text)
    if (next) {
      appendTextBlock(state, next)
      if (emitStreamEvents) events.push({ type: "text_done", text: block.text })
    }
    return
  }

  closeText(state, events, emitStreamEvents)
  state.content.push(block)

  if (emitStreamEvents) {
    if (block.type === "server_tool") events.push({ type: "server_tool_block", blocks: block.blocks })
    if (block.type === "tool_call") events.push({ type: "tool_call_done", callId: block.callId, name: block.name, arguments: block.arguments })
    if (block.type === "thinking") {
      events.push({ type: "thinking_signature", signature: block.signature })
      events.push({ type: "thinking_delta", text: block.thinking })
    }
    events.push({ type: "content_block_stop", index: state.contentIndex })
  }
  state.contentIndex += 1
}

function openTextBlock(state: ParserState, events: Canonical_Event[], emitStreamEvents: boolean) {
  if (state.textBlockOpen) return
  state.textBlockOpen = true
  if (emitStreamEvents) events.push({ type: "content_block_start", blockType: "text", index: state.contentIndex, block: { type: "text" } })
}

function closeText(state: ParserState, events: Canonical_Event[], emitStreamEvents: boolean) {
  if (!state.textBlockOpen) return
  state.textBlockOpen = false
  if (emitStreamEvents) events.push({ type: "content_block_stop", index: state.contentIndex })
  state.contentIndex += 1
}

function closeThinking(state: ParserState, events: Canonical_Event[], emitStreamEvents: boolean) {
  if (!state.thinkingOpen) return
  state.thinkingOpen = false
  if (emitStreamEvents) {
    events.push({ type: "content_block_stop", index: state.contentIndex })
    state.contentIndex += 1
  }
}

function appendTextBlock(state: ParserState, text: string) {
  if (!text) return
  const last = state.content.at(-1)
  if (last?.type === "text") last.text += text
  else state.content.push({ type: "text", text })
  state.emittedText += text
}

function remainingText(state: ParserState, text: string) {
  if (!state.emittedText) return text
  return text.startsWith(state.emittedText) ? text.slice(state.emittedText.length) : text
}

function finalizeState(state: ParserState) {
  if (state.pendingServerCalls.length) {
    for (const item of state.pendingServerCalls) {
      state.content.push({ type: "server_tool", blocks: serverToolBlocksFromOutputItem(item) })
    }
    if (state.deferredText) appendTextBlock(state, state.deferredText)
    state.pendingServerCalls.length = 0
    state.deferredText = ""
  }
}

function updateUsageFromResponse(state: ParserState, response: JsonObject) {
  const usage = asJsonObject(response.usage)
  if (typeof usage.input_tokens === "number") state.usage.inputTokens = usage.input_tokens
  if (typeof usage.output_tokens === "number") state.usage.outputTokens = usage.output_tokens
}

function updateUsageFromOutput(state: ParserState, output: unknown[]) {
  const counts = countServerToolUse(output)
  if (!counts.webSearchRequests && !counts.webFetchRequests && !counts.mcpCalls) return
  state.usage.serverToolUse = {
    webSearchRequests: (state.usage.serverToolUse?.webSearchRequests ?? 0) + counts.webSearchRequests,
    webFetchRequests: (state.usage.serverToolUse?.webFetchRequests ?? 0) + counts.webFetchRequests,
    mcpCalls: (state.usage.serverToolUse?.mcpCalls ?? 0) + counts.mcpCalls,
  }
}

function outputToCanonicalContent(output: unknown[]): Canonical_ContentBlock[] {
  const blocks: Canonical_ContentBlock[] = []
  for (const item of output) {
    if (isServerToolOutputItem(item)) {
      blocks.push({ type: "server_tool", blocks: serverToolBlocksFromOutputItem(item, output) })
      continue
    }
    if (!item || typeof item !== "object") continue
    const outputItem = item as { type?: unknown; content?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown }
    if (outputItem.type === "message" && Array.isArray(outputItem.content)) {
      blocks.push(...messageOutputToCanonicalContent([{ type: "message", content: outputItem.content }]))
      continue
    }
    if (outputItem.type === "function_call" && typeof outputItem.call_id === "string") {
      blocks.push({
        type: "tool_call",
        id: typeof outputItem.id === "string" ? outputItem.id : `fc_${outputItem.call_id}`,
        callId: outputItem.call_id,
        name: typeof outputItem.name === "string" ? outputItem.name : "unknown",
        arguments: typeof outputItem.arguments === "string" ? outputItem.arguments : "{}",
      })
    }
  }
  return blocks
}

function messageOutputToCanonicalContent(output: unknown) {
  if (!Array.isArray(output)) return []
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const outputItem = item as { type?: unknown; content?: unknown }
    if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) return []
    return outputItem.content.flatMap((content) => {
      if (!content || typeof content !== "object") return []
      const block = content as { type?: unknown; text?: unknown; annotations?: unknown }
      if (block.type !== "output_text" || typeof block.text !== "string") return []
      return [
        {
          type: "text",
          text: block.text,
          ...(Array.isArray(block.annotations) ? { annotations: block.annotations.filter((annotation) => Boolean(annotation) && typeof annotation === "object") as JsonObject[] } : {}),
        } satisfies Canonical_ContentBlock,
      ]
    })
  })
}

function isServerToolOutputItem(item: unknown) {
  if (!item || typeof item !== "object") return false
  const outputItem = item as { type?: unknown }
  return outputItem.type === "web_search_call" || outputItem.type === "mcp_call" || outputItem.type === "mcp_list_tools"
}

function countServerToolUse(output: unknown[]) {
  return output.reduce(
    (acc, item) => {
      if (!item || typeof item !== "object") return acc
      const outputItem = item as { type?: unknown; action?: unknown }
      if (outputItem.type === "web_search_call") {
        const action = asJsonObject(outputItem.action)
        if (action.type === "open_page") acc.webFetchRequests += 1
        else acc.webSearchRequests += 1
      }
      if (outputItem.type === "mcp_call") acc.mcpCalls += 1
      return acc
    },
    { webSearchRequests: 0, webFetchRequests: 0, mcpCalls: 0 },
  )
}

function serverToolBlocksFromOutputItem(item: unknown, fallbackOutput?: unknown): JsonObject[] {
  if (!item || typeof item !== "object") return []
  const outputItem = item as {
    type?: unknown
    id?: unknown
    name?: unknown
    action?: unknown
    arguments?: unknown
    server_label?: unknown
    output?: unknown
    status?: unknown
    error?: unknown
    approval_request_id?: unknown
    tools?: unknown
  }

  if (outputItem.type === "web_search_call") return webSearchBlocks(outputItem, fallbackOutput)
  if (outputItem.type === "mcp_call") return mcpBlocks(outputItem)
  if (outputItem.type === "mcp_list_tools") {
    return [
      {
        type: "text",
        text: JSON.stringify({
          type: "mcp_list_tools",
          server_name: typeof outputItem.server_label === "string" ? outputItem.server_label : "unknown",
          tools: Array.isArray(outputItem.tools) ? outputItem.tools : [],
        }),
      },
    ]
  }
  return []
}

function webSearchBlocks(
  item: { id?: unknown; action?: unknown },
  fallbackOutput?: unknown,
) {
  const action = asJsonObject(item.action)
  const name = action.type === "open_page" ? "web_fetch" : "web_search"
  const id = serverToolId(typeof item.id === "string" ? item.id : crypto.randomUUID())
  const input = name === "web_fetch" ? { url: typeof action.url === "string" ? action.url : "" } : { query: webSearchQuery(action) }
  const sources = webSources(action)
  const fallbackSources = Array.isArray(fallbackOutput)
    ? fallbackOutput.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return []
        const outputItem = entry as { type?: unknown; content?: unknown }
        if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) return []
        return outputItem.content.flatMap((content) => {
          if (!content || typeof content !== "object") return []
          const block = content as { annotations?: unknown }
          return Array.isArray(block.annotations) ? block.annotations.flatMap(annotationSource) : []
        })
      })
    : []

  return [
    {
      type: "server_tool_use",
      id,
      name,
      input,
    },
    name === "web_fetch"
      ? {
          type: "web_fetch_tool_result",
          tool_use_id: id,
          content: {
            type: "web_fetch_result",
            url: typeof action.url === "string" ? action.url : "",
            content: {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "",
              },
              ...(typeof action.title === "string" && { title: action.title }),
            },
            retrieved_at: new Date().toISOString(),
          },
        }
      : {
          type: "web_search_tool_result",
          tool_use_id: id,
          content: (sources.length ? sources : fallbackSources).map((source) => ({
            type: "web_search_result",
            url: source.url,
            title: source.title,
            encrypted_content: source.encrypted_content,
          })),
        },
  ]
}

function annotationSource(annotation: unknown) {
  if (!annotation || typeof annotation !== "object") return []
  const item = annotation as { url?: unknown; title?: unknown }
  if (typeof item.url !== "string") return []
  return [{ url: item.url, title: typeof item.title === "string" ? item.title : item.url, encrypted_content: "" }]
}

function webSearchQuery(action: JsonObject) {
  if (typeof action.query === "string") return action.query
  if (Array.isArray(action.queries)) return action.queries.filter((query) => typeof query === "string").join("\n")
  return ""
}

function webSources(action: JsonObject) {
  if (!Array.isArray(action.sources)) return []
  return action.sources.flatMap((source) => {
    if (!source || typeof source !== "object") return []
    const item = source as { type?: unknown; name?: unknown; url?: unknown; title?: unknown }
    if (item.type === "api" && typeof item.name === "string") {
      return [
        {
          url: apiSourceUrl(action, item.name),
          title: item.name,
          encrypted_content: "",
        },
      ]
    }
    if (typeof item.url !== "string") return []
    return [
      {
        url: item.url,
        title: typeof item.title === "string" ? item.title : item.url,
        encrypted_content: "",
      },
    ]
  })
}

function apiSourceUrl(action: JsonObject, name: string) {
  const query = webSearchQuery(action)
  const finance = query.match(/^finance:\s*([A-Za-z0-9.-]+)/i)
  if (name === "oai-finance" && finance) return `https://www.google.com/finance/quote/${finance[1].toUpperCase()}-USD`
  return `https://www.google.com/search?q=${encodeURIComponent(query || name)}`
}

function mcpBlocks(outputItem: {
  id?: unknown
  name?: unknown
  arguments?: unknown
  server_label?: unknown
  output?: unknown
  status?: unknown
  error?: unknown
  approval_request_id?: unknown
}) {
  const id = typeof outputItem.id === "string" ? outputItem.id : `mcp_${crypto.randomUUID().replace(/-/g, "")}`
  return [
    {
      type: "mcp_tool_use",
      id,
      name: typeof outputItem.name === "string" ? outputItem.name : "unknown",
      server_name: typeof outputItem.server_label === "string" ? outputItem.server_label : "unknown",
      input: parseJsonObject(typeof outputItem.arguments === "string" ? outputItem.arguments : "{}"),
      ...(typeof outputItem.approval_request_id === "string" ? { approval_request_id: outputItem.approval_request_id } : {}),
    },
    {
      type: "mcp_tool_result",
      tool_use_id: id,
      is_error: outputItem.status === "failed" || Boolean(outputItem.error),
      content: mcpOutputContent(outputItem.output),
    },
  ]
}

function mcpOutputContent(output: unknown) {
  if (typeof output === "string") return [{ type: "text", text: output }]
  if (Array.isArray(output)) {
    return output.flatMap((item) => {
      if (typeof item === "string") return [{ type: "text", text: item }]
      if (!item || typeof item !== "object") return []
      const part = item as { type?: unknown; text?: unknown }
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }]
      return [{ type: "text", text: JSON.stringify(item) }]
    })
  }
  if (output && typeof output === "object") return [{ type: "text", text: JSON.stringify(output) }]
  return []
}

function thinkingDeltaForEvent(type: string, data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  if (UPSTREAM_THINKING_TEXT_EVENTS.has(type)) {
    if (typeof data.delta === "string") return data.delta
    if (typeof data.text === "string") return data.text
    if (typeof data.code === "string") return data.code
    return ""
  }
  const label = dynamicThinkingLabel(type, data, outputItems)
  if (label !== undefined) return label
  const fallbackLabel = UPSTREAM_THINKING_EVENTS[type]
  return fallbackLabel ? formatThinkingLabel(fallbackLabel) : ""
}

function dynamicThinkingLabel(type: string, data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  if (type === "response.output_item.added") return outputItemAddedLabel(asJsonObject(data.item))
  if (type === "response.content_part.added") return contentPartAddedLabel(asJsonObject(data.part))
  if (type === "response.function_call_arguments.done") return functionCallArgumentsLabel(data, outputItems)
  return undefined
}

function trackOutputItemState(type: string, data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  if (type === "response.output_item.added") {
    const item = asJsonObject(data.item)
    const entry: CodexOutputItemState = {
      type: typeof item.type === "string" ? item.type : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      arguments: typeof item.arguments === "string" ? item.arguments : "",
    }
    for (const key of outputItemKeys(data, item)) outputItems.set(key, entry)
    return
  }

  if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    const item = asJsonObject(data.item)
    const keys = outputItemKeys(data, item)
    const entry = keys.map((key) => outputItems.get(key)).find(Boolean) ?? {
      type: typeof item.type === "string" ? item.type : "function_call",
      name: typeof item.name === "string" ? item.name : undefined,
      arguments: "",
    }
    if (typeof item.name === "string") entry.name = item.name
    if (typeof data.delta === "string") entry.arguments += data.delta
    if (typeof data.arguments === "string") entry.arguments = data.arguments
    if (typeof item.arguments === "string") entry.arguments = item.arguments
    for (const key of keys) outputItems.set(key, entry)
  }
}

function outputItemKeys(data: JsonObject, item: JsonObject) {
  return [
    data.item_id,
    item.id,
    item.call_id,
    typeof item.call_id === "string" ? `call:${item.call_id}` : undefined,
  ].filter((key, index, keys): key is string => typeof key === "string" && key.length > 0 && keys.indexOf(key) === index)
}

function functionCallArgumentsLabel(data: JsonObject, outputItems: Map<string, CodexOutputItemState>) {
  const item = asJsonObject(data.item)
  const entry = outputItemKeys(data, item).map((key) => outputItems.get(key)).find(Boolean)
  const name = entry?.name ?? (typeof item.name === "string" ? item.name : "tool")
  const args = typeof data.arguments === "string" ? data.arguments
    : typeof item.arguments === "string" ? item.arguments
    : entry?.arguments ?? ""
  const summary = summarizeToolArguments(args, name)
  return summary ? formatThinkingLabel(`**Tool request** \`${name}\`:\n${summary}`) : formatThinkingLabel(`**Tool** preparing \`${name}\``)
}

function outputItemAddedLabel(item: JsonObject) {
  if (item.type === "function_call") {
    const name = typeof item.name === "string" && item.name ? item.name : "tool"
    return formatThinkingLabel(`**Tool** preparing \`${name}\``)
  }
  if (item.type === "mcp_call") {
    const name = typeof item.name === "string" && item.name ? item.name : "tool"
    return formatThinkingLabel(`**MCP** preparing \`${name}\``)
  }
  if (item.type === "mcp_list_tools") {
    const server = typeof item.server_label === "string" && item.server_label ? item.server_label : "MCP"
    return formatThinkingLabel(`**MCP** listing \`${server}\` tools`)
  }
  if (item.type === "web_search_call") return formatThinkingLabel("**Search** querying web")
  if (item.type === "message") {
    if (item.phase === "commentary") return formatThinkingLabel("**Commentary** drafting update")
    if (item.phase === "analysis") return formatThinkingLabel("**Thinking** mapping next move")
    return formatThinkingLabel("**Response** composing answer")
  }
  if (item.type === "reasoning") return formatThinkingLabel("**Reasoning** sketching next step")
  return undefined
}

function contentPartAddedLabel(part: JsonObject) {
  if (part.type === "output_text") return formatThinkingLabel("**Output** opening text stream")
  if (part.type === "reasoning_text") return formatThinkingLabel("**Reasoning** streaming notes")
  if (part.type === "refusal") return formatThinkingLabel("**Safety** preparing refusal")
  return undefined
}

function summarizeToolArguments(argumentsJson: string, toolName: string) {
  const parsed = parseJsonObject(argumentsJson)
  const normalizedToolName = toolName.toLowerCase()

  if (Array.isArray(parsed.todos)) {
    return truncateLabel(
      parsed.todos
        .flatMap((todo) => {
          if (!todo || typeof todo !== "object") return []
          const item = todo as { content?: unknown; status?: unknown }
          if (typeof item.content !== "string" || !item.content) return []
          return [typeof item.status === "string" ? `[${item.status}] ${item.content}` : item.content]
        })
        .slice(0, 3)
        .map((content) => `- ${content}`)
        .join("\n"),
    )
  }

  if (normalizedToolName === "bash" || normalizedToolName === "powershell") {
    return summarizeFields(parsed, ["command", "description", "timeout", "workdir"])
  }

  const fieldSummary = summarizeFields(parsed, ["file_path", "path", "pattern", "query", "url", "prompt", "value", "workdir"])
  if (fieldSummary) return fieldSummary

  const keys = Object.keys(parsed)
  if (keys.length) return summarizeFields(parsed, keys.slice(0, 4))
  return truncateLabel(argumentsJson)
}

function summarizeFields(value: JsonObject, fields: string[]) {
  return truncateLabel(
    fields
      .flatMap((field) => {
        const fieldValue = value[field]
        if (fieldValue === undefined || fieldValue === null) return []
        if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") {
          return [`- **${field}**: ${formatFieldValue(fieldValue)}`]
        }
        if (Array.isArray(fieldValue)) return [`- **${field}**: ${fieldValue.length} item${fieldValue.length === 1 ? "" : "s"}`]
        if (typeof fieldValue === "object") return [`- **${field}**: \`${JSON.stringify(fieldValue)}\``]
        return []
      })
      .join("\n"),
  )
}

function formatFieldValue(value: string | number | boolean) {
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``
  const escaped = value.replace(/`/g, "\\`")
  return `\`${escaped}\``
}

function truncateLabel(value: string) {
  const compact = value.replace(/[^\S\r\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  return compact.length > 600 ? `${compact.slice(0, 588)} [truncated]` : compact
}

function formatThinkingLabel(value: string) {
  return `${value.trimEnd()}\n`
}

function createThinkingSignature() {
  return `${THINKING_SIGNATURE_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
}

function isRawInputItem(block: JsonObject) {
  return block.type === "function_call" || block.type === "function_call_output"
}

function serverToolId(id: string) {
  if (id.startsWith("srvtoolu_")) return id
  return `srvtoolu_${id.replace(/[^A-Za-z0-9]/g, "")}`
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}
}

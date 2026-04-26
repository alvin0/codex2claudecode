import type { Canonical_InputMessage, Canonical_Request } from "../../core/canonical"
import type { JsonObject } from "../../core/types"
import { REASONING_EFFORT_BUDGETS, TOOL_DESCRIPTION_MAX_LENGTH, TOOL_NAME_MAX_LENGTH, kiroPayloadSizeLimitBytes } from "./constants"
import type { KiroAuthType, KiroGeneratePayload, KiroHistoryEntry, KiroImage, KiroToolResult, KiroToolSpecification, KiroToolUse } from "./types"
import { PayloadTooLargeError, ToolNameTooLongError } from "./types"

interface ConvertOptions {
  modelId: string
  authType: KiroAuthType
  profileArn?: string
  instructions?: string
  payloadSizeLimitBytes?: number
  onTrim?: (notice: KiroPayloadTrimNotice) => void
}

export interface KiroPayloadTrimNotice {
  originalSize: number
  finalSize: number
  limit: number
  removedHistoryEntries: number
  remainingHistoryEntries: number
}

interface WorkingMessage {
  role: "user" | "assistant"
  content: string
  toolUses?: KiroToolUse[]
  toolResults?: KiroToolResult[]
  images?: KiroImage[]
  serverToolContent?: JsonObject[]
}

interface TrimmedPayloadCandidate {
  payload: KiroGeneratePayload
  size: number
}

export function convertCanonicalToKiroPayload(request: Canonical_Request, effectiveTools: JsonObject[], options: ConvertOptions): KiroGeneratePayload {
  const toolDocs: string[] = []
  validateToolNames(effectiveTools)
  const tools = effectiveTools.map((tool) => convertTool(tool, toolDocs))
  const effectiveNames = new Set(effectiveTools.map((tool) => typeof tool.name === "string" ? tool.name : "").filter(Boolean))
  let messages = request.input.map(convertInputMessage)

  messages = stripServerToolContent(messages).filter(hasKiroContent)
  if (isNamedToolChoice(request.toolChoice) && effectiveNames.size > 0) messages = convertNonEffectiveToolsToText(messages, effectiveNames)
  if (effectiveTools.length === 0) messages = convertAllToolsToText(messages)
  messages = repairMessages(messages)

  const baseInstructions = [options.instructions, toolDocs.length ? `Tool documentation:\n${toolDocs.join("\n\n")}` : undefined].filter(Boolean).join("\n\n")
  const split = splitMessages(messages)
  const repaired = repairOrphanedToolResults(split.historyMessages, split.currentMessage)
  let historyMessages = repaired.historyMessages
  let currentMessage = repaired.currentMessage
  embedInstructions(historyMessages, currentMessage, baseInstructions)
  ensureHistoryContent(historyMessages)
  const preserveCurrentThinkingPrefix = injectThinkingTags(currentMessage, request.reasoningEffort)

  return trimPayload(buildPayload(historyMessages, currentMessage, tools, options), tools, options, baseInstructions, preserveCurrentThinkingPrefix)
}

export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} }
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue
    if (key === "required" && Array.isArray(value) && value.length === 0) continue
    if (Array.isArray(value)) output[key] = value.map((item) => item && typeof item === "object" ? sanitizeToolSchema(item) : item)
    else if (value && typeof value === "object") output[key] = sanitizeToolSchema(value)
    else output[key] = value
  }
  return output
}

function validateToolNames(tools: JsonObject[]) {
  const tooLong = tools.flatMap((tool) => typeof tool.name === "string" && tool.name.length > TOOL_NAME_MAX_LENGTH ? [`${tool.name} (${tool.name.length})`] : [])
  if (tooLong.length) throw new ToolNameTooLongError(`Kiro tool names exceed ${TOOL_NAME_MAX_LENGTH} characters: ${tooLong.join(", ")}`)
}

function convertTool(tool: JsonObject, docs: string[]): KiroToolSpecification {
  const name = typeof tool.name === "string" ? tool.name : "unknown"
  let description = typeof tool.description === "string" && tool.description.trim() ? tool.description : `Tool: ${name}`
  if (description.length > TOOL_DESCRIPTION_MAX_LENGTH) {
    docs.push(`Tool ${name}:\n${description}`)
    description = `See system prompt for full documentation for ${name}.`
  }
  return {
    toolSpecification: {
      name,
      description,
      inputSchema: { json: sanitizeToolSchema(tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} }) },
    },
  }
}

function convertInputMessage(message: Canonical_InputMessage): WorkingMessage {
  if (message.role === "tool") return convertToolRoleMessage(message)
  const role = message.role === "assistant" ? "assistant" : "user"
  const working: WorkingMessage = { role, content: "" }
  const contentParts: string[] = []

  for (const item of message.content) {
    if (isServerToolContent(item)) {
      ;(working.serverToolContent ??= []).push(item)
      continue
    }
    if (item.type === "function_call") {
      const toolUse = functionCallToToolUse(item)
      if (toolUse) (working.toolUses ??= []).push(toolUse)
      continue
    }
    if (item.type === "function_call_output") {
      ;(working.toolResults ??= []).push(functionOutputToToolResult(item))
      continue
    }
    if (item.type === "input_image") {
      const image = inputImageToKiroImage(item)
      if (image) (working.images ??= []).push(image)
      else {
        console.warn("Skipping URL-based image because Kiro only supports base64 data URL images")
        contentParts.push("[Unsupported: URL-based image skipped — Kiro only supports base64 data URL images]")
      }
      continue
    }
    if (item.type === "input_file") {
      contentParts.push(inputFileToText(item))
      continue
    }
    const text = textFromContent(item)
    if (text) contentParts.push(text)
  }

  working.content = contentParts.join("\n")
  return working
}

function convertToolRoleMessage(message: Canonical_InputMessage): WorkingMessage {
  const results: KiroToolResult[] = []
  const text: string[] = []
  for (const item of message.content) {
    if (item.type === "function_call_output") results.push(functionOutputToToolResult(item))
    else {
      const content = textFromContent(item)
      if (content) text.push(content)
    }
  }
  return { role: "user", content: text.join("\n"), toolResults: results }
}

function stripServerToolContent(messages: WorkingMessage[]) {
  return messages.map((message) => {
    if (message.serverToolContent?.length) {
      for (const item of message.serverToolContent) console.warn(`Stripping historical server-tool content from Kiro payload: ${String(item.type ?? "unknown")}`)
    }
    const { serverToolContent: _serverToolContent, ...rest } = message
    return rest
  })
}

function hasKiroContent(message: WorkingMessage) {
  return Boolean(message.content || message.toolUses?.length || message.toolResults?.length || message.images?.length)
}

function isNamedToolChoice(toolChoice: Canonical_Request["toolChoice"]) {
  return Boolean(toolChoice && typeof toolChoice === "object" && (typeof toolChoice.name === "string" || typeof (toolChoice as { function?: { name?: unknown } }).function?.name === "string"))
}

function convertNonEffectiveToolsToText(messages: WorkingMessage[], effectiveNames: Set<string>) {
  const effectiveToolUseIds = new Set(
    messages.flatMap((message) => message.toolUses?.flatMap((toolUse) => effectiveNames.has(toolUse.name) ? [toolUse.toolUseId] : []) ?? []),
  )

  return messages.map((message) => {
    const next = { ...message }
    if (next.toolUses?.length) {
      const keep = next.toolUses.filter((toolUse) => effectiveNames.has(toolUse.name))
      const convert = next.toolUses.filter((toolUse) => !effectiveNames.has(toolUse.name))
      next.content = appendText(next.content, convert.map(toolUseToText).join("\n\n"))
      next.toolUses = keep.length ? keep : undefined
    }
    if (next.toolResults?.length) {
      const keep = next.toolResults.filter((result) => effectiveToolUseIds.has(result.toolUseId))
      const convert = next.toolResults.filter((result) => !effectiveToolUseIds.has(result.toolUseId))
      next.content = appendText(next.content, convert.map(toolResultToText).join("\n\n"))
      next.toolResults = keep.length ? keep : undefined
    }
    return next
  })
}

function convertAllToolsToText(messages: WorkingMessage[]) {
  return messages.map((message) => {
    const toolUseText = message.toolUses?.map(toolUseToText).join("\n\n") ?? ""
    const toolResultText = message.toolResults?.map(toolResultToText).join("\n\n") ?? ""
    return {
      ...message,
      content: appendText(appendText(message.content, toolUseText), toolResultText),
      toolUses: undefined,
      toolResults: undefined,
    }
  })
}

function repairMessages(messages: WorkingMessage[]) {
  const repaired = messages.map((message) => ({ ...message, role: message.role === "assistant" ? "assistant" as const : "user" as const }))
  const merged: WorkingMessage[] = []
  for (const message of repaired) {
    const previous = merged.at(-1)
    if (previous?.role === message.role) {
      previous.content = appendText(previous.content, message.content)
      if (message.toolUses?.length) previous.toolUses = [...(previous.toolUses ?? []), ...message.toolUses]
      if (message.toolResults?.length) previous.toolResults = [...(previous.toolResults ?? []), ...message.toolResults]
      if (message.images?.length) previous.images = [...(previous.images ?? []), ...message.images]
      continue
    }
    merged.push(message)
  }
  if (!merged.length) merged.push({ role: "user", content: "Continue" })
  if (merged[0].role === "assistant") merged.unshift({ role: "user", content: "(empty)" })
  return merged
}

function splitMessages(messages: WorkingMessage[]) {
  const historyMessages = messages.slice(0, -1)
  const last = messages.at(-1) ?? { role: "user" as const, content: "Continue" }
  if (last.role === "assistant") {
    historyMessages.push(last)
    return { historyMessages, currentMessage: { role: "user" as const, content: "Continue" } }
  }
  return {
    historyMessages,
    currentMessage: { ...last, content: last.content || "Continue" },
  }
}

function repairOrphanedToolResults(historyMessages: WorkingMessage[], currentMessage: WorkingMessage) {
  const repairedHistory = historyMessages.map((message, index) => repairMessageToolResults(message, previousAssistant(historyMessages, index)))
  const repairedCurrent = repairMessageToolResults(currentMessage, [...repairedHistory].reverse().find((message) => message.role === "assistant"))
  return { historyMessages: repairedHistory, currentMessage: repairedCurrent }
}

function repairMessageToolResults(message: WorkingMessage, assistant?: WorkingMessage) {
  if (message.role !== "user" || !message.toolResults?.length) return message
  const validIds = new Set(assistant?.toolUses?.map((toolUse) => toolUse.toolUseId) ?? [])
  const keep = message.toolResults.filter((result) => validIds.has(result.toolUseId))
  const convert = message.toolResults.filter((result) => !validIds.has(result.toolUseId))
  if (!convert.length) return message
  return {
    ...message,
    content: appendText(message.content, convert.map(toolResultToText).join("\n\n")),
    toolResults: keep.length ? keep : undefined,
  }
}

function previousAssistant(messages: WorkingMessage[], index: number) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i]
    if (messages[i].role === "user") return undefined
  }
}

function embedInstructions(historyMessages: WorkingMessage[], currentMessage: WorkingMessage, instructions: string, preserveCurrentThinkingPrefix = false) {
  if (!instructions) return
  const target = historyMessages.find((message) => message.role === "user") ?? currentMessage
  if (preserveCurrentThinkingPrefix && target === currentMessage) {
    const { prefix, body } = splitThinkingPrefix(target.content)
    target.content = `${prefix}${instructions}\n\n${body || "Continue"}`
    return
  }
  target.content = `${instructions}\n\n${target.content || "Continue"}`
}

function splitThinkingPrefix(content: string) {
  const match = content.match(/^<thinking_mode>enabled<\/thinking_mode>\n<max_thinking_length>\d+<\/max_thinking_length>\n/)
  return match ? { prefix: match[0], body: content.slice(match[0].length) } : { prefix: "", body: content }
}

function ensureHistoryContent(historyMessages: WorkingMessage[]) {
  for (const message of historyMessages) {
    if (!message.content) message.content = "(empty)"
  }
}

function injectThinkingTags(currentMessage: WorkingMessage, reasoningEffort?: string) {
  if (!reasoningEffort) return false
  const budget = REASONING_EFFORT_BUDGETS[reasoningEffort]
  if (!budget) return false
  currentMessage.content = `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${budget}</max_thinking_length>\n${currentMessage.content}`
  return true
}

function buildPayload(historyMessages: WorkingMessage[], currentMessage: WorkingMessage, tools: KiroToolSpecification[], options: ConvertOptions): KiroGeneratePayload {
  const history = historyMessages.map((message) => message.role === "assistant" ? assistantHistory(message) : userHistory(message, options.modelId))
  const context = {
    ...(currentMessage.toolResults?.length ? { toolResults: currentMessage.toolResults } : {}),
    ...(tools.length ? { tools } : {}),
  }
  const payload: KiroGeneratePayload = {
    conversationState: {
      conversationId: crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: currentMessage.content || "Continue",
          modelId: options.modelId,
          origin: "AI_EDITOR",
          ...(Object.keys(context).length ? { userInputMessageContext: context } : {}),
          ...(currentMessage.images?.length ? { images: currentMessage.images } : {}),
        },
      },
      chatTriggerType: "MANUAL",
      ...(history.length ? { history } : {}),
    },
    ...(options.authType === "kiro_desktop" && options.profileArn ? { profileArn: options.profileArn } : {}),
  }
  return payload
}

function userHistory(message: WorkingMessage, modelId: string): KiroHistoryEntry {
  const context = message.toolResults?.length ? { toolResults: message.toolResults } : undefined
  return {
    userInputMessage: {
      content: message.content || "(empty)",
      modelId,
      origin: "AI_EDITOR",
      ...(context ? { userInputMessageContext: context } : {}),
      ...(message.images?.length ? { images: message.images } : {}),
    },
  }
}

function assistantHistory(message: WorkingMessage): KiroHistoryEntry {
  return {
    assistantResponseMessage: {
      content: message.content || "(empty)",
      ...(message.toolUses?.length ? { toolUses: message.toolUses } : {}),
    },
  }
}

function trimPayload(payload: KiroGeneratePayload, tools: KiroToolSpecification[], options: ConvertOptions, instructions: string, preserveCurrentThinkingPrefix: boolean) {
  let current = payload
  const originalSize = payloadSize(current)
  let finalSize = originalSize
  const originalHistoryEntries = payload.conversationState.history?.length ?? 0
  const limit = payloadSizeLimitBytes(options.payloadSizeLimitBytes)

  if (originalSize > limit && originalHistoryEntries > 0) {
    const trimmed = findTrimmedPayload(payload, tools, options, instructions, limit, preserveCurrentThinkingPrefix)
    current = trimmed.payload
    finalSize = trimmed.size
  }

  if (finalSize > limit) throw new PayloadTooLargeError(`Kiro payload exceeds ${limit} bytes after trimming`)
  const removedHistoryEntries = originalHistoryEntries - (current.conversationState.history?.length ?? 0)
  if (removedHistoryEntries > 0) {
    const notice = {
      originalSize,
      finalSize,
      limit,
      removedHistoryEntries,
      remainingHistoryEntries: current.conversationState.history?.length ?? 0,
    }
    console.warn(trimNoticeText(notice))
    options.onTrim?.(notice)
  }
  return current
}

function findTrimmedPayload(payload: KiroGeneratePayload, tools: KiroToolSpecification[], options: ConvertOptions, instructions: string, limit: number, preserveCurrentThinkingPrefix: boolean): TrimmedPayloadCandidate {
  const history = payload.conversationState.history ?? []
  const trimPoints = historyTrimPoints(history)
  const lastStep = trimPoints.length - 1
  if (lastStep < 1) return { payload, size: payloadSize(payload) }

  const historyMessages = history.map(historyToWorking)
  const currentMessage = currentToWorking(payload)
  let lowerStep = 0
  let upperStep = 1
  let best = buildTrimmedPayloadCandidate(historyMessages, currentMessage, trimPoints[upperStep], tools, options, instructions, preserveCurrentThinkingPrefix)

  while (best.size > limit && upperStep < lastStep) {
    lowerStep = upperStep
    upperStep = Math.min(upperStep * 2, lastStep)
    best = buildTrimmedPayloadCandidate(historyMessages, currentMessage, trimPoints[upperStep], tools, options, instructions, preserveCurrentThinkingPrefix)
  }

  if (best.size > limit) return best

  let low = lowerStep + 1
  let high = upperStep - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = buildTrimmedPayloadCandidate(historyMessages, currentMessage, trimPoints[mid], tools, options, instructions, preserveCurrentThinkingPrefix)
    if (candidate.size <= limit) {
      best = candidate
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return best
}

function buildTrimmedPayloadCandidate(historyMessages: WorkingMessage[], currentMessage: WorkingMessage, removedHistoryEntries: number, tools: KiroToolSpecification[], options: ConvertOptions, instructions: string, preserveCurrentThinkingPrefix: boolean): TrimmedPayloadCandidate {
  const candidateHistory = historyMessages.slice(removedHistoryEntries).map(cloneWorkingMessage)
  const repaired = repairOrphanedToolResults(candidateHistory, cloneWorkingMessage(currentMessage))
  embedInstructions(repaired.historyMessages, repaired.currentMessage, instructions, preserveCurrentThinkingPrefix)
  ensureHistoryContent(repaired.historyMessages)
  const candidate = buildPayload(repaired.historyMessages, repaired.currentMessage, tools, options)
  return { payload: candidate, size: payloadSize(candidate) }
}

function cloneWorkingMessage(message: WorkingMessage): WorkingMessage {
  return {
    ...message,
    toolUses: message.toolUses ? [...message.toolUses] : undefined,
    toolResults: message.toolResults ? [...message.toolResults] : undefined,
    images: message.images ? [...message.images] : undefined,
  }
}

function historyTrimPoints(history: KiroHistoryEntry[]) {
  const points = [0]
  for (let index = 0; index < history.length;) {
    index += history[index] && "userInputMessage" in history[index] && history[index + 1] && "assistantResponseMessage" in history[index + 1] ? 2 : 1
    points.push(Math.min(index, history.length))
  }
  return points
}

function payloadSizeLimitBytes(override: number | undefined) {
  return typeof override === "number" && Number.isFinite(override) && override > 0 ? Math.floor(override) : kiroPayloadSizeLimitBytes()
}

export function trimNoticeText(notice: KiroPayloadTrimNotice) {
  return [
    "[Gateway warning] Kiro request context was shortened because the payload exceeded the upstream size limit.",
    `Omitted ${notice.removedHistoryEntries} older history entr${notice.removedHistoryEntries === 1 ? "y" : "ies"}; payload size went from ${notice.originalSize} to ${notice.finalSize} bytes (limit ${notice.limit}).`,
    "The latest user message was kept. If the answer misses earlier details, resend the relevant context.",
  ].join(" ")
}

function historyToWorking(entry: KiroHistoryEntry): WorkingMessage {
  if ("assistantResponseMessage" in entry) return { role: "assistant", content: entry.assistantResponseMessage.content, toolUses: entry.assistantResponseMessage.toolUses }
  return {
    role: "user",
    content: entry.userInputMessage.content,
    toolResults: entry.userInputMessage.userInputMessageContext?.toolResults,
    images: entry.userInputMessage.images,
  }
}

function currentToWorking(payload: KiroGeneratePayload): WorkingMessage {
  const input = payload.conversationState.currentMessage.userInputMessage
  return { role: "user", content: input.content, toolResults: input.userInputMessageContext?.toolResults, images: input.images }
}

function payloadSize(payload: KiroGeneratePayload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8")
}

function functionCallToToolUse(item: JsonObject): KiroToolUse | undefined {
  if (typeof item.call_id !== "string" || typeof item.name !== "string") return
  return {
    toolUseId: item.call_id,
    name: item.name,
    input: parseJsonObject(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})),
  }
}

function functionOutputToToolResult(item: JsonObject): KiroToolResult {
  const output = typeof item.output === "string" && item.output.length ? item.output : "(empty result)"
  return { toolUseId: typeof item.call_id === "string" ? item.call_id : `toolu_${crypto.randomUUID().replace(/-/g, "")}`, content: [{ text: output }], status: "success" }
}

function toolUseToText(toolUse: KiroToolUse) {
  return `[Tool: ${toolUse.name} (${toolUse.toolUseId})]\n${JSON.stringify(toolUse.input)}`
}

function toolResultToText(result: KiroToolResult) {
  const text = result.content.map((item) => item.text).filter(Boolean).join("\n") || "(empty result)"
  return `[Tool Result (${result.toolUseId})]\n${text}`
}

function textFromContent(item: JsonObject) {
  if (typeof item.text === "string") return item.text
  if (typeof item.output_text === "string") return item.output_text
  if (typeof item.input_text === "string") return item.input_text
  return ""
}

function inputImageToKiroImage(item: JsonObject): KiroImage | undefined {
  if (typeof item.image_url !== "string") return
  const match = item.image_url.match(/^data:image\/([^;]+);base64,(.+)$/)
  if (!match) return
  return { format: match[1], source: { bytes: match[2] } }
}

function inputFileToText(item: JsonObject) {
  const filename = typeof item.filename === "string" ? item.filename : "document"
  if (typeof item.file_data === "string") {
    const match = item.file_data.match(/^data:([^;]+);base64,(.+)$/)
    if (match && isTextMediaType(match[1])) return `Document: ${filename}\n\n${Buffer.from(match[2], "base64").toString("utf8")}`
    console.warn(`Skipping binary document "${filename}" because Kiro does not support binary file attachments`)
    return `[Unsupported: binary document "${filename}" skipped — Kiro does not support binary file attachments]`
  }
  console.warn(`Skipping document "${filename}" because Kiro does not support URL-based or file-ID-based file attachments`)
  return `[Unsupported: document "${filename}" skipped — Kiro does not support URL-based or file-ID-based file attachments]`
}

function isTextMediaType(mediaType: string) {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml" || mediaType === "application/javascript"
}

function appendText(content: string, addition: string) {
  if (!addition) return content
  if (!content) return addition
  return `${content}\n\n${addition}`
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {}
  return {}
}

function isServerToolContent(item: JsonObject) {
  return item.type === "server_tool" || item.type === "web_search" || item.type === "mcp_call" || item.type === "mcp_call_output"
}

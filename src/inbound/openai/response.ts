import type {
  Canonical_ContentBlock,
  Canonical_Event,
  Canonical_FeatureNotice,
  Canonical_Response,
  Canonical_StreamResponse,
  Canonical_ToolCallBlock,
  Canonical_Usage,
} from "../../core/canonical"
import type { JsonObject } from "../../core/types"
import { canonicalInputTokenTotal, mergeCanonicalUsage } from "../../core/usage"
import type { StreamTelemetryCollector } from "../../core/stream-telemetry"
import { OPENAI_WARNING_SEPARATOR, prependOpenAIWarning, renderOpenAIFeatureWarning } from "./notice"

export function openAICanonicalResponse(response: Canonical_Response, pathname: string, request: JsonObject, options?: { featureNotices?: boolean }): Response {
  if (isChatPath(pathname)) return Response.json(canonicalResponseToChatCompletion(response, options))
  return Response.json(canonicalResponseToResponsesBody(response, request, options))
}

export function openAICanonicalStreamResponse(response: Canonical_StreamResponse, pathname: string, request: JsonObject, options?: { telemetry?: StreamTelemetryCollector; featureNotices?: boolean }): Response {
  if (isChatPath(pathname)) return chatCompletionStreamResponse(response, options?.telemetry, options?.featureNotices)
  return responsesStreamResponse(response, request, options?.telemetry, options?.featureNotices)
}

/**
 * `featureNotices` is the resolved `NATIVE_FEATURE_NOTICES` value, threaded from the composition
 * root rather than read here (design decision D3). Default **off**: the notice list is emptied
 * before rendering, so every downstream branch takes the "no degrade notice" path Requirement 9.2
 * already pins as byte-identical to a notice-free body.
 */
export function canonicalResponseToResponsesBody(response: Canonical_Response, request: JsonObject, options?: { featureNotices?: boolean }): JsonObject {
  const output = withResponsesWarning(canonicalContentToResponsesOutput(response.content), renderOpenAIFeatureWarning(options?.featureNotices ? response.featureNotices ?? [] : []))
  const incompleteReason = response.stopReason === "max_tokens" ? "max_output_tokens" : undefined
  return responseObject({
    id: response.id,
    model: response.model,
    status: incompleteReason ? "incomplete" : "completed",
    request,
    output,
    usage: responsesUsage(response.usage),
    incompleteReason,
  })
}

export function canonicalResponseToChatCompletion(response: Canonical_Response, options?: { featureNotices?: boolean }): JsonObject {
  const toolCalls = response.content.filter((block): block is Canonical_ToolCallBlock => block.type === "tool_call")
  // The warning is leading text of the assistant message — the chat-completions equivalent of
  // the Responses `output_text` prefix, and of Claude's `content[0].text` prefix. Requirement
  // 9.6: no field the notice-free body lacks. A tool-call-only response therefore answers with
  // the warning as its `content` instead of `null`, which is the only way the notice reaches a
  // client at all on that shape; with no degrade notice the render is unchanged.
  const text = prependOpenAIWarning(
    response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    renderOpenAIFeatureWarning(options?.featureNotices ? response.featureNotices ?? [] : []),
  )
  const thinking = response.content.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("")
  return {
    id: response.id.replace(/^resp_/, "chatcmpl_"),
    object: "chat.completion",
    created: nowSeconds(),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !text ? null : text,
          ...(thinking ? { reasoning_content: thinking } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls.map(chatToolCall) } : {}),
        },
        finish_reason: chatFinishReason(response.stopReason, toolCalls.length > 0),
      },
    ],
    usage: chatUsage(response.usage),
  }
}

function responsesStreamResponse(response: Canonical_StreamResponse, request: JsonObject, telemetry?: StreamTelemetryCollector, featureNotices?: boolean): Response {
  const encoder = new TextEncoder()
  const id = response.id
  const model = response.model || stringOr(request.model, "unknown")
  const created = nowSeconds()
  const output: Array<JsonObject | undefined> = []
  const toolStates = new Map<string, { id: string; callId: string; name: string; arguments: string; done: boolean; outputIndex: number }>()
  let iterator: AsyncIterator<Canonical_Event> | undefined
  let closed = false
  let messageId = `msg_${id.replace(/^resp_/, "")}`
  let messageStarted = false
  let messageDone = false
  let messageDoneItem: JsonObject | undefined
  let text = ""
  // Notices decided while the payload was built arrive before any content, so they wait here
  // until the first text of the message block goes out (design D2's `pendingWarning`). Ones
  // decided mid-stream stay here until the stream ends and then trail the text block.
  const pendingNotices: Canonical_FeatureNotice[] = []
  // Exactly what was prefixed onto `text`, so `doneSuffix()` keeps comparing model text with
  // model text. Empty whenever no warning was placed, which makes every use below an identity.
  let warningPrefix = ""
  let reasoningId = `rs_${crypto.randomUUID().replace(/-/g, "")}`
  let reasoningStarted = false
  let reasoningDone = false
  let reasoningText = ""
  let usage: JsonObject | null = null
  let accumulatedUsage: Canonical_Usage | undefined
  let stopReason = "end_turn"
  let incompleteReason: string | undefined
  let completionOutputOverride: JsonObject[] | undefined

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(event: string, data: JsonObject) {
          if (closed) return
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }

        async function sendTextDeltas(itemId: string, outputIndex: number, contentIndex: number, delta: string) {
          const parts = textDeltaChunks(delta)
          for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index]
            send("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: itemId,
              output_index: outputIndex,
              content_index: contentIndex,
              delta: part,
            })
            if (index < parts.length - 1) await streamFlushYield()
          }
        }

        function hasOutputState() {
          return messageStarted || reasoningStarted || toolStates.size > 0 || output.some(Boolean)
        }

        /** Renders and clears the pending notices. `""` when they were all `emulate`. */
        function takePendingWarning() {
          if (!pendingNotices.length) return ""
          const warning = renderOpenAIFeatureWarning(pendingNotices)
          pendingNotices.length = 0
          return warning
        }

        /** Model text emitted so far, warning removed. Identity while `warningPrefix` is empty. */
        function modelText() {
          return warningPrefix && text.startsWith(warningPrefix) ? text.slice(warningPrefix.length) : text
        }

        /**
         * Flushes the pending warning immediately in front of the first text this message block
         * emits, through the ordinary `response.output_text.delta` channel — no new event name.
         * A block that has already spoken is left alone; those notices trail the stream instead.
         */
        async function flushWarningBeforeText() {
          if (text) return
          const warning = takePendingWarning()
          if (!warning) return
          warningPrefix = `${warning}${OPENAI_WARNING_SEPARATOR}`
          text = warningPrefix
          await sendTextDeltas(messageId, output.length, 0, warningPrefix)
        }

        /**
         * Last chance for a notice decided after the text started (design D2's ordering rule for
         * late notices): it trails the current text block rather than splitting it. Runs once,
         * after the event loop and before the block is finished, so nothing reconciles against it.
         */
        async function flushTrailingWarning() {
          const warning = takePendingWarning()
          if (!warning) return
          if (messageStarted && !messageDone) {
            const segment = text ? `${OPENAI_WARNING_SEPARATOR}${warning}` : warning
            text += segment
            await sendTextDeltas(messageId, output.length, 0, segment)
            return
          }
          // Nothing carried text this turn, so a message block is created for the warning —
          // the streaming counterpart of the non-streaming "only if the response has none".
          ensureMessageStarted()
          text = warning
          await sendTextDeltas(messageId, output.length, 0, warning)
        }

        /**
         * Places the pending warning as leading text of a completed message item, for the paths
         * that receive whole items instead of deltas. Items with no text part are left untouched
         * so the notice can still land on a text-carrying item later, or trail the stream.
         */
        function warnedMessageItem(message: JsonObject): JsonObject {
          if (!pendingNotices.length) return message
          const content = Array.isArray(message.content) ? message.content : []
          const partIndex = content.findIndex((part) => isJsonObject(part) && part.type === "output_text")
          if (partIndex < 0) return message
          const warning = takePendingWarning()
          if (!warning) return message
          const part = content[partIndex] as JsonObject
          const partText = typeof part.text === "string" ? part.text : ""
          // Recorded for `withStreamedWarning()`: this item can still be replaced at stream end
          // by the upstream's own copy, which never saw the warning.
          warningPrefix = partText ? `${warning}${OPENAI_WARNING_SEPARATOR}` : warning
          const warnedContent = [...content]
          warnedContent[partIndex] = { ...part, text: prependOpenAIWarning(partText, warning) }
          return { ...message, content: warnedContent }
        }

        /**
         * Keeps the warning the deltas carried in the `response.completed` body too.
         * `mergeCompletionOutput()` can replace the streamed message item with the upstream's own
         * final item, which never saw the prefix. Idempotent — an item that kept the prefix is
         * returned untouched, so the warning appears exactly once either way.
         */
        function withStreamedWarning(items: JsonObject[]): JsonObject[] {
          if (!warningPrefix) return items
          for (const [index, item] of items.entries()) {
            if (item.type !== "message" || !Array.isArray(item.content)) continue
            const partIndex = item.content.findIndex((part) => isJsonObject(part) && part.type === "output_text")
            if (partIndex < 0) continue
            const part = item.content[partIndex] as JsonObject
            const partText = typeof part.text === "string" ? part.text : ""
            if (partText.startsWith(warningPrefix)) return items
            const content = [...item.content]
            content[partIndex] = { ...part, text: `${warningPrefix}${partText}` }
            const warned = [...items]
            warned[index] = { ...item, content }
            return warned
          }
          return items
        }

        async function emitCompletedOutputItem(item: JsonObject) {
          const outputIndex = output.length
          if (item.type === "message") {
            const message = warnedMessageItem(completedMessageOutputItem(item))
            send("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...message, status: "in_progress", content: [] },
            })
            const content = Array.isArray(message.content) ? message.content : []
            for (const [contentIndex, part] of content.entries()) {
              if (!isJsonObject(part)) continue
              send("response.content_part.added", {
                type: "response.content_part.added",
                item_id: String(message.id),
                output_index: outputIndex,
                content_index: contentIndex,
                part: part.type === "output_text" ? { ...part, text: "" } : part,
              })
              if (part.type === "output_text" && typeof part.text === "string") {
                await sendTextDeltas(String(message.id), outputIndex, contentIndex, part.text)
                send("response.output_text.done", {
                  type: "response.output_text.done",
                  item_id: String(message.id),
                  output_index: outputIndex,
                  content_index: contentIndex,
                  text: part.text,
                })
              }
              send("response.content_part.done", {
                type: "response.content_part.done",
                item_id: String(message.id),
                output_index: outputIndex,
                content_index: contentIndex,
                part,
              })
            }
            send("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: message,
            })
            output.push(message)
            return
          }

          if (item.type === "function_call") {
            const tool = completedFunctionCallOutputItem(item)
            send("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...tool, status: "in_progress" },
            })
            send("response.function_call_arguments.done", {
              type: "response.function_call_arguments.done",
              item_id: String(tool.id),
              output_index: outputIndex,
              arguments: String(tool.arguments ?? ""),
            })
            send("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: tool,
            })
            output.push(tool)
            stopReason = "tool_use"
            return
          }

          const outputItem = completedResponseOutputItem(item)
          send("response.output_item.added", {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...outputItem, status: "in_progress" },
          })
          send("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: outputItem,
          })
          output.push(outputItem)
        }

        function ensureMessageStarted() {
          finishReasoning()
          if (messageStarted && !messageDone) return
          if (messageDone) {
            messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`
            messageStarted = false
            messageDone = false
            messageDoneItem = undefined
            text = ""
            // The prefix belongs to the block that carried it; a fresh block starts unwarned.
            warningPrefix = ""
          }
          messageStarted = true
          send("response.output_item.added", {
            type: "response.output_item.added",
            output_index: output.length,
            item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
          })
          send("response.content_part.added", {
            type: "response.content_part.added",
            item_id: messageId,
            output_index: output.length,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          })
        }

        function finishMessage() {
          if (!messageStarted || messageDone) return
          const outputIndex = output.length
          const item = messageDoneItem ? completedStreamMessageOutputItem(messageId, text, messageDoneItem) : messageOutputItem(messageId, text)
          send("response.output_text.done", {
            type: "response.output_text.done",
            item_id: messageId,
            output_index: outputIndex,
            content_index: 0,
            text,
          })
          send("response.content_part.done", {
            type: "response.content_part.done",
            item_id: messageId,
            output_index: outputIndex,
            content_index: 0,
            part: Array.isArray(item.content) && isJsonObject(item.content[0]) ? item.content[0] : { type: "output_text", text, annotations: [] },
          })
          send("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          })
          output.push(item)
          messageDone = true
        }

        function ensureReasoningStarted() {
          if (reasoningStarted && !reasoningDone) return
          if (reasoningDone) {
            reasoningId = `rs_${crypto.randomUUID().replace(/-/g, "")}`
            reasoningStarted = false
            reasoningDone = false
            reasoningText = ""
          }
          finishMessage()
          reasoningStarted = true
          send("response.output_item.added", {
            type: "response.output_item.added",
            output_index: output.length,
            item: { id: reasoningId, type: "reasoning", status: "in_progress", summary: [] },
          })
        }

        function finishReasoning() {
          if (!reasoningStarted || reasoningDone) return
          const outputIndex = output.length
          const item = { ...reasoningOutputItem(reasoningText), id: reasoningId }
          send("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          })
          output.push(item)
          reasoningDone = true
        }

        function ensureToolStarted(callId: string, name: string) {
          finishReasoning()
          let state = toolStates.get(callId)
          if (state) {
            if (state.name === "unknown" && name !== "unknown") state.name = name
            return state
          }
          finishMessage()
          const outputIndex = output.length
          output.push(undefined)
          state = { id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, callId, name, arguments: "", done: false, outputIndex }
          toolStates.set(callId, state)
          send("response.output_item.added", {
            type: "response.output_item.added",
            output_index: state.outputIndex,
            item: functionCallOutputItem(state, "in_progress"),
          })
          return state
        }

        function finishTool(state: { id: string; callId: string; name: string; arguments: string; done: boolean; outputIndex: number }) {
          if (state.done) return
          state.done = true
          send("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: state.id,
            output_index: state.outputIndex,
            arguments: state.arguments,
          })
          const item = functionCallOutputItem(state)
          send("response.output_item.done", {
            type: "response.output_item.done",
            output_index: state.outputIndex,
            item,
          })
          output[state.outputIndex] = item
        }

        async function repairCurrentMessageFromItem(item: JsonObject) {
          if (!messageStarted || messageDone || item.type !== "message") return
          const message = completedMessageOutputItem(item)
          const doneText = outputTextFromOutput([message])
          if (doneText) await flushWarningBeforeText()
          const delta = doneSuffix(modelText(), doneText)
          if (delta) {
            text += delta
            await sendTextDeltas(messageId, output.length, 0, delta)
          } else if (doneText && doneText !== modelText()) {
            text = `${warningPrefix}${doneText}`
          }
          if (Array.isArray(message.content) && message.content.length) messageDoneItem = message
        }

        async function reconcileCompletionOutputItems(items: JsonObject[]) {
          const emittedMessageCount = output.filter((item) => isJsonObject(item) && item.type === "message").length
          let messageIndex = 0
          let repairedOpenMessage = false

          for (const item of items) {
            if (item.type === "message") {
              const shouldSkipCompletedMessage = messageIndex < emittedMessageCount
              messageIndex += 1
              if (shouldSkipCompletedMessage) continue
              if (messageStarted && !messageDone && !repairedOpenMessage) {
                await repairCurrentMessageFromItem(item)
                finishMessage()
                repairedOpenMessage = true
                continue
              }
              if (!output.some((existing) => isJsonObject(existing) && sameOutputItem(existing, completedMessageOutputItem(item)))) {
                finishReasoning()
                await emitCompletedOutputItem(item)
              }
              continue
            }

            if (item.type === "function_call") {
              await repairToolFromItem(item, true)
              continue
            }

            if (item.type === "reasoning" && reasoningStarted && !reasoningDone) {
              finishReasoning()
              continue
            }

            const completed = completedResponseOutputItem(item)
            if (output.some((existing) => isJsonObject(existing) && sameOutputItem(existing, completed))) continue
            finishMessage()
            finishReasoning()
            await emitCompletedOutputItem(completed)
          }
        }

        async function emitMessageItemDone(item: JsonObject) {
          const message = completedMessageOutputItem(item)
          if (output.some((existing) => isJsonObject(existing) && sameOutputItem(existing, message))) return
          finishReasoning()
          await emitCompletedOutputItem(message)
        }

        async function repairToolFromItem(item: JsonObject, finish: boolean) {
          if (item.type !== "function_call") return
          const tool = completedFunctionCallOutputItem(item)
          const callId = typeof tool.call_id === "string" ? tool.call_id : String(tool.id)
          const argumentsText = typeof tool.arguments === "string" ? tool.arguments : ""
          const state = toolStates.get(callId)
          if (state) {
            if (typeof item.id === "string") state.id = item.id
            if (state.name === "unknown" && typeof tool.name === "string" && tool.name !== "unknown") state.name = tool.name
            const delta = doneSuffix(state.arguments, argumentsText)
            if (delta && !state.done) {
              state.arguments += delta
              send("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                item_id: state.id,
                output_index: state.outputIndex,
                delta,
              })
            } else if (!state.done && argumentsText && argumentsText !== state.arguments) {
              state.arguments = argumentsText
            } else if (state.done && argumentsText) {
              state.arguments = argumentsText
            }
            if (state.done) output[state.outputIndex] = functionCallOutputItem(state)
            if (finish) finishTool(state)
            stopReason = "tool_use"
            return
          }
          if (output.some((existing) => isJsonObject(existing) && existing.type === "function_call" && existing.call_id === callId)) return
          finishMessage()
          finishReasoning()
          await emitCompletedOutputItem(tool)
        }

        send("response.created", {
          type: "response.created",
          response: responseObject({ id, model, status: "in_progress", created, request, output: [], usage: null }),
        })
        send("response.in_progress", {
          type: "response.in_progress",
          response: responseObject({ id, model, status: "in_progress", created, request, output: [], usage: null }),
        })

        try {
          iterator = response.events[Symbol.asyncIterator]()
          while (true) {
            const chunk = await iterator.next()
            if (chunk.done) break
            const event = chunk.value

            if (event.type === "text_delta") {
              ensureMessageStarted()
              await flushWarningBeforeText()
              text += event.delta
              await sendTextDeltas(messageId, output.length, 0, event.delta)
              continue
            }
            if (event.type === "text_done") {
              ensureMessageStarted()
              await flushWarningBeforeText()
              const delta = doneSuffix(modelText(), event.text)
              if (delta) {
                text += delta
                await sendTextDeltas(messageId, output.length, 0, delta)
              } else if (event.text && event.text !== modelText()) {
                text = `${warningPrefix}${event.text}`
              }
              continue
            }
            if (event.type === "tool_call_delta") {
              const state = ensureToolStarted(event.callId, event.name)
              state.arguments += event.argumentsDelta
              send("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                item_id: state.id,
                output_index: state.outputIndex,
                delta: event.argumentsDelta,
              })
              continue
            }
            if (event.type === "tool_call_done") {
              const state = ensureToolStarted(event.callId, event.name)
              const delta = doneSuffix(state.arguments, event.arguments)
              state.arguments = delta ? state.arguments + delta : event.arguments || state.arguments
              finishTool(state)
              stopReason = "tool_use"
              continue
            }
            if (event.type === "server_tool_block") {
              finishMessage()
              finishReasoning()
              for (const block of event.blocks) {
                await emitCompletedOutputItem(block)
              }
              continue
            }
            if (event.type === "thinking_delta") {
              ensureReasoningStarted()
              reasoningText += event.text ?? event.label ?? ""
              continue
            }
            if (event.type === "thinking_signature") {
              continue
            }
            if (event.type === "feature_notice") {
              // Token- and content-neutral (Requirement 8.4): the notice is recorded and queued,
              // and nothing is flushed, started or stopped here — a notice between two text
              // deltas must not split the text block.
              // Telemetry first, visibility gate second: switching the client-facing rendering
              // off must not cost the operator the record (`/logs`) or the harness its
              // observation. Only the queue feeding the rendered segment is skipped.
              telemetry?.recordFeatureNotice(event)
              if (featureNotices) pendingNotices.push({ feature: event.feature, policy: event.policy, detail: event.detail })
              continue
            }
            if (event.type === "usage") {
              accumulatedUsage = mergeStreamUsage(accumulatedUsage, event.usage)
              usage = responsesUsage(accumulatedUsage)
              // Provider spend rides the usage channel but is not a token count, so it goes
              // to telemetry only and never into the OpenAI wire usage block.
              if (typeof event.usage.providerCredits === "number") telemetry?.recordProviderCredits(event.usage.providerCredits)
              continue
            }
            if (event.type === "message_stop") {
              stopReason = event.stopReason
              if (event.stopReason === "max_tokens") incompleteReason = "max_output_tokens"
              continue
            }
            if (event.type === "completion") {
              if (event.usage) {
                accumulatedUsage = mergeStreamUsage(accumulatedUsage, event.usage)
                usage = responsesUsage(accumulatedUsage)
                if (typeof event.usage.providerCredits === "number") telemetry?.recordProviderCredits(event.usage.providerCredits)
              }
              if (event.stopReason) stopReason = event.stopReason
              if (event.incompleteReason) incompleteReason = event.incompleteReason
              const completionOutput = responseOutputItems(event.output)
              if (completionOutput.length) completionOutputOverride = completionOutput
              if (completionOutput.length && !hasOutputState()) {
                for (const item of completionOutput) await emitCompletedOutputItem(item)
              } else if (completionOutput.length) {
                await reconcileCompletionOutputItems(completionOutput)
              }
              continue
            }
            if (event.type === "message_item_done") {
              if (!hasOutputState()) {
                await emitCompletedOutputItem(event.item)
              } else if (event.item.type === "message") {
                if (messageStarted && !messageDone) {
                  await repairCurrentMessageFromItem(event.item)
                  finishMessage()
                } else {
                  await emitMessageItemDone(event.item)
                }
              } else if (event.item.type === "function_call") {
                await repairToolFromItem(event.item, true)
              }
              continue
            }
            if (event.type === "error") {
              send("error", { type: "error", error: { message: event.message } })
              closed = true
              controller.close()
              return
            }
          }

          await flushTrailingWarning()
          finishReasoning()
          finishMessage()
          for (const state of toolStates.values()) finishTool(state)
          const streamedOutput = compactOutput(output)
          const mergedOutput = completionOutputOverride ? mergeCompletionOutput(streamedOutput, completionOutputOverride) : streamedOutput
          const completedOutput = withStreamedWarning(mergedOutput)
          const finalIncompleteReason = incompleteReason ?? (stopReason === "max_tokens" ? "max_output_tokens" : undefined)
          send("response.completed", {
            type: "response.completed",
            response: responseObject({
              id,
              model,
              status: finalIncompleteReason ? "incomplete" : "completed",
              created,
              request,
              output: completedOutput,
              usage,
              incompleteReason: finalIncompleteReason,
            }),
          })
          closed = true
          controller.close()
        } catch (error) {
          if (!closed) {
            send("error", { type: "error", error: { message: error instanceof Error ? error.message : String(error) } })
            closed = true
            controller.close()
          }
        }
      },
      cancel(reason) {
        closed = true
        const current = iterator
        iterator = undefined
        void current?.return?.({ type: "lifecycle", label: String(reason ?? "client disconnected") }).catch(() => undefined)
      },
    }),
    streamHeaders(),
  )
}

function chatCompletionStreamResponse(response: Canonical_StreamResponse, telemetry?: StreamTelemetryCollector, featureNotices?: boolean): Response {
  const encoder = new TextEncoder()
  const id = response.id.replace(/^resp_/, "chatcmpl_")
  const created = nowSeconds()
  const model = response.model
  const toolStates = new Map<string, { index: number; id: string; callId: string; name: string; arguments: string }>()
  let iterator: AsyncIterator<Canonical_Event> | undefined
  let closed = false
  let sentRole = false
  let text = ""
  let currentChatMessageText = ""
  // Same `pendingWarning` discipline as the Responses shape: notices queue here and go out in
  // front of the first `content` delta, so the client sees one segment ahead of the model text.
  const pendingNotices: Canonical_FeatureNotice[] = []
  // Exactly what was prefixed onto `currentChatMessageText`, so `doneSuffix()` keeps comparing
  // model text with model text. Empty whenever no warning was placed.
  let warningPrefix = ""
  let usage: JsonObject | undefined
  let accumulatedUsage: Canonical_Usage | undefined
  let stopReason = "stop"
  const completedChatMessageIds = new Set<string>()

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(data: JsonObject | "[DONE]") {
          if (closed) return
          controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
        }

        function chunk(delta: JsonObject, finishReason: string | null = null, chunkUsage: JsonObject | null = null) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(chunkUsage ? { usage: chunkUsage } : {}),
          })
        }

        function roleDelta(delta: JsonObject) {
          if (sentRole) return delta
          sentRole = true
          return { role: "assistant", ...delta }
        }

        async function textChunk(delta: string) {
          if (!delta) return
          const parts = textDeltaChunks(delta)
          for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index]
            text += part
            currentChatMessageText += part
            chunk(roleDelta({ content: part }))
            if (index < parts.length - 1) await streamFlushYield()
          }
        }

        async function reasoningChunk(delta: string) {
          if (!delta) return
          const parts = textDeltaChunks(delta)
          for (let index = 0; index < parts.length; index += 1) {
            chunk(roleDelta({ reasoning_content: parts[index] }))
            if (index < parts.length - 1) await streamFlushYield()
          }
        }

        /** Renders and clears the pending notices. `""` when they were all `emulate`. */
        function takePendingWarning() {
          if (!pendingNotices.length) return ""
          const warning = renderOpenAIFeatureWarning(pendingNotices)
          pendingNotices.length = 0
          return warning
        }

        /** Text of the current message, warning removed. Identity while `warningPrefix` is empty. */
        function modelChatText() {
          return warningPrefix && currentChatMessageText.startsWith(warningPrefix)
            ? currentChatMessageText.slice(warningPrefix.length)
            : currentChatMessageText
        }

        /**
         * Flushes the pending warning in front of the first `content` delta of the response,
         * through the ordinary `chat.completion.chunk` channel — no new field, no new event.
         */
        async function flushWarningBeforeText() {
          if (text) return
          const warning = takePendingWarning()
          if (!warning) return
          warningPrefix = `${warning}${OPENAI_WARNING_SEPARATOR}`
          await textChunk(warningPrefix)
        }

        /**
         * Last chance for a notice decided after the text started: it trails the content rather
         * than splitting it. Runs once, after the event loop, before the final chunk.
         */
        async function flushTrailingWarning() {
          const warning = takePendingWarning()
          if (!warning) return
          await textChunk(text ? `${OPENAI_WARNING_SEPARATOR}${warning}` : warning)
        }

        function toolState(callId: string, name: string) {
          let state = toolStates.get(callId)
          if (state) {
            if (state.name === "unknown" && name !== "unknown") state.name = name
            return state
          }
          state = { index: toolStates.size, id: callId, callId, name, arguments: "" }
          toolStates.set(callId, state)
          return state
        }

        async function emitChatOutputItems(items: JsonObject[]) {
          for (const item of items) {
            if (item.type === "message") {
              await emitChatMessageItem(item)
              continue
            }
            if (item.type === "function_call") {
              emitChatFunctionCallItem(item)
            }
          }
        }

        async function emitChatMessageItem(item: JsonObject) {
          const message = completedMessageOutputItem(item)
          if (typeof message.id === "string" && completedChatMessageIds.has(message.id)) return
          if (typeof message.id === "string") completedChatMessageIds.add(message.id)
          const doneText = outputTextFromOutput([message])
          if (doneText) {
            await flushWarningBeforeText()
            const delta = doneSuffix(modelChatText(), doneText)
            if (delta) {
              await textChunk(delta)
            } else if (!modelChatText() && !text.endsWith(doneText)) {
              await textChunk(doneText)
            }
          }
          currentChatMessageText = ""
        }

        async function reconcileChatOutputItems(items: JsonObject[]) {
          for (const item of items) {
            if (item.type === "message") {
              await emitChatMessageItem(item)
              continue
            }
            if (item.type === "function_call") emitChatFunctionCallItem(item)
          }
        }

        function emitChatFunctionCallItem(item: JsonObject) {
          currentChatMessageText = ""
          const tool = completedFunctionCallOutputItem(item)
          const callId = typeof tool.call_id === "string" ? tool.call_id : String(tool.id)
          const name = typeof tool.name === "string" ? tool.name : "unknown"
          const args = typeof tool.arguments === "string" ? tool.arguments : "{}"
          const previous = toolStates.get(callId)
          const nameChanged = Boolean(previous && previous.name === "unknown" && name !== "unknown")
          const state = toolState(callId, name)
          const delta = previous ? doneSuffix(state.arguments, args) : args
          if (!previous || delta || nameChanged) {
            state.arguments += delta
            chunk(roleDelta({
              tool_calls: [{
                index: state.index,
                id: state.id,
                type: "function",
                function: { name: state.name, ...(!previous || delta ? { arguments: delta } : {}) },
              }],
            }))
          }
          stopReason = "tool_calls"
        }

        try {
          iterator = response.events[Symbol.asyncIterator]()
          while (true) {
            const next = await iterator.next()
            if (next.done) break
            const event = next.value
            if (event.type === "thinking_delta") {
              await reasoningChunk(event.text ?? event.label ?? "")
              continue
            }
            if (event.type === "text_delta") {
              if (event.delta) await flushWarningBeforeText()
              await textChunk(event.delta)
              continue
            }
            if (event.type === "text_done") {
              if (event.text) await flushWarningBeforeText()
              const delta = doneSuffix(modelChatText(), event.text)
              if (delta) {
                await textChunk(delta)
              } else if (!modelChatText() && event.text && !text.endsWith(event.text)) {
                await textChunk(event.text)
              }
              continue
            }
            if (event.type === "tool_call_delta") {
              currentChatMessageText = ""
              const state = toolState(event.callId, event.name)
              state.arguments += event.argumentsDelta
              chunk(roleDelta({
                tool_calls: [{
                  index: state.index,
                  id: state.id,
                  type: "function",
                  function: { name: state.name, arguments: event.argumentsDelta },
                }],
              }))
              stopReason = "tool_calls"
              continue
            }
            if (event.type === "tool_call_done") {
              emitChatFunctionCallItem({ type: "function_call", call_id: event.callId, name: event.name, arguments: event.arguments })
              continue
            }
            if (event.type === "feature_notice") {
              // Token- and content-neutral (Requirement 8.4): recorded and queued, nothing
              // emitted here, so a notice between two deltas cannot split the content stream.
              // Telemetry first, visibility gate second: switching the client-facing rendering
              // off must not cost the operator the record (`/logs`) or the harness its
              // observation. Only the queue feeding the rendered segment is skipped.
              telemetry?.recordFeatureNotice(event)
              if (featureNotices) pendingNotices.push({ feature: event.feature, policy: event.policy, detail: event.detail })
              continue
            }
            if (event.type === "usage") {
              accumulatedUsage = mergeStreamUsage(accumulatedUsage, event.usage)
              usage = chatUsage(accumulatedUsage)
              // Provider spend rides the usage channel but is not a token count, so it goes
              // to telemetry only and never into the OpenAI wire usage block.
              if (typeof event.usage.providerCredits === "number") telemetry?.recordProviderCredits(event.usage.providerCredits)
              continue
            }
            if (event.type === "message_stop") {
              stopReason = chatFinishReason(event.stopReason, toolStates.size > 0)
              continue
            }
            if (event.type === "completion") {
              const completionOutput = responseOutputItems(event.output)
              if (completionOutput.length && !sentRole && !text && toolStates.size === 0) {
                await emitChatOutputItems(completionOutput)
              } else if (completionOutput.length) {
                await reconcileChatOutputItems(completionOutput)
              }
              if (event.usage) {
                accumulatedUsage = mergeStreamUsage(accumulatedUsage, event.usage)
                usage = chatUsage(accumulatedUsage)
                if (typeof event.usage.providerCredits === "number") telemetry?.recordProviderCredits(event.usage.providerCredits)
              }
              if (event.stopReason) stopReason = chatFinishReason(event.stopReason, toolStates.size > 0)
              else if (event.incompleteReason === "max_output_tokens") stopReason = "length"
              continue
            }
            if (event.type === "message_item_done") {
              if (!sentRole && !text && toolStates.size === 0) {
                await emitChatOutputItems([event.item])
                continue
              }
              if (event.item.type === "function_call") {
                emitChatFunctionCallItem(event.item)
                continue
              }
              if (event.item.type === "message") await emitChatMessageItem(event.item)
              continue
            }
            if (event.type === "error") {
              send({ error: { message: event.message } })
              send("[DONE]")
              closed = true
              controller.close()
              return
            }
          }

          await flushTrailingWarning()
          if (!sentRole) chunk({ role: "assistant" })
          chunk({}, stopReason, usage ?? chatUsage({ inputTokens: 0, outputTokens: 0 }))
          send("[DONE]")
          closed = true
          controller.close()
        } catch (error) {
          if (!closed) {
            send({ error: { message: error instanceof Error ? error.message : String(error) } })
            send("[DONE]")
            closed = true
            controller.close()
          }
        }
      },
      cancel(reason) {
        closed = true
        const current = iterator
        iterator = undefined
        void current?.return?.({ type: "lifecycle", label: String(reason ?? "client disconnected") }).catch(() => undefined)
      },
    }),
    streamHeaders(),
  )
}

/**
 * Places a rendered warning as leading text of the first `output_text` part in `output`
 * (Requirement 9.4 — one segment, ahead of the model's first text content).
 *
 * Returns the same array reference when there is no warning, so a notice-free body is
 * byte-identical to the pre-change rendering. When the response carries no text part at all —
 * a tool-call-only turn — a message item is created ahead of the rest, which is the "a text
 * block is created only if the response has none" rule design D2 states for the non-streaming
 * side. No item type appears here that a text-carrying response would not already produce.
 */
function withResponsesWarning(output: JsonObject[], warning: string): JsonObject[] {
  if (!warning) return output

  for (const [index, item] of output.entries()) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue
    const partIndex = item.content.findIndex((part) => isJsonObject(part) && part.type === "output_text")
    if (partIndex < 0) continue
    const part = item.content[partIndex] as JsonObject
    const content = [...item.content]
    content[partIndex] = { ...part, text: prependOpenAIWarning(typeof part.text === "string" ? part.text : "", warning) }
    const warned = [...output]
    warned[index] = { ...item, content }
    return warned
  }

  return [messageOutputItem(`msg_${crypto.randomUUID().replace(/-/g, "")}`, warning), ...output]
}

function canonicalContentToResponsesOutput(content: Canonical_ContentBlock[]): JsonObject[] {
  const output: JsonObject[] = []
  let pendingText: Array<{ text: string; annotations?: JsonObject[] }> = []

  const flushText = () => {
    if (!pendingText.length) return
    output.push(messageOutputItemFromParts(`msg_${crypto.randomUUID().replace(/-/g, "")}`, pendingText))
    pendingText = []
  }

  for (const block of content) {
    if (block.type === "text") {
      pendingText.push({ text: block.text, annotations: block.annotations })
      continue
    }
    flushText()
    if (block.type === "tool_call") output.push(functionCallOutputItem(block))
    else if (block.type === "thinking") output.push(reasoningOutputItem(block.thinking))
    else if (block.type === "server_tool") output.push(...block.blocks.map((item) => ({ ...item, status: "completed" })))
  }

  flushText()
  return output
}

function messageOutputItem(id: string, text: string): JsonObject {
  return messageOutputItemFromParts(id, [{ text }])
}

function messageOutputItemFromParts(id: string, parts: Array<{ text: string; annotations?: JsonObject[] }>): JsonObject {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: parts.map((part) => ({
      type: "output_text",
      text: part.text,
      annotations: Array.isArray(part.annotations) ? part.annotations : [],
    })),
  }
}

function functionCallOutputItem(block: Canonical_ToolCallBlock | { id: string; callId: string; name: string; arguments: string }, status = "completed"): JsonObject {
  return {
    id: block.id,
    type: "function_call",
    call_id: block.callId,
    name: block.name,
    arguments: block.arguments,
    status,
  }
}

function compactOutput(output: Array<JsonObject | undefined>): JsonObject[] {
  return output.filter((item): item is JsonObject => Boolean(item))
}

function mergeCompletionOutput(streamedOutput: JsonObject[], completionOutput: JsonObject[]): JsonObject[] {
  const usedCompletionIndexes = new Set<number>()
  const merged: JsonObject[] = []

  const flushCompletionBefore = (targetIndex: number) => {
    for (let index = 0; index < targetIndex; index += 1) {
      if (usedCompletionIndexes.has(index)) continue
      usedCompletionIndexes.add(index)
      merged.push(completionOutput[index])
    }
  }

  for (const streamedItem of streamedOutput) {
    const replacementIndex = completionOutput.findIndex((candidate, index) =>
      !usedCompletionIndexes.has(index) && replacementMatchesStreamedItem(candidate, streamedItem)
    )
    if (replacementIndex >= 0) {
      flushCompletionBefore(replacementIndex)
      usedCompletionIndexes.add(replacementIndex)
      merged.push(completionOutput[replacementIndex])
      continue
    }
    if (streamedItem.type !== "message" && streamedItem.type !== "function_call") merged.push(streamedItem)
  }

  completionOutput.forEach((item, index) => {
    if (!usedCompletionIndexes.has(index)) merged.push(item)
  })
  return merged
}

function replacementMatchesStreamedItem(candidate: JsonObject, streamedItem: JsonObject) {
  if (sameOutputItem(candidate, streamedItem)) return true
  if (streamedItem.type === "message") return candidate.type === "message"
  if (streamedItem.type === "function_call") return candidate.type === "function_call"
  return false
}

function sameOutputItem(left: JsonObject, right: JsonObject) {
  if (typeof left.id === "string" && typeof right.id === "string" && left.id === right.id) return true
  if (left.type === "function_call" && right.type === "function_call" && typeof left.call_id === "string" && left.call_id === right.call_id) return true
  if (left.type === "reasoning" && right.type === "reasoning") return true
  return false
}

function responseOutputItems(output: unknown): JsonObject[] {
  if (!Array.isArray(output)) return []
  const items = output.filter(isJsonObject)
  const normalized: JsonObject[] = []
  let pendingCanonical: Canonical_ContentBlock[] = []

  const flushCanonical = () => {
    if (!pendingCanonical.length) return
    normalized.push(...canonicalContentToResponsesOutput(pendingCanonical))
    pendingCanonical = []
  }

  for (const item of items) {
    if (isCanonicalContentOutputItem(item)) {
      pendingCanonical.push(item as unknown as Canonical_ContentBlock)
      continue
    }
    flushCanonical()
    normalized.push(completedResponseOutputItem(item))
  }

  flushCanonical()
  return normalized
}

function isCanonicalContentOutputItem(item: JsonObject) {
  return item.type === "text" || item.type === "tool_call" || item.type === "server_tool" || item.type === "thinking"
}

function completedResponseOutputItem(item: JsonObject): JsonObject {
  if (item.type === "message") return completedMessageOutputItem(item)
  if (item.type === "function_call") return completedFunctionCallOutputItem(item)
  return { ...item, status: "completed" }
}

function completedMessageOutputItem(item: JsonObject): JsonObject {
  return {
    id: typeof item.id === "string" ? item.id : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    status: "completed",
    role: typeof item.role === "string" ? item.role : "assistant",
    content: outputContent(item.content),
  }
}

function combinedMessageOutputItem(items: JsonObject[]): JsonObject {
  return { type: "message", content: items.flatMap((item) => outputContent(item.content)) }
}

function completedStreamMessageOutputItem(id: string, text: string, item: JsonObject): JsonObject {
  return messageOutputItemFromParts(id, [{ text, annotations: outputAnnotations(item) }])
}

function outputAnnotations(item: JsonObject): JsonObject[] {
  return outputContent(item.content).flatMap((part) => {
    if (!Array.isArray(part.annotations)) return []
    return part.annotations.filter(isJsonObject)
  })
}

function outputContent(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(outputContentPart)
  return outputContentPart(value)
}

function outputContentPart(part: unknown): JsonObject[] {
  if (typeof part === "string") return [{ type: "output_text", text: part, annotations: [] }]
  if (!isJsonObject(part)) return []
  if (part.type === "output_text") {
    return [{
      ...part,
      text: typeof part.text === "string" ? part.text : "",
      annotations: Array.isArray(part.annotations) ? part.annotations : [],
    }]
  }
  if (part.type === "text" && typeof part.text === "string") return [{ type: "output_text", text: part.text, annotations: [] }]
  if (part.type === "refusal" && typeof part.refusal === "string") return [{ type: "output_text", text: part.refusal, annotations: [] }]
  return [part]
}

function completedFunctionCallOutputItem(item: JsonObject): JsonObject {
  const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${crypto.randomUUID().replace(/-/g, "")}`
  const rawArguments = item.arguments ?? {}
  return {
    id: typeof item.id === "string" ? item.id : `fc_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function_call",
    call_id: callId,
    name: typeof item.name === "string" ? item.name : "unknown",
    arguments: typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments),
    status: "completed",
  }
}

function reasoningOutputItem(text: string): JsonObject {
  return {
    id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text }],
  }
}

function chatToolCall(block: Canonical_ToolCallBlock): JsonObject {
  return {
    id: block.callId,
    type: "function",
    function: {
      name: block.name,
      arguments: block.arguments,
    },
  }
}

function responseObject(options: {
  id: string
  model: string
  status: "in_progress" | "completed" | "incomplete"
  request: JsonObject
  output: JsonObject[]
  usage: JsonObject | null
  created?: number
  incompleteReason?: string
}): JsonObject {
  const created = options.created ?? nowSeconds()
  return {
    id: options.id,
    object: "response",
    created_at: created,
    status: options.status,
    ...(options.status === "completed" ? { completed_at: nowSeconds() } : {}),
    error: null,
    incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    instructions: typeof options.request.instructions === "string" ? options.request.instructions : null,
    max_output_tokens: numberOrNull(options.request.max_output_tokens ?? options.request.max_completion_tokens),
    model: options.model,
    output: options.output,
    parallel_tool_calls: options.request.parallel_tool_calls ?? true,
    previous_response_id: options.request.previous_response_id ?? null,
    reasoning: requestReasoning(options.request),
    store: options.request.store ?? true,
    temperature: options.request.temperature ?? 1,
    text: requestText(options.request),
    tool_choice: options.request.tool_choice ?? "auto",
    tools: Array.isArray(options.request.tools) ? options.request.tools : [],
    top_p: options.request.top_p ?? 1,
    truncation: options.request.truncation ?? "disabled",
    usage: options.usage,
    user: options.request.user ?? null,
    metadata: isJsonObject(options.request.metadata) ? options.request.metadata : {},
  }
}

function responsesUsage(usage: Partial<Canonical_Usage> | undefined): JsonObject {
  const inputTokens = canonicalInputTokenTotal(usage)
  const outputTokens = usage?.outputTokens ?? 0
  const cachedTokens = usage?.cacheReadInputTokens ?? 0
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: usage?.outputReasoningTokens ?? 0 },
    total_tokens: inputTokens + outputTokens,
  }
}

function chatUsage(usage: Partial<Canonical_Usage> | undefined): JsonObject {
  const inputTokens = canonicalInputTokenTotal(usage)
  const outputTokens = usage?.outputTokens ?? 0
  const cachedTokens = usage?.cacheReadInputTokens ?? 0
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: usage?.outputReasoningTokens ?? 0 },
  }
}

function mergeStreamUsage(current: Canonical_Usage | undefined, next: Partial<Canonical_Usage>) {
  const merged = current ?? { inputTokens: 0, outputTokens: 0 }
  mergeCanonicalUsage(merged, next)
  return merged
}

function outputTextFromOutput(output: JsonObject[]) {
  return output.flatMap((item) => {
    const content = Array.isArray(item.content) ? item.content : []
    return content.flatMap((block) => isJsonObject(block) && block.type === "output_text" && typeof block.text === "string" ? [block.text] : [])
  }).join("")
}

function chatFinishReason(stopReason: string, hasToolCalls: boolean) {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls"
  if (stopReason === "max_tokens") return "length"
  return "stop"
}

function doneSuffix(current: string, done: string) {
  if (!done) return ""
  if (!current) return done
  return done.startsWith(current) ? done.slice(current.length) : ""
}

const STREAM_TEXT_DELTA_TARGET_LENGTH = 64

function textDeltaChunks(text: string): string[] {
  const chars = Array.from(text)
  if (!chars.length) return []
  if (chars.length <= STREAM_TEXT_DELTA_TARGET_LENGTH) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = Math.min(start + STREAM_TEXT_DELTA_TARGET_LENGTH, chars.length)
    if (end < chars.length) {
      for (let index = end - 1; index > start + STREAM_TEXT_DELTA_TARGET_LENGTH / 2; index -= 1) {
        if (/\s/.test(chars[index])) {
          end = index + 1
          break
        }
      }
    }
    chunks.push(chars.slice(start, end).join(""))
    start = end
  }
  return chunks
}

function streamFlushYield() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function requestText(request: JsonObject): JsonObject {
  if (isJsonObject(request.text)) return request.text
  if (isJsonObject(request.response_format)) return { format: request.response_format }
  return { format: { type: "text" } }
}

function requestReasoning(request: JsonObject): JsonObject {
  if (isJsonObject(request.reasoning)) return { effort: request.reasoning.effort ?? null, summary: request.reasoning.summary ?? null }
  return { effort: typeof request.reasoning_effort === "string" ? request.reasoning_effort : null, summary: null }
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : null
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback
}

function isChatPath(pathname: string) {
  return pathname === "/v1/chat/completions"
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function streamHeaders() {
  return {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  }
}

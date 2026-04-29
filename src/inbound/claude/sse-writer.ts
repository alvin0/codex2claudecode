import type { JsonObject } from "../types"

/**
 * Claude SSE block writer that encapsulates content block index allocation,
 * open block tracking, and mid-stream error recovery.
 *
 * Provides typed helpers for all Claude SSE event types and ensures
 * valid SSE framing even when upstream exceptions occur after content
 * blocks have started.
 */
export class ClaudeSseWriter {
  private readonly encoder = new TextEncoder()
  private readonly controller: ReadableStreamDefaultController<Uint8Array>
  private closed = false
  private contentIndex = 0
  private textOpen = false
  private thinkingOpen = false

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = controller
  }

  /** Whether the writer has been closed (no more events can be sent). */
  get isClosed(): boolean {
    return this.closed
  }

  /** Current content block index. */
  get currentIndex(): number {
    return this.contentIndex
  }

  /** Whether a text block is currently open. */
  get isTextOpen(): boolean {
    return this.textOpen
  }

  /** Whether a thinking block is currently open. */
  get isThinkingOpen(): boolean {
    return this.thinkingOpen
  }

  /** Next content index that won't collide with already-emitted blocks. */
  nextContentIndex(): number {
    return this.contentIndex
  }

  /** Send a raw SSE event. */
  send(event: string, data: JsonObject): void {
    if (this.closed) return
    try {
      this.controller.enqueue(this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      this.closed = true
    }
  }

  /** Emit message_start event. */
  messageStart(message: JsonObject): void {
    this.send("message_start", { type: "message_start", message })
  }

  /** Open a text content block if not already open. */
  startTextBlock(): void {
    if (this.textOpen) return
    this.textOpen = true
    this.send("content_block_start", {
      type: "content_block_start",
      index: this.contentIndex,
      content_block: { type: "text", text: "" },
    })
  }

  /** Close the current text block if open. */
  stopTextBlock(): void {
    if (!this.textOpen) return
    this.send("content_block_stop", { type: "content_block_stop", index: this.contentIndex })
    this.textOpen = false
    this.contentIndex += 1
  }

  /** Open a thinking content block. Closes text block first if open. */
  startThinkingBlock(signature: string): void {
    if (this.thinkingOpen) return
    this.stopTextBlock()
    this.thinkingOpen = true
    this.send("content_block_start", {
      type: "content_block_start",
      index: this.contentIndex,
      content_block: { type: "thinking", thinking: "", signature },
    })
  }

  /** Close the current thinking block if open, emitting signature delta first. */
  stopThinkingBlock(signature?: string): void {
    if (!this.thinkingOpen) return
    if (signature) {
      this.send("content_block_delta", {
        type: "content_block_delta",
        index: this.contentIndex,
        delta: { type: "signature_delta", signature },
      })
    }
    this.send("content_block_stop", { type: "content_block_stop", index: this.contentIndex })
    this.thinkingOpen = false
    this.contentIndex += 1
  }

  /** Emit a text delta within the current text block. */
  textDelta(text: string): void {
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.contentIndex,
      delta: { type: "text_delta", text },
    })
  }

  /** Emit a thinking delta within the current thinking block. */
  thinkingDelta(thinking: string): void {
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.contentIndex,
      delta: { type: "thinking_delta", thinking },
    })
  }

  /** Emit a complete tool_use content block (start + deltas + stop). */
  toolUseBlock(callId: string, name: string, args: string): void {
    this.stopThinkingBlock()
    this.stopTextBlock()
    this.send("content_block_start", {
      type: "content_block_start",
      index: this.contentIndex,
      content_block: { type: "tool_use", id: callId, name, input: {} },
    })
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.contentIndex,
      delta: { type: "input_json_delta", partial_json: "" },
    })
    this.send("content_block_delta", {
      type: "content_block_delta",
      index: this.contentIndex,
      delta: { type: "input_json_delta", partial_json: args },
    })
    this.send("content_block_stop", { type: "content_block_stop", index: this.contentIndex })
    this.contentIndex += 1
  }

  /** Emit server tool blocks (server_tool_use, web_search_tool_result, mcp_tool_use, etc.). */
  serverToolBlocks(blocks: JsonObject[]): void {
    for (const block of blocks) {
      this.stopTextBlock()
      this.stopThinkingBlock()
      const isServerToolUse = block.type === "server_tool_use" || block.type === "mcp_tool_use"
      this.send("content_block_start", {
        type: "content_block_start",
        index: this.contentIndex,
        content_block: isServerToolUse
          ? {
              type: block.type,
              id: block.id,
              name: block.name,
              ...(block.type === "mcp_tool_use" && { server_name: block.server_name }),
              input: {},
            }
          : block,
      })
      if (isServerToolUse && block.input) {
        this.send("content_block_delta", {
          type: "content_block_delta",
          index: this.contentIndex,
          delta: { type: "input_json_delta", partial_json: "" },
        })
        this.send("content_block_delta", {
          type: "content_block_delta",
          index: this.contentIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        })
      }
      this.send("content_block_stop", { type: "content_block_stop", index: this.contentIndex })
      this.contentIndex += 1
    }
  }

  /** Emit message_delta with final usage and stop reason. */
  messageDelta(stopReason: string, usage: JsonObject): void {
    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    })
  }

  /** Emit message_stop event. */
  messageStop(): void {
    this.send("message_stop", { type: "message_stop" })
  }

  /** Emit a ping event. */
  ping(): void {
    this.send("ping", { type: "ping" })
  }

  /** Emit an error event. */
  error(errorBody: JsonObject): void {
    this.send("error", errorBody)
  }

  /**
   * Close any open content blocks safely. Use this before emitting
   * error events or closing the stream after an exception.
   */
  closeOpenBlocks(thinkingSignature?: string): void {
    this.stopThinkingBlock(thinkingSignature)
    this.stopTextBlock()
  }

  /** Close the underlying stream controller. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.controller.close()
    } catch {
      // Controller already closed or errored — safe to ignore
    }
  }
}

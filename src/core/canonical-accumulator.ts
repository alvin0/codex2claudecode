import type {
  Canonical_ContentBlock,
  Canonical_Event,
  Canonical_Response,
  Canonical_StreamResponse,
  Canonical_ThinkingBlock,
  Canonical_Usage,
} from "./canonical"
import type { JsonObject } from "./types"
import { mergeCanonicalUsage } from "./usage"

/**
 * Accumulates canonical stream events into a final Canonical_Response snapshot.
 *
 * Tracks open text/thinking blocks, tool calls, server tool blocks, usage,
 * and stop reason. Tolerates unknown event types by ignoring them.
 */
export class CanonicalStreamAccumulator {
  private id: string
  private model: string
  private textOpen = false
  private textBuffer = ""
  private thinkingOpen = false
  private thinkingBuffer = ""
  private thinkingSignature = ""
  private content: Canonical_ContentBlock[] = []
  private toolArguments = new Map<string, { name: string; fragments: string[] }>()
  private usage: Canonical_Usage = { inputTokens: 0, outputTokens: 0 }
  private stopReason = "end_turn"
  private hasToolCall = false
  private errored = false

  constructor(id = "", model = "") {
    this.id = id
    this.model = model
  }

  /**
   * Apply a single canonical event to the accumulator state.
   */
  apply(event: Canonical_Event): void {
    switch (event.type) {
      case "message_start":
        this.id = event.id
        this.model = event.model
        break

      case "thinking_signature":
        this.thinkingSignature = event.signature
        break

      case "thinking_delta":
        if (!this.thinkingOpen) {
          this.closeTextBlock()
          this.thinkingOpen = true
        }
        this.thinkingBuffer += event.text ?? event.label ?? ""
        break

      case "text_delta":
        this.closeThinkingBlock()
        if (!this.textOpen) this.textOpen = true
        this.textBuffer += event.delta
        break

      case "text_done":
        // text_done carries the final complete text snapshot — replaces any prior deltas
        this.closeThinkingBlock()
        if (!this.textOpen) this.textOpen = true
        this.textBuffer = event.text
        break

      case "tool_call_delta":
        this.closeThinkingBlock()
        this.closeTextBlock()
        if (!this.toolArguments.has(event.callId)) {
          this.toolArguments.set(event.callId, { name: event.name, fragments: [] })
        }
        this.toolArguments.get(event.callId)!.fragments.push(event.argumentsDelta)
        break

      case "tool_call_done":
        this.closeThinkingBlock()
        this.closeTextBlock()
        this.toolArguments.delete(event.callId)
        this.content.push({
          type: "tool_call",
          id: event.callId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        })
        this.hasToolCall = true
        this.stopReason = "tool_use"
        break

      case "server_tool_block":
        this.closeThinkingBlock()
        this.closeTextBlock()
        this.content.push({ type: "server_tool", blocks: event.blocks })
        break

      case "usage":
        mergeCanonicalUsage(this.usage, event.usage)
        break

      case "completion":
        if (event.usage) mergeCanonicalUsage(this.usage, event.usage)
        if (event.stopReason) this.stopReason = event.stopReason
        break

      case "message_stop":
        if (event.stopReason) this.stopReason = event.stopReason
        break

      case "error":
        this.errored = true
        break

      // Tolerate unknown/unhandled event types
      case "lifecycle":
      case "content_block_start":
      case "content_block_stop":
      case "message_item_done":
        break

      default:
        // Unknown event type — ignore silently
        break
    }
  }

  /**
   * Consume all events from a canonical stream and return the accumulated response.
   */
  async consumeStream(stream: Canonical_StreamResponse): Promise<Canonical_Response> {
    this.id = stream.id
    this.model = stream.model
    for await (const event of stream.events) {
      this.apply(event)
    }
    return this.finalize()
  }

  /**
   * Finalize the accumulator and return a Canonical_Response snapshot.
   * Closes any open blocks and resolves the final stop reason.
   */
  finalize(): Canonical_Response {
    this.closeThinkingBlock()
    this.closeTextBlock()
    this.flushPendingToolCalls()

    if (this.hasToolCall && this.stopReason === "end_turn") {
      this.stopReason = "tool_use"
    }

    return {
      type: "canonical_response",
      id: this.id,
      model: this.model,
      stopReason: this.stopReason,
      content: [...this.content],
      usage: { ...this.usage },
    }
  }

  /** Whether an error event was received. */
  get hasError(): boolean {
    return this.errored
  }

  private closeTextBlock(): void {
    if (!this.textOpen) return
    this.content.push({ type: "text", text: this.textBuffer })
    this.textOpen = false
    this.textBuffer = ""
  }

  private closeThinkingBlock(): void {
    if (!this.thinkingOpen) return
    const block: Canonical_ThinkingBlock = {
      type: "thinking",
      thinking: this.thinkingBuffer,
      signature: this.thinkingSignature || createFallbackSignature(),
    }
    this.content.push(block)
    this.thinkingOpen = false
    this.thinkingBuffer = ""
  }

  private flushPendingToolCalls(): void {
    for (const [callId, state] of this.toolArguments) {
      this.content.push({
        type: "tool_call",
        id: callId,
        callId,
        name: state.name,
        arguments: state.fragments.join(""),
      })
      this.hasToolCall = true
    }
    this.toolArguments.clear()
  }
}

function createFallbackSignature(): string {
  return `sig_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

/**
 * Convenience: consume a canonical stream and return a finalized response.
 */
export async function accumulateCanonicalStream(stream: Canonical_StreamResponse): Promise<Canonical_Response> {
  return new CanonicalStreamAccumulator().consumeStream(stream)
}

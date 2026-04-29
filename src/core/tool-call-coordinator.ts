import type { JsonObject } from "./types"

/**
 * Provider-neutral tool call coordinator that tracks tool use IDs,
 * accumulates streamed argument fragments, and manages server tool
 * lifecycle ordering.
 */
export class ToolCallCoordinator {
  /** Map of tool_use_id -> tool name for result mapping. */
  private readonly toolNames = new Map<string, string>()
  /** Map of tool_use_id -> accumulated argument fragments. */
  private readonly argumentFragments = new Map<string, string[]>()
  /** Pending server tool calls awaiting results. */
  private readonly pendingServerCalls: JsonObject[] = []
  /** Deferred text that arrived while server calls were pending. */
  private deferredTextBuffer = ""
  /** Counter for generating fallback tool IDs. */
  private fallbackIdCounter = 0

  /** Register a tool use with its name. */
  registerToolUse(toolUseId: string, name: string): void {
    this.toolNames.set(toolUseId, name)
  }

  /** Get the tool name for a given tool use ID. */
  getToolName(toolUseId: string): string | undefined {
    return this.toolNames.get(toolUseId)
  }

  /** Accumulate a streamed argument fragment for a tool call. */
  appendArgumentFragment(toolUseId: string, fragment: string): void {
    const existing = this.argumentFragments.get(toolUseId)
    if (existing) {
      existing.push(fragment)
    } else {
      this.argumentFragments.set(toolUseId, [fragment])
    }
  }

  /** Get the accumulated arguments for a tool call, parsing only when complete. */
  getAccumulatedArguments(toolUseId: string): string {
    const fragments = this.argumentFragments.get(toolUseId)
    if (!fragments?.length) return "{}"
    const joined = fragments.join("")
    return isValidJson(joined) ? joined : "{}"
  }

  /** Clear accumulated fragments for a tool call (after completion). */
  clearArguments(toolUseId: string): void {
    this.argumentFragments.delete(toolUseId)
    this.toolNames.delete(toolUseId)
  }

  /** Generate a safe fallback ID for missing or duplicate tool IDs. */
  generateFallbackId(prefix = "toolu_fallback_"): string {
    this.fallbackIdCounter += 1
    return `${prefix}${this.fallbackIdCounter}`
  }

  /** Resolve a tool use ID, generating a fallback if missing or empty. */
  resolveToolUseId(id: string | undefined | null): string {
    if (id && typeof id === "string" && id.trim()) return id
    return this.generateFallbackId()
  }

  /** Add a pending server tool call. */
  addPendingServerCall(call: JsonObject): void {
    this.pendingServerCalls.push(call)
  }

  /** Check if there are pending server calls. */
  hasPendingServerCalls(): boolean {
    return this.pendingServerCalls.length > 0
  }

  /** Take all pending server calls (clears the queue). */
  takePendingServerCalls(): JsonObject[] {
    return this.pendingServerCalls.splice(0)
  }

  /** Defer text that arrived while server calls are pending. */
  deferText(text: string): void {
    this.deferredTextBuffer += text
  }

  /** Take deferred text (clears the buffer). */
  takeDeferredText(): string {
    const text = this.deferredTextBuffer
    this.deferredTextBuffer = ""
    return text
  }

  /** Check if there is deferred text. */
  hasDeferredText(): boolean {
    return this.deferredTextBuffer.length > 0
  }

  /** Get the number of registered tool uses. */
  get registeredToolCount(): number {
    return this.toolNames.size
  }

  /** Get the number of pending server calls. */
  get pendingServerCallCount(): number {
    return this.pendingServerCalls.length
  }
}

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

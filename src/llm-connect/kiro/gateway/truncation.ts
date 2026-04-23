/**
 * Truncation detection and recovery for Kiro API responses.
 *
 * Inspired by kiro-gateway's truncation_recovery.py and truncation_state.py.
 *
 * The Kiro API may truncate large tool call payloads or content mid-stream.
 * This module detects truncation and provides recovery mechanisms so the
 * model can adapt its approach on the next turn.
 */

import type { JsonObject } from "../../../types"

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

export interface TruncationInfo {
  detected: boolean
  reason: string
  sizeBytes: number
}

/**
 * Check whether a raw JSON string for a tool input appears truncated.
 *
 * Heuristics:
 * - Unbalanced braces / brackets
 * - Unclosed string literals
 * - Empty or whitespace-only input when a name was provided
 */
export function detectToolInputTruncation(rawInput: string): TruncationInfo {
  const size = new TextEncoder().encode(rawInput).byteLength

  if (!rawInput.trim()) {
    return { detected: false, reason: "empty", sizeBytes: size }
  }

  // Count braces / brackets
  let braces = 0
  let brackets = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < rawInput.length; i++) {
    const ch = rawInput[i]
    if (escaped) { escaped = false; continue }
    if (ch === "\\" && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") braces++
    if (ch === "}") braces--
    if (ch === "[") brackets++
    if (ch === "]") brackets--
  }

  if (inString) {
    return { detected: true, reason: "unclosed string literal", sizeBytes: size }
  }
  if (braces > 0) {
    return { detected: true, reason: `missing ${braces} closing brace(s)`, sizeBytes: size }
  }
  if (brackets > 0) {
    return { detected: true, reason: `missing ${brackets} closing bracket(s)`, sizeBytes: size }
  }

  return { detected: false, reason: "ok", sizeBytes: size }
}

/**
 * Detect whether a streaming response was truncated (content-level).
 *
 * A response is considered truncated when the stream ended without
 * emitting a `usage` or `context_usage` event — these are always the
 * last events in a well-formed Kiro response.
 */
export function detectContentTruncation(
  hasUsageEvent: boolean,
  hasContextUsageEvent: boolean,
  contentLength: number,
): TruncationInfo {
  const size = contentLength

  // If we got usage or context_usage, the stream completed normally
  if (hasUsageEvent || hasContextUsageEvent) {
    return { detected: false, reason: "ok", sizeBytes: size }
  }

  // No completion signal and we had some content → likely truncated
  if (size > 0) {
    return { detected: true, reason: "stream ended without usage/context_usage event", sizeBytes: size }
  }

  return { detected: false, reason: "empty response", sizeBytes: 0 }
}

// ---------------------------------------------------------------------------
// In-memory truncation state cache
// ---------------------------------------------------------------------------

interface ToolTruncationEntry {
  toolCallId: string
  toolName: string
  info: TruncationInfo
  timestamp: number
}

interface ContentTruncationEntry {
  contentHash: string
  preview: string
  timestamp: number
}

const toolTruncationCache = new Map<string, ToolTruncationEntry>()
const contentTruncationCache = new Map<string, ContentTruncationEntry>()

/** Save truncation info for a tool call (keyed by tool_call_id). */
export function saveToolTruncation(toolCallId: string, toolName: string, info: TruncationInfo) {
  toolTruncationCache.set(toolCallId, { toolCallId, toolName, info, timestamp: Date.now() })
}

/** Retrieve and remove truncation info for a tool call (one-time). */
export function consumeToolTruncation(toolCallId: string): ToolTruncationEntry | undefined {
  const entry = toolTruncationCache.get(toolCallId)
  if (entry) toolTruncationCache.delete(toolCallId)
  return entry
}

/** Save content truncation (keyed by hash of first 500 chars). */
export function saveContentTruncation(content: string) {
  const hash = simpleHash(content.slice(0, 500))
  contentTruncationCache.set(hash, { contentHash: hash, preview: content.slice(0, 200), timestamp: Date.now() })
}

/** Retrieve and remove content truncation info (one-time). */
export function consumeContentTruncation(content: string): ContentTruncationEntry | undefined {
  const hash = simpleHash(content.slice(0, 500))
  const entry = contentTruncationCache.get(hash)
  if (entry) contentTruncationCache.delete(hash)
  return entry
}

// ---------------------------------------------------------------------------
// Recovery message generation
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic tool_result block that informs the model about
 * truncation.  Wording is careful: acknowledges API limitation, warns
 * against repeating the same operation, does NOT give micro-step
 * instructions.
 */
export function generateTruncationToolResult(toolUseId: string): JsonObject {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content:
      "[API Limitation] Your tool call was truncated by the upstream API due to output size limits.\n\n" +
      "If the tool result below shows an error or unexpected behavior, this is likely a CONSEQUENCE " +
      "of the truncation, not the root cause. The tool call itself was cut off before it could be " +
      "fully transmitted.\n\n" +
      "Repeating the exact same operation will be truncated again. Consider adapting your approach.",
    is_error: true,
  }
}

/**
 * Generate a synthetic user message notifying the model that its
 * previous response was truncated.
 */
export function generateTruncationUserMessage(): string {
  return (
    "[System Notice] Your previous response was truncated by the API due to " +
    "output size limitations. This is not an error on your part. " +
    "If you need to continue, please adapt your approach rather than repeating the same output."
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple non-crypto hash for cache keys. */
function simpleHash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

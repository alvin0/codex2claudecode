/**
 * Payload size guard for Kiro API requests.
 *
 * Inspired by kiro-gateway's payload_guards.py.
 *
 * The Kiro API rejects payloads larger than ~615KB with a cryptic
 * "Improperly formed request" error.  This module provides pre-flight
 * size checking and automatic history trimming to stay under the limit.
 */

import type { KiroGenerateAssistantResponsePayload, KiroConversationHistoryEntry } from "../types"

/** Kiro API hard limit is ~615KB; we use a safety margin. */
const MAX_PAYLOAD_BYTES = 600_000

export interface PayloadGuardResult {
  /** Whether the payload was trimmed to fit. */
  trimmed: boolean
  /** Number of history entries removed. */
  entriesRemoved: number
  /** Final payload size in bytes. */
  finalSizeBytes: number
  /** Original payload size in bytes. */
  originalSizeBytes: number
}

/**
 * Check payload size and trim history if necessary.
 *
 * Removes the oldest history entries (user+assistant pairs) until the
 * serialised payload fits under `maxBytes`.  Returns the (possibly
 * mutated) payload and a summary of what was done.
 */
export function guardPayloadSize(
  payload: KiroGenerateAssistantResponsePayload,
  maxBytes = MAX_PAYLOAD_BYTES,
): PayloadGuardResult {
  const originalSize = byteLength(JSON.stringify(payload))

  if (originalSize <= maxBytes) {
    return { trimmed: false, entriesRemoved: 0, finalSizeBytes: originalSize, originalSizeBytes: originalSize }
  }

  // Trim oldest history entries until we fit
  const history = payload.conversationState.history as KiroConversationHistoryEntry[] | undefined
  if (!history || history.length === 0) {
    // Nothing to trim — return as-is and let the API reject it
    return { trimmed: false, entriesRemoved: 0, finalSizeBytes: originalSize, originalSizeBytes: originalSize }
  }

  let removed = 0
  while (history.length > 0) {
    history.shift()
    removed++
    const currentSize = byteLength(JSON.stringify(payload))
    if (currentSize <= maxBytes) {
      return { trimmed: true, entriesRemoved: removed, finalSizeBytes: currentSize, originalSizeBytes: originalSize }
    }
  }

  // Even after removing all history, still too large
  const finalSize = byteLength(JSON.stringify(payload))
  return { trimmed: true, entriesRemoved: removed, finalSizeBytes: finalSize, originalSizeBytes: originalSize }
}

/**
 * Quick check whether a payload exceeds the size limit.
 */
export function isPayloadOversized(payload: unknown, maxBytes = MAX_PAYLOAD_BYTES): boolean {
  return byteLength(JSON.stringify(payload)) > maxBytes
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength
}

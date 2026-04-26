import { canonicalToCodexBody } from "../../upstream/codex/parse"
import type { ClaudeMessagesRequest, JsonObject } from "../types"

import { claudeToCanonicalRequest } from "./convert"

export function claudeToResponsesBody(body: ClaudeMessagesRequest): JsonObject {
  return canonicalToCodexBody(claudeToCanonicalRequest(body))
}

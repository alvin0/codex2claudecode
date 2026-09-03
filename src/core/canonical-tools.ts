import type { JsonObject } from "./types"

/**
 * The canonical tool-type vocabulary, for the one tool kind that needed a name of its own.
 *
 * `Canonical_Request.tools` is `JsonObject[]`, so a tool's `type` is the only thing that tells an
 * upstream what the client asked for. Until now the canonical vocabulary had no way to say "fetch
 * this URL": every inbound provider that saw a fetch tool had to pick some other type, and
 * `src/inbound/claude/web.ts` picked `web_search` — which made a fetch arrive upstream as a search,
 * with nothing on the request recording that the substitution happened. Requirement 10.1 has every
 * client-supplied field resolve to a declared policy, and a type the canonical model cannot spell
 * can only ever be dropped in silence.
 *
 * So this member is the canonical spelling of that intent, and nothing more:
 *
 * - It is **not** a wire shape. No inbound API's versioned type name (`web_fetch_20250910`) and no
 *   upstream's hosted-tool vocabulary belongs here; each side owns its own names and translates at
 *   its own boundary. What travels between them is this one string.
 * - It carries **no policy**. Whether a fetch is run natively, emulated, substituted, or refused is
 *   a per-upstream declaration in `src/upstream/<provider>/capabilities.ts`. Core only makes the
 *   request able to say what was asked for.
 * - Its feature name already exists: `webFetch` in {@link ./provider-capabilities}. This is the
 *   request-side counterpart of that cell, so a declaration about fetching and a request to fetch
 *   are finally about the same thing.
 *
 * Deliberately fetch-only rather than a full canonical tool-type enum. The other type names in a
 * canonical tool list (`function`, `web_search`, `mcp`) are already spelled consistently by every
 * provider on both sides, so writing them down here would be a second source of truth for a
 * vocabulary nothing disagrees about. This member exists because there *was* a disagreement.
 */
export const CANONICAL_WEB_FETCH_TOOL_TYPE = "web_fetch"

/**
 * Whether a canonical tool type names a fetch.
 *
 * Tolerant of the versioned spellings inbound APIs use (`web_fetch_20250910`, `web-fetch`), because
 * an inbound provider that forwards a client tool list with less normalization than
 * `src/inbound/claude/` performs would otherwise have its fetch read as an unknown type. The
 * canonical spelling an inbound provider *should* emit is {@link CANONICAL_WEB_FETCH_TOOL_TYPE};
 * this predicate is what makes reading the request forgiving without making writing it ambiguous.
 *
 * A predicate rather than a set, for the reason the same shape is a predicate in
 * `src/upstream/kiro/index.ts`: the version suffix moves with each API release, and a set would
 * need an edit per release.
 */
export function isCanonicalWebFetchToolType(type: unknown): boolean {
  return typeof type === "string" && /^web[_-]?fetch(?:_\d+)?$/i.test(type)
}

/** {@link isCanonicalWebFetchToolType}, applied to a tool rather than to its type. */
export function isCanonicalWebFetchTool(tool: JsonObject): boolean {
  return isCanonicalWebFetchToolType(tool.type)
}

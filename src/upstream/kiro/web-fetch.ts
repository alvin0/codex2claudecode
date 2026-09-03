// Kiro `web_fetch` emulation: URL validation, execution, `web_fetch_tool_result` block
// construction, and `webFetchRequests` counting (task 28.1, Requirements 18.1, 18.3, 18.4, 18.5,
// 18.6).
//
// ## Which branch of task 28.1 this module implements: `emulate`, not `native`
//
// Task 28.1 has two branches and the task 2 probe picked one. `.omc/research/kiro-wire-spike.md`
// §9.2–§9.4 records the measurement: Kiro's `POST /mcp` `tools/list` advertises exactly one tool,
// `web_search`, and a direct `tools/call` for each of `web_fetch`, `webFetch`, and `fetch` returned
// JSON-RPC `-32602 "Tool not found"`. So there is no server-side fetch tool, listed or hidden, and
// the `WHERE the … probe reported a server-side fetch tool` clause of Requirement 18.6 does not
// hold — it is vacuously satisfied, with zero code here calling any upstream tool. §9.4 states the
// settled matrix value: Kiro `webFetch` = **`emulate`**, which is what
// `src/upstream/kiro/capabilities.ts` already declares. This module therefore performs the fetch
// itself rather than delegating to a server-side tool, and it does **not** reuse the `web_search`
// tool to approximate a fetch — reusing it is what makes today's `web-fetch-emulate` live case red
// (it produces `web_search_tool_result` and `web_fetch_requests = 0`; §9.4 and the Run_Record
// tables). If a fetch tool ever appears in `tools/list`, that is a new measurement and a new
// Run_Record; do not flip this module on a guess.
//
// ## Shape
//
// Deliberately parallel to `src/upstream/kiro/web-search.ts`: a tool declaration to inject
// (`kiroWebFetchTool`), a mid-stream interceptor generator (`maybeHandleKiroWebFetch`, the same
// passthrough-or-intercept contract as `maybeHandleKiroServerTool`), a block builder
// (`webFetchBlocks`), and an argument reader (`extractWebFetchUrl`). Everything here is pure except
// `executeKiroWebFetch`, which is the only function that touches the network.
//
// ## Counting
//
// `webFetchServerToolUse()` reports the **existing** `Canonical_Usage.serverToolUse.webFetchRequests`
// field and nothing else — no parallel counter is introduced (Requirement 18.3, Requirement 22.3).
// A count is one per *completed* fetch, which is why the failure paths below emit no
// `web_fetch_tool_result` block: `serverToolUseFromBlocks()` in `./parse.ts` counts blocks of that
// type, so emitting one for a call that never completed would inflate the counter.
//
// ## Failure shape
//
// A non-URL input yields a `Canonical_Event` of type `error` naming the invalid input, and issues
// **zero** upstream requests (Requirement 18.5) — the validation predicate runs before any fetch
// impl is reached, in both `maybeHandleKiroWebFetch` and `executeKiroWebFetch`. The duplication is
// deliberate: neither entry point should depend on the other having checked. A valid URL whose
// fetch fails takes the same `error` route rather than a `web_fetch_tool_result` carrying an error
// body, so a failed attempt is never counted as a completed fetch. Nothing here narrows the
// counter to success only *by editing* an existing assertion; the counter field is untouched.
import type { Canonical_Event, Canonical_Usage } from "../../core/canonical"
import type { JsonObject } from "../../core/types"

/** The Kiro-side function tool name this module intercepts. */
export const KIRO_WEB_FETCH_TOOL_NAME = "web_fetch"

/** Cap on the extracted text handed to the model, in characters. */
export const KIRO_WEB_FETCH_MAX_CONTENT_CHARS = 100_000

/** Per-fetch wall-clock budget. */
export const KIRO_WEB_FETCH_TIMEOUT_MS = 20_000

/** Protocols the URL predicate accepts. Anything else is "not a URL" for Requirement 18.5. */
const FETCHABLE_PROTOCOLS = new Set(["http:", "https:"])

/** The document a completed fetch produced, before it becomes wire blocks. */
export interface KiroWebFetchDocument {
  url: string
  /** Extracted plain text. Empty only when the response body was empty. */
  data: string
  title?: string
  /** ISO-8601 timestamp, rendered into `retrieved_at`. */
  retrievedAt: string
}

/** A completed fetch, paired with the server-tool id its blocks will carry. */
export interface KiroWebFetchExecution {
  toolUseId: string
  document: KiroWebFetchDocument
}

/** Result of one fetch attempt. `ok: false` means no block and no counter increment. */
export type KiroWebFetchResult =
  | { ok: true; execution: KiroWebFetchExecution }
  | { ok: false; message: string }

/** Result of the URL predicate. The failure carries the message that names the input. */
export type KiroWebFetchValidation =
  | { ok: true; url: string }
  | { ok: false; message: string }

/**
 * Injected executor, mirroring {@link KiroServerToolHandlers.webSearch}.
 *
 * `executeKiroWebFetch` satisfies this signature directly, so wiring is one call-site line.
 * Returning `undefined` means "not handled" and the call falls through to the client as a normal
 * tool call, the same escape hatch the web-search handler has.
 */
export interface KiroWebFetchHandlers {
  webFetch?: (url: string) => Promise<KiroWebFetchResult | undefined>
}

export interface KiroWebFetchOptions {
  signal?: AbortSignal
  /** Seam for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  maxContentChars?: number
  timeoutMs?: number
  /** Seam for tests, so `retrieved_at` is deterministic. */
  now?: () => Date
  /** Seam for tests, so the block id is deterministic. */
  toolUseId?: string
}

/**
 * The `web_fetch` function tool declared to Kiro.
 *
 * A function tool, not a server-side tool: §9.3 settled that Kiro exposes none. The description
 * pushes the model to pass the URL verbatim, because a paraphrased URL fails the predicate below
 * and costs the turn its fetch.
 */
export function kiroWebFetchTool(): JsonObject {
  return {
    type: "function",
    name: KIRO_WEB_FETCH_TOOL_NAME,
    description: "Fetch the contents of a specific web page by URL and return its text. Use this when the user names a URL and wants its content, rather than searching. Always pass an absolute http or https URL, verbatim as the user wrote it.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http or https URL to fetch, copied verbatim from the request." },
      },
      required: ["url"],
    },
  }
}

/**
 * The URL predicate of Requirement 18.5.
 *
 * True only for an absolute `http:`/`https:` URL with a hostname. Rejects `javascript:`, `data:`,
 * `file:`, bare words, and scheme-relative or relative paths.
 */
export function isFetchableUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (!FETCHABLE_PROTOCOLS.has(parsed.protocol)) return false
  return parsed.hostname.length > 0
}

/**
 * The error text for an input that is not a URL.
 *
 * Names the input verbatim and untruncated, which is what "naming the invalid input" costs: a
 * truncated echo would let a long invalid input fail the requirement silently.
 */
export function webFetchInvalidInputMessage(input: string) {
  return `Kiro web_fetch received an input that is not a URL: ${JSON.stringify(input)}. Provide an absolute http or https URL.`
}

/** Run the predicate, returning either the normalized URL or the naming error. */
export function validateKiroWebFetchInput(input: string): KiroWebFetchValidation {
  const trimmed = input.trim()
  if (!isFetchableUrl(trimmed)) return { ok: false, message: webFetchInvalidInputMessage(input) }
  return { ok: true, url: trimmed }
}

/**
 * Read the URL out of a tool call's `arguments` JSON.
 *
 * Returns `""` when the JSON is malformed or carries no string `url`, leaving the caller to name
 * the raw arguments as the invalid input rather than inventing a candidate.
 */
export function extractWebFetchUrl(argumentsJson: string) {
  try {
    const parsed = JSON.parse(argumentsJson) as { url?: unknown }
    return typeof parsed.url === "string" ? parsed.url.trim() : ""
  } catch {
    return ""
  }
}

/**
 * The Claude server-tool blocks for one completed fetch.
 *
 * Exactly one `web_fetch_tool_result` and zero `web_search_tool_result` (Requirement 18.4). The
 * result shape matches what `codexWebCallToClaudeBlocks()` already emits for an `open_page` action
 * (`src/inbound/claude/web.ts`), so `claudeWebResultHasContent()` reads this block the same way it
 * reads the Codex one — the inbound renderer needs no Kiro-specific branch.
 */
export function webFetchBlocks(toolUseId: string, document: KiroWebFetchDocument): JsonObject[] {
  return [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: KIRO_WEB_FETCH_TOOL_NAME,
      input: { url: document.url },
    },
    {
      type: "web_fetch_tool_result",
      tool_use_id: toolUseId,
      content: {
        type: "web_fetch_result",
        url: document.url,
        content: {
          type: "document",
          source: {
            type: "text",
            media_type: "text/plain",
            data: document.data,
          },
          ...(document.title ? { title: document.title } : {}),
        },
        retrieved_at: document.retrievedAt,
      },
    },
  ]
}

/** Number of completed fetches represented by `blocks`. */
export function webFetchRequestsFromBlocks(blocks: JsonObject[]) {
  return blocks.filter((block) => block.type === "web_fetch_tool_result").length
}

/**
 * The usage delta for `blocks`, written into the existing
 * `Canonical_Usage.serverToolUse.webFetchRequests` field.
 *
 * `undefined` when nothing completed, so a fetch-free turn keeps omitting `serverToolUse` instead
 * of reporting a zero — the same omit-rather-than-empty rule `./parse.ts` applies.
 */
export function webFetchServerToolUse(blocks: JsonObject[]): Canonical_Usage["serverToolUse"] | undefined {
  const webFetchRequests = webFetchRequestsFromBlocks(blocks)
  if (!webFetchRequests) return
  return { webFetchRequests }
}

/**
 * Fetch one URL and render it as a document.
 *
 * Validates first and returns before constructing a request when the input is not a URL, so an
 * invalid input costs **zero** upstream requests (Requirement 18.5) — observable by counting calls
 * to an injected `fetchImpl`.
 */
export async function executeKiroWebFetch(input: string, options: KiroWebFetchOptions = {}): Promise<KiroWebFetchResult> {
  const validation = validateKiroWebFetchInput(input)
  if (!validation.ok) return validation

  const fetchImpl = options.fetchImpl ?? fetch
  const maxChars = options.maxContentChars ?? KIRO_WEB_FETCH_MAX_CONTENT_CHARS
  const now = options.now ?? (() => new Date())
  const signal = combineSignals(options.signal, options.timeoutMs ?? KIRO_WEB_FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchImpl(validation.url, {
      redirect: "follow",
      headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.8" },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    return { ok: false, message: `Kiro web_fetch could not reach ${validation.url}: ${errorText(error)}` }
  }

  if (!response.ok) {
    return { ok: false, message: `Kiro web_fetch could not fetch ${validation.url}: upstream responded ${response.status}.` }
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    return { ok: false, message: `Kiro web_fetch could not read ${validation.url}: ${errorText(error)}` }
  }

  const title = extractHtmlTitle(body)
  return {
    ok: true,
    execution: {
      toolUseId: options.toolUseId ?? webFetchToolUseId(),
      document: {
        url: validation.url,
        data: extractText(body).slice(0, maxChars),
        ...(title ? { title } : {}),
        retrievedAt: now().toISOString(),
      },
    },
  }
}

/**
 * Intercept a `web_fetch` tool call mid-stream, or pass it through untouched.
 *
 * Same contract as `maybeHandleKiroServerTool()` in `./web-search.ts`: any call this module does
 * not own is re-emitted verbatim as `tool_call_done`, so an unhandled name reaches the client
 * unchanged rather than disappearing.
 */
export async function* maybeHandleKiroWebFetch(
  call: { callId: string; name: string; arguments: string },
  handlers?: KiroWebFetchHandlers,
): AsyncIterable<Canonical_Event> {
  if (call.name !== KIRO_WEB_FETCH_TOOL_NAME || !handlers?.webFetch) {
    yield { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
    return
  }

  // No fallback query equivalent here, deliberately. Web search can degrade to the user's prompt
  // text; a fetch cannot invent a URL, so an unreadable argument is an invalid input, not a
  // recoverable one.
  const candidate = extractWebFetchUrl(call.arguments) || call.arguments.trim()
  const validation = validateKiroWebFetchInput(candidate)
  if (!validation.ok) {
    yield { type: "error", message: validation.message }
    return
  }

  const result = await handlers.webFetch(validation.url)
  if (!result) {
    yield { type: "tool_call_done", callId: call.callId, name: call.name, arguments: call.arguments }
    return
  }
  if (!result.ok) {
    yield { type: "error", message: result.message }
    return
  }

  yield { type: "server_tool_block", blocks: webFetchBlocks(result.execution.toolUseId, result.execution.document) }
}

/** `srvtoolu_`-prefixed id, the form `src/inbound/claude/web.ts` already normalizes to. */
function webFetchToolUseId() {
  return `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = typeof AbortSignal.timeout === "function" && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  if (!signal) return timeout
  if (!timeout) return signal
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout])
  return signal
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function extractHtmlTitle(body: string) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)
  if (!match) return
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim()
  return title || undefined
}

/**
 * Reduce a response body to readable text.
 *
 * Intentionally crude: drop script/style/comment regions, drop tags, decode the handful of entities
 * that survive, collapse runs of blank lines. A real HTML-to-text pass is not what Requirement 18.1
 * asks for, and a plain-text body passes through this unchanged.
 */
function extractText(body: string) {
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  return decodeEntities(stripped)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim()
}

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
}

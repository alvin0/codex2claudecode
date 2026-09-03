// Role: compare two Codex SSE bodies for the passthrough case — the bytes the client got
// against the bytes a second, independent direct upstream call produced. Pure text and JSON
// work, no network and no assertions, so `assertions.ts` stays a thin reader.
//
// Why this module exists at all: Run_Record 19 measured that a raw string comparison between
// the client body and `callUpstreamDirectly()` can never pass. Both bodies are real, separate
// generations, so each carries its own per-call identifiers even when the two are the same
// length (RR19: 9644 / 9644). The comparison below normalizes exactly the values that cannot
// match by construction — enumerated one by one, with the reason — and compares everything
// else verbatim.
//
// ## Why per-call ids are normalized by identity, not by key name (Run_Record 20)
//
// The first version of this module blanked a fixed list of *seven* key names, `id` among them.
// RR20 measured that list failing: `bytes-match-direct-call-modulo-volatile-fields` diverged at
// offset 3115, on `item_id`. The mechanism is that one item id reaches the wire under two
// different keys — `response.output_item.added` carries it as `item.id`, and the content/text
// frames that reference the same item carry it as `item_id`. A name-based list blanked the first
// and let the second through verbatim.
//
// The obvious repair — add `item_id` as an eighth name — was **rejected**. Blanking an id by name
// throws away the one thing the assertion exists to catch: a gateway that *rewrites* an id while
// re-framing. Once both spellings read `<volatile>`, a body whose item ids no longer agree with
// each other is indistinguishable from one where they do.
//
// So ids are normalized by **identity** instead: any value whose *shape* is a per-call Codex id is
// replaced wherever it appears, under any key, and each distinct id value gets a stable label
// assigned by first-occurrence order (`<id:0>`, `<id:1>`, …) rather than one shared token. That
// keeps the *relationships* between ids in the comparison while tolerating the values: two frames
// referring to one id still agree after normalization, and a gateway that re-minted an id makes
// the label mapping diverge, so the diff fails and names the frame. This is the technique
// `test/inbound/openai/normalize.property.test.ts` uses in its `stabilizeMintedIds` helper, for the
// same reason; the idea is reused, not the code, because that helper compares canonical objects and
// this one compares SSE text.
//
// Identity-based normalization also reaches somewhere a name list structurally cannot: in
// `response.completed`, `usage.attribution.items` is an object **keyed by item id**. Keys are
// labelled from the same mapping as values, so a key and the value it describes stay consistent.
//
// ## Why numeric counters are normalized inside `usage` and nowhere else (Run_Record 47)
//
// RR47 measured `bytes-match-direct-call-modulo-volatile-fields` failing twice, at the same offset
// 5510, on `usage.attribution.items[<id>].output_tokens`: **28** (client) vs **19** (direct) in the
// full run at `12:17`, then **23** vs **16** in a targeted two-call re-measure at `12:19`. Same
// field, same offset, *different numbers each time* — the signature of per-call generation
// non-determinism, not of a transform, which would diverge consistently. In the same two runs
// `client-bytes-equal-captured-upstream-bytes` **passed**, so the passthrough property itself holds
// and the gateway transforms nothing. The case is Codex and the only diff in the tree was three
// Kiro constants, so there is no causal path from the working tree to the divergence either.
//
// The mechanism is structural, not incidental: the two sides of this assertion are two
// **independent generations** of the same prompt. A token count describes how much text *that*
// generation produced, so it cannot match by construction — the same argument that put `created_at`
// and `completed_at` on the volatile list, applied to a number instead of a clock.
//
// The obvious repair — a bare `output_tokens` entry in {@link PASSTHROUGH_VOLATILE_FIELDS} — was
// **rejected**. That list is keyed by name and applies at any depth, so it would blank counters
// everywhere in the body, and `test/native/harness.test.ts` deliberately asserts the opposite:
// blanking a timestamp must not blank numbers generally. A global count-blanking would destroy the
// ability to detect a gateway that truncates or rewrites content, which is most of what this
// assertion exists for.
//
// So the narrowing is by **region**, not by name: numeric values are replaced by a placeholder only
// inside a `usage` subtree — the region whose values describe what the upstream's own generation
// consumed and produced, and which is therefore meaningless to compare across two separate calls.
// Everything outside `usage` keeps its current name-keyed behaviour, numbers included.
//
// What the narrowing buys: the assertion becomes satisfiable on a body that reports usage, instead
// of failing on a field that can never agree. What it gives up: inside `usage` only, a counter the
// gateway rewrote is indistinguishable from one that differed naturally — so this diff no longer
// witnesses usage accounting. Everything the assertion is really for survives: frame count, frame
// order, event names, payload types, id relationships, and every non-`usage` value including every
// non-`usage` number, so a truncated or rewritten *body* still fails. Keys inside `usage` are not
// touched either, so a dropped or renamed usage field still fails; only the numbers are tolerated.
import { isJsonObject } from "./observation"
import { parseSseText } from "./response-capture"

/**
 * The scalar fields blanked before the diff, and why each one cannot match across two independent
 * calls. Every entry is a per-call value minted by Codex, never a value the gateway could
 * influence — so blanking it removes noise without hiding a transformation. Ids are *not* here;
 * they go through {@link PASSTHROUGH_PER_CALL_ID_SHAPE}, see the module note on RR20.
 *
 * Adding a field here is a deliberate, visible edit: it widens what the diff tolerates, so it
 * belongs in a commit that says which measurement forced it. A field that differs and is *not*
 * listed makes the assertion fail and names the path, which is the intended behavior.
 */
export const PASSTHROUGH_VOLATILE_FIELDS: Readonly<Record<string, string>> = {
  // Wall-clock second the upstream began the response.
  created_at: "per-call start timestamp",
  // Wall-clock second the upstream finished the response — sibling to `created_at`, stamped by
  // Codex on `response.completed`, and the only field left diverging once the RR20 id repair
  // landed. Measured twice, on two different Codex models, as the single remaining divergence of
  // `bytes-match-direct-call-modulo-volatile-fields`: RR22 `"completed_at":1788432181` (client) vs
  // `1788432183` (direct) at offset 4320, and RR26 `1788433394` vs `1788433396` at offset ~4300.
  // Every other byte matched in both runs.
  //
  // Listed as volatile rather than treated as a gateway-caused difference because two independent
  // calls finish at two different wall-clock seconds by construction — the same argument that put
  // `created_at` here — and because the "did the gateway rewrite something" question is answered by
  // a separate assertion: `client-bytes-equal-captured-upstream-bytes` compares the client bytes
  // against the bytes the gateway captured from its *own* upstream call, exactly, no normalization,
  // and RR22/RR26 both observe that assertion passing.
  completed_at: "per-call completion timestamp",
  // Derived from the per-call conversation / session identity the gateway sends.
  prompt_cache_key: "per-call prompt cache key derived from the request's session identity",
  // Per-call abuse-tracking hash.
  safety_identifier: "per-call safety identifier assigned by Codex",
  // Random padding Codex attaches to individual SSE frames; differs frame to frame.
  obfuscation: "random per-frame padding",
  // Reasoning payload sealed with a per-call key, so the ciphertext differs every call.
  encrypted_content: "reasoning payload encrypted under a per-call key",
}

/**
 * The shape of a per-call Codex identifier: a short lowercase prefix, an underscore, then a long
 * lowercase-hex run.
 *
 * Measured, not guessed. The recorded bodies under `.native-transcripts/` spell item ids
 * `msg_03d2297e550c650f016a97d7863ae087d091245f144d2dd78a` and reasoning ids
 * `rs_03d2297e550c650f016a97d786c34c87d0899a2a33b26614bc` — a 50-character hex body — and the same
 * two prefixes appear again as the keys of `usage.attribution.items`. The response id (`resp_…`)
 * reaches the transcripts already collapsed to `[redacted]`, which is itself evidence about its
 * shape: `redactDebugText()` only collapses runs of 32-plus token characters, so the response id is
 * a long single token of the same family.
 *
 * The rule is written as a shape rather than an enumerated prefix list so a sibling prefix the
 * bodies grow later is covered without another edit. The 24-character floor is well under the 50
 * measured and well over anything a short enum value or model name could reach, and the hex-only
 * body keeps ordinary payload text — `"final_answer"`, `"gpt-5.4-mini-2026-03-17"`,
 * `"user-SkbLKesZuN6wAV14swEAaF4F"` — out. A value that is genuinely an id and does *not* match
 * makes the diff fail and names the field; it does not get absorbed silently.
 */
export const PASSTHROUGH_PER_CALL_ID_SHAPE = /^[a-z][a-z0-9]{0,11}_[0-9a-f]{24,}$/

/**
 * The single object key whose subtree has its numeric values tolerated, and the reason.
 *
 * One entry, deliberately: widening this is a much larger concession than adding a name to
 * {@link PASSTHROUGH_VOLATILE_FIELDS}, because it tolerates every number below it rather than one
 * named field. See the module note on RR47 for the measurements that forced this one.
 */
export const PASSTHROUGH_COUNTER_SUBTREES: Readonly<Record<string, string>> = {
  usage: "token accounting for the upstream's own generation; two independent calls cannot agree",
}

const VOLATILE_PLACEHOLDER = "<volatile>"
const COUNTER_PLACEHOLDER = "<counter>"

/** First-occurrence label per distinct id value, so identity relations survive normalization. */
type IdLabels = Map<string, string>

/** One entry per SSE frame: the event name paired with the payload `type`. */
export function sseEventSequence(text: string): string[] {
  return parseSseText(text).map((event) => {
    const type = isJsonObject(event.data) && typeof event.data.type === "string" ? event.data.type : "(no type)"
    return `${event.event ?? "(no event)"}/${type}`
  })
}

/**
 * The body re-rendered frame by frame with the volatile scalars blanked and every per-call id
 * replaced by its first-occurrence label. Framing is preserved one frame per parsed event, so a
 * re-chunked, reordered, dropped, or added frame changes this text. Payloads that are not JSON are
 * kept verbatim.
 *
 * The label mapping spans the whole body, not one frame, because the relationships worth preserving
 * are between frames: the item id in `response.output_item.added` and the `item_id` of the content
 * frames that follow it must land on the same label.
 */
export function normalizePassthroughSse(text: string): string {
  const labels: IdLabels = new Map()
  return parseSseText(text)
    .map((event) => {
      const data = isJsonObject(event.data) ? JSON.stringify(normalizeValue(event.data, labels)) : String(event.data)
      return `${event.event === undefined ? "" : `event: ${event.event}\n`}data: ${data}`
    })
    .join("\n\n")
}

export type PassthroughDiff = { ok: true } | { ok: false; detail: string }

/**
 * The normalized diff between the client bytes and a direct call.
 *
 * Proves: the client received the same SSE frames, in the same order, with the same event
 * names, the same payload `type`s, and byte-identical payload values everywhere except the
 * per-call scalars above, the per-call ids, and the numbers inside a `usage` subtree — and, for the
 * ids, that the *pattern of which frame references which id* is identical too. A gateway that
 * reframes, re-chunks, reorders, drops, adds, edits any field outside `usage`, or re-mints an id
 * fails here.
 *
 * Does not prove: byte identity with the direct call — that is unreachable, see RR19. It also
 * cannot distinguish a per-call value the gateway rewrote from the same value differing naturally,
 * for the scalars above, for the id *values* taken one at a time, and for numbers under `usage`
 * (RR47). What it does keep, and what a name-based list gave up (RR20), is the id *relationships*:
 * rewriting one id out of a matched pair is caught even though rewriting every occurrence of it
 * consistently is not. Numbers outside `usage` are compared verbatim.
 *
 * Model output text is *not* normalized. The case prompt is fixed and RR19 measured equal
 * lengths, so a divergence in generated text surfaces here as a payload diff to be triaged
 * rather than something this function silently absorbs.
 */
export function passthroughByteDiff(clientBody: string, directBody: string): PassthroughDiff {
  const clientSequence = sseEventSequence(clientBody)
  const directSequence = sseEventSequence(directBody)

  if (clientSequence.length !== directSequence.length) {
    return {
      ok: false,
      detail: `event count differs: client ${clientSequence.length} frames, direct ${directSequence.length} frames (client [${clientSequence.join(", ")}])`,
    }
  }

  const divergence = clientSequence.findIndex((entry, index) => entry !== directSequence[index])
  if (divergence >= 0) {
    return {
      ok: false,
      detail: `event sequence differs at frame ${divergence}: client ${clientSequence[divergence]}, direct ${directSequence[divergence]}`,
    }
  }

  const client = normalizePassthroughSse(clientBody)
  const direct = normalizePassthroughSse(directBody)
  if (client === direct) return { ok: true }

  return { ok: false, detail: `normalized bodies differ: ${firstTextDifference(client, direct)}` }
}

/**
 * A structural copy with the volatile scalars blanked and every id-shaped string — as a value or as
 * an object key — replaced by its label. Every other key and value is untouched.
 */
function normalizeValue(value: unknown, labels: IdLabels, inCounterSubtree = false): unknown {
  if (typeof value === "string") return PASSTHROUGH_PER_CALL_ID_SHAPE.test(value) ? labelFor(value, labels) : value
  // Numbers are tolerated only under a counter subtree (RR47). Outside one, a differing number is a
  // real difference and must fail — that is what keeps a truncating or rewriting gateway detectable.
  if (typeof value === "number") return inCounterSubtree ? COUNTER_PLACEHOLDER : value
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, labels, inCounterSubtree))
  if (!isJsonObject(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    // Keys are labelled from the same mapping as values: `usage.attribution.items` is keyed by item
    // id, and a key must land on the same label as the value that names the same item elsewhere.
    const normalizedKey = PASSTHROUGH_PER_CALL_ID_SHAPE.test(key) ? labelFor(key, labels) : key
    // Once inside a counter subtree the whole subtree stays inside it, however deep: RR47's field is
    // `usage.attribution.items[<id>].output_tokens`, three levels below the `usage` key.
    const nestedInCounterSubtree = inCounterSubtree || key in PASSTHROUGH_COUNTER_SUBTREES
    result[normalizedKey] =
      key in PASSTHROUGH_VOLATILE_FIELDS ? VOLATILE_PLACEHOLDER : normalizeValue(nested, labels, nestedInCounterSubtree)
  }
  return result
}

/** The label already assigned to this id, or a new one numbered by first-occurrence order. */
function labelFor(id: string, labels: IdLabels): string {
  const existing = labels.get(id)
  if (existing !== undefined) return existing
  const label = `<id:${labels.size}>`
  labels.set(id, label)
  return label
}

/** A readable pointer at the first divergence, so a failure names the field, not just a size. */
function firstTextDifference(client: string, direct: string, window = 120): string {
  let index = 0
  while (index < client.length && index < direct.length && client[index] === direct[index]) index += 1
  const from = Math.max(0, index - window / 2)
  return [
    `first difference at offset ${index}`,
    `client …${client.slice(from, index + window)}…`,
    `direct …${direct.slice(from, index + window)}…`,
  ].join(" | ")
}

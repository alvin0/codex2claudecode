/**
 * The bundled Kiro model descriptor file, read as a **fallback** source of effort metadata.
 *
 * ## Why this module exists
 *
 * `KiroModelMetadataRegistry` populates from the live `ListAvailableModels` response, and that
 * response is authoritative: it is what the account can actually call, and it changes over time as
 * Kiro's catalog moves. It is not, however, always complete — a string-only entry, or an entry with
 * no `additionalModelRequestFieldsSchema` key at all, tells us nothing about that model's effort
 * vocabulary while `kiro-models.json` in this repo does.
 *
 * This module is the second of those two sources, and only the second: **live always wins where it
 * exists**, and the static file fills gaps — but only gaps. Where the live entry *answered* and the
 * answer contained no effort enum (the measured `additionalModelRequestFieldsSchema: null` of
 * `claude-sonnet-4.5`, for one), that is a denial and this file must not overrule it, however
 * confidently it declares `effort_low/medium/high/xhigh = true` for the same model id;
 * `KiroModelMetadataRegistry.fillEffortGapsFromStaticCatalog()` is where that line is drawn, and
 * `KiroEffortSchemaDisclosure` is the distinction it draws it on. That ordering is not a preference,
 * it is the honesty rule the capability layer of this feature is built on — the gateway must not
 * assert a vocabulary the endpoint contradicted, and it must not silently pass off a bundled file as
 * a measurement.
 * Which is why every descriptor produced here carries `provenance: "static"` while every descriptor
 * parsed from the wire carries `provenance: "live"`: "measured from the endpoint" and "read from a
 * file shipped with this package" are different claims, and a client is entitled to tell them apart.
 *
 * ## Cost and failure
 *
 * The file is a static import, so reading it costs no I/O, adds no network call to the request hot
 * path, and cannot fail at runtime the way `readFile` can. Parsing is nevertheless fully defensive
 * and never throws: an unexpected shape, a missing `models` array, or a model whose capability flags
 * are all `false` yields **no descriptor**, which is exactly today's behaviour (`effort` omitted).
 * A degraded static file can therefore only take capability away, never add a wrong claim.
 */

import kiroModelsConfig from "../../../kiro-models.json"

import type { KiroEffortSchemaPath, KiroModelEffortMetadata } from "./model-metadata"

/**
 * Level names in the order Kiro publishes them, weakest first.
 *
 * `kiro-models.json` states capability as one boolean per level (`effort_low`, `effort_medium`, …)
 * rather than as an ordered enum, so the order has to come from somewhere; it comes from here, and
 * it matches the ascending order the live `additionalModelRequestFieldsSchema` uses. Keeping the
 * order ascending matters downstream: `nearestEnumLevel()` falls back on the **last** element of
 * `levels` for a vocabulary it cannot rank, and reads it as the model's strongest.
 */
const STATIC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * Where a static descriptor's level goes in `additionalModelRequestFields`.
 *
 * The file carries no path information, so this is knowledge the file cannot supply. Every model in
 * `kiro-models.json` is a Claude-family model, and the Claude models Kiro publishes a live schema
 * for use the `output_config` shape (`{ output_config: { effort } }`); the nested `reasoning` shape
 * is what the GPT-family entries in the same catalog use. So `output_config` is the correct constant
 * for this file's contents, and a future non-Claude entry would need its path declared rather than
 * assumed — hence the named constant instead of an inline literal.
 */
const STATIC_EFFORT_SCHEMA_PATH: KiroEffortSchemaPath = "output_config"

interface StaticModelEntry {
  id?: unknown
  capabilities?: unknown
}

/**
 * Descriptors keyed by model id, built once on first use.
 *
 * Lazy rather than module-eval so a malformed file cannot break module loading, and cached rather
 * than per-call so `populate()` — which runs over every entry of a paginated catalog — does not
 * re-walk the file once per model.
 */
let cache: Map<string, KiroModelEffortMetadata> | undefined

/**
 * The static effort descriptor for `modelId`, or `undefined` when the file says nothing usable
 * about it.
 *
 * Three lookups, in order: the id as given, the id resolved through the file's own `aliases` map,
 * and a case-insensitive match. Nothing is inferred beyond that — a model absent from the file
 * simply has no static descriptor, which leaves the registry's behaviour for it unchanged.
 */
export function staticKiroEffortDescriptor(modelId: string): KiroModelEffortMetadata | undefined {
  if (!modelId) return undefined
  const descriptors = staticEffortDescriptors()
  return descriptors.get(modelId)
    ?? descriptors.get(resolveStaticAlias(modelId))
    ?? descriptors.get(modelId.toLowerCase())
}

/** Every model id the static file carries a usable effort descriptor for. Test and probe surface. */
export function staticKiroEffortModelIds(): string[] {
  return [...staticEffortDescriptors().keys()]
}

/** Drop the memoized descriptors. Test surface only. */
export function resetStaticKiroEffortCache(): void {
  cache = undefined
}

function staticEffortDescriptors(): Map<string, KiroModelEffortMetadata> {
  if (cache) return cache
  const descriptors = new Map<string, KiroModelEffortMetadata>()
  try {
    const models = (kiroModelsConfig as { models?: unknown }).models
    if (Array.isArray(models)) {
      for (const raw of models) {
        const entry = raw && typeof raw === "object" ? raw as StaticModelEntry : undefined
        const id = typeof entry?.id === "string" ? entry.id : undefined
        if (!id) continue
        const descriptor = effortDescriptorFromCapabilities(entry?.capabilities)
        if (!descriptor) continue
        descriptors.set(id, descriptor)
        if (!descriptors.has(id.toLowerCase())) descriptors.set(id.toLowerCase(), descriptor)
      }
    }
  } catch {
    // A malformed bundled file degrades to "no static descriptors", never to a crash.
    descriptors.clear()
  }
  cache = descriptors
  return descriptors
}

/**
 * Translate one `capabilities` object's `effort_*` booleans into the descriptor shape the registry
 * already uses.
 *
 * `levels` is exactly the flags that are `true`, in {@link STATIC_EFFORT_LEVELS} order — so
 * `effort_max: false` means `max` is **not** a level, and a model with every flag false (the
 * `claude-3.5-haiku` and `claude-3-haiku` entries) yields `undefined` rather than an empty enum.
 * An empty enum would be a claim that the model accepts effort while accepting nothing, and
 * `parseEffortMetadata()` never produces one either.
 *
 * ## Choosing `defaultLevel`
 *
 * The file states which levels are *accepted*; it does not state which one Kiro applies when a
 * request names none. So the default here is a decision, and it is the **lowest published level**
 * (`low` for every current entry). The reasoning:
 *
 * - This default is applied precisely when the client asked for nothing. Spending more reasoning
 *   than the client requested costs the user credits and latency they did not ask for, so the
 *   conservative rung is the defensible one; a client that wants more can say so, and its stated
 *   value outranks this default (`selectEffortLevel()` rung 1).
 * - It matches the only comparable measurement available: the live Codex descriptors resolve their
 *   default to `low`, so `low` keeps the two upstreams consistent rather than making Kiro
 *   unilaterally more expensive.
 * - It is a member of its own enum by construction, which is the containment post-condition
 *   `selectEffortLevel()` and Property 14 depend on.
 */
function effortDescriptorFromCapabilities(capabilities: unknown): KiroModelEffortMetadata | undefined {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined
  const flags = capabilities as Record<string, unknown>
  const levels = STATIC_EFFORT_LEVELS.filter((level) => flags[`effort_${level}`] === true)
  if (!levels.length) return undefined
  return {
    schemaPath: STATIC_EFFORT_SCHEMA_PATH,
    levels: [...levels],
    defaultLevel: levels[0]!,
    provenance: "static",
  }
}

function resolveStaticAlias(modelId: string): string {
  try {
    const aliases = (kiroModelsConfig as { aliases?: unknown }).aliases
    if (!aliases || typeof aliases !== "object") return modelId
    const target = (aliases as Record<string, unknown>)[modelId]
    return typeof target === "string" ? target : modelId
  } catch {
    return modelId
  }
}

// `bun run scripts/kiro-models-probe.ts` — investigation probe for the `native-api-mode` plan
// (blocks live gate 20.4 and the three red effort cases: effort-default, effort-degrade,
// thinking-budget).
//
// One question: does the live Kiro `ListAvailableModels` response carry an effort enum for the
// probed model, and if so at what JSON path? `KiroModelMetadataRegistry.populate()` reads only
// this response, and `parseEffortMetadata()` looks for an enum at exactly two paths inside each
// entry's `additionalModelRequestFieldsSchema`:
//
//   properties.output_config.properties.effort.enum
//   properties.reasoning.properties.effort.enum
//
// So the probe does three things and nothing more:
//   1. Exactly **one** metadata call — `Kiro_Client.listAvailableModelsFull()`. This is
//      `GET /ListAvailableModels`: no inference, no credits, no model tokens.
//   2. Dumps the **raw, unparsed** entry for the probed model, in full, including the whole
//      `additionalModelRequestFieldsSchema` object if one is present.
//   3. Walks the entry for **any** key named `effort` at **any** depth, so a schema published at a
//      path `parseEffortMetadata()` does not check is reported as an observed path rather than
//      being missed.
//
// Credentials are read from a copy via `copyNativeCredentials("kiro")`; the protected files —
// above all `~/.aws/sso/cache/kiro-auth-token.json` — are never written (Requirement 24.11).
// Every emitted body passes through `redactSensitiveText`, and header values are never printed.
//
// Output goes to stdout and to `$NATIVE_TRANSCRIPT_DIR/kiro-models-probe.md` (default
// `.native-transcripts/`, gitignored).
import { writeTextFile } from "../src/core/bun-fs"
import { redactSensitiveText } from "../src/core/debug-capture"
import { joinPath, makeDir } from "../src/core/paths"
import { Kiro_Auth_Manager } from "../src/upstream/kiro/auth"
import { Kiro_Client } from "../src/upstream/kiro/client"
import { KiroModelMetadataRegistry } from "../src/upstream/kiro/model-metadata"
import { staticKiroEffortDescriptor } from "../src/upstream/kiro/static-models"

import { copyNativeCredentials } from "../test/native/credentials"
import { nativeMatrixOutputDir } from "../test/native/matrix-source"

const TARGET_MODEL = process.env.KIRO_MODELS_PROBE_MODEL ?? "claude-sonnet-4.5"

const report: string[] = []

const credentials = await copyNativeCredentials("kiro")
try {
  const auth = await Kiro_Auth_Manager.fromAuthFile(credentials.authFile)
  const client = new Kiro_Client(auth)

  say(`credential copy: ${credentials.authFile}`)
  say(`source (read-only): ${credentials.sourceAuthFile}`)
  say(`auth type: ${auth.getAuthType()}`)
  say(`target model: ${TARGET_MODEL}`)
  for (const note of credentials.notes) say(`note: ${note}`)
  say("")

  // ── the one and only call ──
  const body = await client.listAvailableModelsFull()

  say("## response shape (top level)")
  say("")
  say(`type: ${describeType(body)}`)
  say(`top-level keys: ${isRecord(body) ? Object.keys(body).join(", ") || "(none)" : "n/a"}`)

  // The one call above is now a **paginated walk** (`nextToken` followed to completion, page-capped),
  // so the merged body reports how many pages it took and whether the cap ended the walk. A
  // `capReached: true` here means the catalog is larger than the walk read, and the cap needs
  // raising rather than the result trusting.
  const pagination = isRecord(body) ? body.modelPagination : undefined
  say(`pagination: ${pagination ? JSON.stringify(pagination) : "(absent — first page unusable)"}`)
  say(`nextToken on merged body: ${isRecord(body) && body.nextToken !== undefined ? "PRESENT (unexpected)" : "absent, as expected after a completed walk"}`)

  const entries = modelEntries(body)
  say(`entries found: ${entries.length}`)
  say(`entry model ids: ${entries.map((entry) => modelIdOf(entry) ?? "(no modelId)").join(", ") || "(none)"}`)
  say("")

  const target = entries.find((entry) => modelIdOf(entry) === TARGET_MODEL)
    ?? entries.find((entry) => (modelIdOf(entry) ?? "").includes(TARGET_MODEL))

  if (!target) {
    say(`## FINDING: no entry for ${TARGET_MODEL}`)
    say("")
    say("raw response body (redacted):")
    say("")
    say(fence(body))
  } else {
    say(`## raw entry for ${modelIdOf(target)} (verbatim, redacted)`)
    say("")
    say(fence(target))
    say("")

    const schema = isRecord(target) ? target.additionalModelRequestFieldsSchema : undefined
    say("## additionalModelRequestFieldsSchema")
    say("")
    if (schema === undefined) {
      say("KEY ABSENT — the entry carries no `additionalModelRequestFieldsSchema` key at all.")
    } else if (schema === null) {
      say("KEY PRESENT, VALUE `null` — the field is declared by the API and explicitly empty.")
    } else {
      say(`present, type ${describeType(schema)}:`)
      say("")
      say(fence(schema))
    }
    say("")

    say("## `additionalModelRequestFieldsSchema` across every entry in the same response")
    say("")
    for (const entry of entries) {
      const id = modelIdOf(entry) ?? "(no modelId)"
      const entrySchema = isRecord(entry) ? entry.additionalModelRequestFieldsSchema : undefined
      const state = !isRecord(entry)
        ? "string entry, no schema field"
        : entrySchema === undefined
          ? "key absent"
          : entrySchema === null
            ? "null"
            : `${describeType(entrySchema)} — effort keys: ${findKey(entrySchema, "effort").map((hit) => hit.path).join(", ") || "none"}`
      say(`- ${id}: ${state}`)
    }
    say("")

    say("## every `effort` key in the entry, at any depth")
    say("")
    const hits = findKey(target, "effort")
    if (!hits.length) {
      say("NONE — no key named `effort` appears anywhere in the entry.")
    } else {
      for (const hit of hits) {
        say(`- path: \`${hit.path}\``)
        say(`  value: ${redactSensitiveText(JSON.stringify(hit.value))}`)
      }
    }
    say("")

    say("## every `enum` key in the entry, at any depth")
    say("")
    const enums = findKey(target, "enum")
    if (!enums.length) say("NONE")
    else for (const hit of enums) say(`- \`${hit.path}\` = ${redactSensitiveText(JSON.stringify(hit.value))}`)
    say("")

    // What the shipped parser makes of the same bytes — the two are printed side by side so the
    // verdict is a comparison, not an inference.
    const registry = new KiroModelMetadataRegistry()
    registry.populate(body)
    const parsed = registry.get(TARGET_MODEL)
    say("## what the shipped registry makes of the same bytes")
    say("")
    say(`registry populated: ${registry.isPopulated}`)
    say(`registry model ids: ${registry.modelIds().join(", ") || "(none)"}`)
    say(`entry present for ${TARGET_MODEL}: ${Boolean(parsed)}`)
    say(`richMetadata: ${parsed?.richMetadata}`)
    say(`effort descriptor: ${parsed?.effort ? JSON.stringify(parsed.effort) : "undefined (omitted)"}`)
    say(`effort provenance: ${parsed?.effort?.provenance ?? "none"}`
      + ` — \`live\` means the endpoint published this enum; \`static\` means the bundled`
      + ` \`kiro-models.json\` filled a gap the endpoint left.`)
    say(`static descriptor for the same model: ${JSON.stringify(staticKiroEffortDescriptor(TARGET_MODEL)) ?? "none"}`)
    say("")

    say("## effort provenance across every model in the merged response")
    say("")
    for (const entry of registry.all()) {
      say(`- ${entry.modelId}: ${entry.effort ? `${entry.effort.provenance ?? "unmarked"} [${entry.effort.levels.join(", ")}]` : "no effort descriptor"}`)
    }
    say("")

    const parserPaths = [
      "properties.output_config.properties.effort.enum",
      "properties.reasoning.properties.effort.enum",
    ]
    say("## verdict")
    say("")
    if (parsed?.effort?.provenance === "live") {
      say(`CASE 2/OK — the parser DID find an effort enum on the wire: schemaPath=${parsed.effort.schemaPath}, `
        + `levels=${JSON.stringify(parsed.effort.levels)}, defaultLevel=${parsed.effort.defaultLevel ?? "none"}.`)
    } else if (parsed?.effort?.provenance === "static") {
      say("CASE 1 + FALLBACK APPLIED — the live entry published no effort enum, so the bundled "
        + `\`kiro-models.json\` descriptor filled the gap: schemaPath=${parsed.effort.schemaPath}, `
        + `levels=${JSON.stringify(parsed.effort.levels)}, defaultLevel=${parsed.effort.defaultLevel ?? "none"}. `
        + "This is a shipped assumption, not a measurement — which is what `provenance: \"static\"` records.")
    } else if (schema === undefined || schema === null) {
      say("CASE 1 — the live response carries no usable `additionalModelRequestFieldsSchema` for "
        + `this account and endpoint (${schema === null ? "the field is present with value `null`" : "the key is absent"}), `
        + "so there is no effort enum to read at any path.")
    } else if (hits.length) {
      say("CASE 2 — the schema is present and DOES carry an `effort` key, but not at either path "
        + `the parser checks (${parserPaths.join(" | ")}). Observed paths are listed above verbatim.`)
    } else {
      say("CASE 1 — the schema is present but carries no `effort` key anywhere inside it.")
    }
  }
} finally {
  await credentials.cleanup().catch(() => {})
  await writeReport()
}

// ── helpers ──

/** Model entries across every shape `populate()` accepts, plus `defaultModel`. */
function modelEntries(body: unknown): unknown[] {
  if (!isRecord(body)) return []
  const out: unknown[] = []
  if (Array.isArray(body.models)) out.push(...body.models)
  if (body.defaultModel !== undefined) out.push(body.defaultModel)
  if (Array.isArray(body.modelIds)) out.push(...body.modelIds)
  return out
}

function modelIdOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (!isRecord(entry)) return undefined
  return typeof entry.modelId === "string" ? entry.modelId : typeof entry.id === "string" ? entry.id : undefined
}

interface KeyHit {
  path: string
  value: unknown
}

/** Depth-first walk collecting every occurrence of `key`, with its full JSON path. */
function findKey(value: unknown, key: string, path = "$"): KeyHit[] {
  const hits: KeyHit[] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findKey(item, key, `${path}[${index}]`)))
    return hits
  }
  if (!isRecord(value)) return hits
  for (const [name, child] of Object.entries(value)) {
    const childPath = `${path}.${name}`
    if (name === key) hits.push({ path: childPath, value: child })
    hits.push(...findKey(child, key, childPath))
  }
  return hits
}

function fence(value: unknown) {
  return ["```json", redactSensitiveText(JSON.stringify(value, null, 2) ?? String(value)), "```"].join("\n")
}

function describeType(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function say(line: string) {
  console.log(line)
  report.push(line)
}

async function writeReport() {
  const dir = nativeMatrixOutputDir()
  const file = joinPath(dir, "kiro-models-probe.md")
  await makeDir(dir)
  await writeTextFile(file, `# Kiro ListAvailableModels probe — effort enum presence\n\n${report.join("\n")}\n`)
  console.log(`\nwrote ${file}`)
}

export {}

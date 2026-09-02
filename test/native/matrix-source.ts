// Role: resolve what the matrix walk can actually know today — the feature vocabulary, the
// per-upstream declarations, and any recorded observations. This is the only file in the
// walk that touches the filesystem or reaches into `src/`, so `verify-matrix.ts` stays pure.
//
// The capability layer (`PROVIDER_FEATURES` in core, `features` on each upstream's
// `capabilities.ts`) lands in later tasks. Until then every lookup here degrades to a note
// naming the missing declaration, and the affected cells read `unresolved`. When the real
// matrix lands, these readers pick it up with no change to the walk or to the script.

import { pathExists, readTextFile } from "../../src/core/bun-fs"
import { joinPath } from "../../src/core/paths"

import {
  MATRIX_POLICIES,
  PLANNED_PROVIDER_FEATURES,
  type MatrixDeclaration,
  type MatrixPolicy,
  type NativeMatrixObservation,
  type NativeMatrixSource,
  NATIVE_MATRIX_ROUTES,
  NATIVE_MATRIX_UPSTREAMS,
} from "./verify-matrix"
import type { NativeRoutePath, NativeUpstreamKind } from "./types"

/**
 * Output directory for `matrix.md`. Resolved here rather than through the Transcript_Writer
 * so the walk runs even when no transcript has ever been written.
 */
export const NATIVE_TRANSCRIPT_DIR_ENV = "NATIVE_TRANSCRIPT_DIR"
export const DEFAULT_NATIVE_TRANSCRIPT_DIR = ".native-transcripts"
export const NATIVE_MATRIX_FILE_NAME = "matrix.md"
export const NATIVE_OBSERVATIONS_FILE_NAME = "observations.json"

export function nativeMatrixOutputDir(env: Record<string, string | undefined> = process.env) {
  const configured = env[NATIVE_TRANSCRIPT_DIR_ENV]?.trim()
  return configured || DEFAULT_NATIVE_TRANSCRIPT_DIR
}

export function nativeMatrixFile(env: Record<string, string | undefined> = process.env) {
  return joinPath(nativeMatrixOutputDir(env), NATIVE_MATRIX_FILE_NAME)
}

export function nativeObservationsFile(env: Record<string, string | undefined> = process.env) {
  return joinPath(nativeMatrixOutputDir(env), NATIVE_OBSERVATIONS_FILE_NAME)
}

/** Where each upstream's declared policies will live once tasks 6.1 and 6.2 land. */
const UPSTREAM_CAPABILITY_MODULES: Readonly<Record<NativeUpstreamKind, { specifier: string; exportName: string }>> = {
  kiro: { specifier: "../../src/upstream/kiro/capabilities", exportName: "KIRO_CAPABILITIES" },
  codex: { specifier: "../../src/upstream/codex/capabilities", exportName: "CODEX_CAPABILITIES" },
}

const CORE_CAPABILITIES_MODULE = "../../src/core/provider-capabilities"

export async function loadNativeMatrixSource(): Promise<NativeMatrixSource> {
  const notes: string[] = []
  const core = await importModule(CORE_CAPABILITIES_MODULE)
  const vocabulary = readFeatureVocabulary(core)
  if (vocabulary.featureSource === "planned") {
    notes.push(
      `\`src/core/provider-capabilities.ts\` exports no \`PROVIDER_FEATURES\` yet, so the walk uses the planned ${PLANNED_PROVIDER_FEATURES.length}-feature vocabulary`,
    )
  }

  const declarations: Partial<Record<NativeUpstreamKind, MatrixDeclaration>> = {}
  for (const upstream of NATIVE_MATRIX_UPSTREAMS) {
    const target = UPSTREAM_CAPABILITY_MODULES[upstream]
    const module = await importModule(target.specifier)
    if (!module) {
      notes.push(`\`${target.specifier.replace("../../", "")}.ts\` is not importable, so every ${upstream} cell is unresolved`)
      continue
    }

    const declaration = readDeclaration(module, target.exportName)
    if (!declaration) {
      notes.push(`\`${target.exportName}\` declares no \`features\` map yet, so every ${upstream} cell is unresolved`)
      continue
    }

    declarations[upstream] = declaration
    const missing = vocabulary.features.filter((feature) => !(feature in declaration.features))
    if (missing.length) {
      notes.push(`\`${target.exportName}.features\` omits ${missing.join(", ")}, so those ${upstream} cells are unresolved`)
    }
  }

  return { features: vocabulary.features, featureSource: vocabulary.featureSource, declarations, notes }
}

async function importModule(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    // Non-literal on purpose: these modules are added by later tasks, so the walk must
    // survive their absence at both compile time and run time.
    const module = (await import(specifier)) as unknown
    return isRecord(module) ? module : undefined
  } catch {
    return undefined
  }
}

function readFeatureVocabulary(module: Record<string, unknown> | undefined) {
  const declared = module?.PROVIDER_FEATURES
  if (Array.isArray(declared) && declared.length && declared.every((value) => typeof value === "string")) {
    return { features: declared as readonly string[], featureSource: "core" as const }
  }
  return { features: [...PLANNED_PROVIDER_FEATURES] as readonly string[], featureSource: "planned" as const }
}

function readDeclaration(module: Record<string, unknown>, exportName: string): MatrixDeclaration | undefined {
  const capabilities = module[exportName]
  const features = isRecord(capabilities) ? capabilities.features : undefined
  if (!isRecord(features)) return undefined

  const declared: Record<string, MatrixPolicy> = {}
  for (const [feature, policy] of Object.entries(features)) {
    if (isMatrixPolicy(policy)) declared[feature] = policy
  }
  if (!Object.keys(declared).length) return undefined

  return { features: declared, source: `${exportName}.features` }
}

export interface LoadedNativeMatrixObservations {
  observations: readonly NativeMatrixObservation[]
  /** One line describing where the observations came from, for the matrix.md header. */
  source: string
  /** Structural problems found while reading, surfaced rather than swallowed. */
  notes: readonly string[]
}

/**
 * Reads the observation records a live run left behind. The file is optional by design: the
 * walk is runnable offline, and an absent file means "not measured", never "matches".
 *
 * Accepted shapes: a bare array of records, or `{ "observations": [ … ] }`.
 */
export async function loadNativeMatrixObservations(
  file: string,
  read: (path: string) => Promise<string> = readTextFile,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<LoadedNativeMatrixObservations> {
  if (!(await exists(file))) {
    return { observations: [], source: `none recorded (\`${file}\` absent)`, notes: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await read(file)) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { observations: [], source: `unreadable (\`${file}\`)`, notes: [`\`${file}\` is not valid JSON: ${detail}`] }
  }

  const records = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.observations) ? parsed.observations : undefined
  if (!records) {
    return {
      observations: [],
      source: `unreadable (\`${file}\`)`,
      notes: [`\`${file}\` holds neither an array nor an \`observations\` array`],
    }
  }

  const observations: NativeMatrixObservation[] = []
  const notes: string[] = []
  records.forEach((record, index) => {
    const observation = parseObservation(record)
    if (observation) observations.push(observation)
    else notes.push(`\`${file}\` entry ${index} is not a usable observation record`)
  })

  return { observations, source: `${observations.length} record(s) from \`${file}\``, notes }
}

function parseObservation(record: unknown): NativeMatrixObservation | undefined {
  if (!isRecord(record)) return undefined
  const route = record.route
  const upstream = record.upstream
  const feature = record.feature
  if (!isRoute(route) || !isUpstream(upstream) || typeof feature !== "string" || !feature) return undefined

  return {
    route,
    upstream,
    feature,
    noticeObserved: record.noticeObserved === true,
    ...(typeof record.requested === "boolean" ? { requested: record.requested } : {}),
    ...(typeof record.caseId === "string" ? { caseId: record.caseId } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
  }
}

function isRoute(value: unknown): value is NativeRoutePath {
  return typeof value === "string" && (NATIVE_MATRIX_ROUTES as readonly string[]).includes(value)
}

function isUpstream(value: unknown): value is NativeUpstreamKind {
  return typeof value === "string" && (NATIVE_MATRIX_UPSTREAMS as readonly string[]).includes(value)
}

function isMatrixPolicy(value: unknown): value is MatrixPolicy {
  return typeof value === "string" && (MATRIX_POLICIES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

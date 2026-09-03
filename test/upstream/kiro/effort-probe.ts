// Feature: native-api-mode — a Kiro provider wired to a fake client, for the effort branch.
//
// Task 22.1 moved the effort decision from "return a 400" to "substitute, notice, and send", and
// that outcome is only observable *through the provider*: the level lands in the payload the
// client is handed, and the notice lands on the canonical result. Neither is visible from
// `src/upstream/kiro/effort.ts`, which is pure.
//
// So this harness exists to make one question cheap to ask: given a model whose effort enum is
// `levels`, and a client that asked for `requested`, what went upstream and what was the client
// told? It is shared by `effort.property.test.ts` (Property 14's substitution half and Property
// 5's strict half) and `effort-branch.test.ts` (task 22.3's units) rather than written twice,
// because a second copy is a second place the fake model metadata shape can drift from
// `parseEffortMetadata()`.
//
// It fakes the transport only. `Kiro_Upstream_Provider`, `KiroModelMetadataRegistry`,
// `resolveKiroFeatures()`, `convertCanonicalToKiroPayload()` and the real feature-policy
// resolution all run, so an assertion here is about the code under test and not about a mock's
// idea of it.

import type { Canonical_Request } from "../../../src/core/canonical"
import type { UpstreamResult } from "../../../src/core/interfaces"
import { Kiro_Auth_Manager, Kiro_Client, Kiro_Upstream_Provider } from "../../../src/upstream/kiro"
import type { KiroEffortSchemaPath } from "../../../src/upstream/kiro/model-metadata"

/** A name no normalization rule in `normalizeKiroModelName()` rewrites, so metadata always matches. */
export const PROBE_MODEL = "kiro-effort-probe"

export interface KiroEffortProbeOptions {
  /**
   * The effort enum this model publishes. `undefined` is a model that publishes **no** effort
   * schema at all — the `effort_unsupported` class, which is a different branch from an
   * out-of-enum value and needs its own descriptor state to reach.
   */
  levels?: readonly string[]
  /** Which `additionalModelRequestFields` shape the model uses. Both are live in Kiro's catalog. */
  schemaPath?: KiroEffortSchemaPath
  defaultLevel?: string
  /** Whether `degrade` escalates to a 400. Passed to the provider, never read here. */
  strict?: boolean
  /**
   * When set, `listAvailableModelsFull()` rejects, so the metadata registry stays unpopulated —
   * the `metadata_unavailable` state, which must keep its existing 503 (Requirement 16.6).
   */
  metadataUnavailable?: boolean
}

export interface KiroEffortProbe {
  /**
   * Proxy one non-streaming request stating `requested` as its effort and `thinking` as its
   * thinking member.
   *
   * `thinking` is the task 23 addition: the budget rung is only observable through the provider,
   * because the notice that reports a mapped budget is emitted in `src/upstream/kiro/index.ts` and
   * the mapped level only becomes visible once it is written into the payload. Both arguments are
   * optional and independent, which is what lets one call express "explicit value plus a budget" —
   * the input Requirement 16.8's zero-notice half is about.
   */
  /**
   * `extra` merges further canonical members into the request — the task 14b.8 addition, so one
   * call can express "a request that also carries a field this upstream rejects". That combination
   * is the only way to observe the deferred effort decision on the rejection path: the notice is
   * decided inside `resolveRequestedEffort()` and has to be readable off a 400.
   */
  proxy(requested?: string, thinking?: Canonical_Request["thinking"], extra?: Partial<Canonical_Request>): Promise<UpstreamResult>
  /** The effort level on the last payload handed to the client, or `undefined` when none was sent. */
  sentEffort(): string | undefined
  /** How many upstream generate calls happened. Zero proves a rejection cost nothing. */
  upstreamCalls(): number
  /**
   * How many times the model catalog was read.
   *
   * Zero on a refused request that stated no effort intent is what proves the deferred decision is
   * guarded rather than paid for on every rejection.
   */
  metadataFetches(): number
}

function probeAuth() {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }, "/tmp/unused")
}

/**
 * The `additionalModelRequestFieldsSchema` a Kiro model publishes for its effort enum.
 *
 * Written as the real nested schema rather than as a pre-parsed descriptor so
 * `parseEffortMetadata()` runs on it: the levels the provider validates against are the levels it
 * would extract from a live catalog response, not a shape a test invented.
 */
function effortSchema(options: KiroEffortProbeOptions) {
  if (!options.levels) return null
  const schemaPath = options.schemaPath ?? "output_config"
  return {
    properties: {
      [schemaPath]: {
        properties: {
          effort: {
            enum: [...options.levels],
            ...(options.defaultLevel !== undefined ? { default: options.defaultLevel } : {}),
          },
        },
      },
    },
  }
}

export function kiroEffortProbe(options: KiroEffortProbeOptions = {}): KiroEffortProbe {
  const schemaPath = options.schemaPath ?? "output_config"
  const payloads: Record<string, any>[] = []
  let metadataFetches = 0
  const client = {
    generateAssistantResponse: (body: Record<string, any>) => {
      payloads.push(body)
      return Promise.resolve(new Response('{"content":"ok"}'))
    },
    listAvailableModels: () => Promise.resolve([PROBE_MODEL]),
    listAvailableModelsFull: () => {
      metadataFetches += 1
      return options.metadataUnavailable
        ? Promise.reject(new Error("model catalog unavailable"))
        : Promise.resolve({ models: [{ modelId: PROBE_MODEL, additionalModelRequestFieldsSchema: effortSchema(options) }] })
    },
    checkHealth: () => Promise.resolve({ ok: true }),
  }
  const provider = new Kiro_Upstream_Provider({
    auth: probeAuth(),
    client: client as unknown as Kiro_Client,
    strict: options.strict ?? false,
  })

  return {
    proxy: (requested?: string, thinking?: Canonical_Request["thinking"], extra?: Partial<Canonical_Request>) =>
      provider.proxy(probeRequest(requested, thinking, extra)),
    sentEffort: () => payloads.at(-1)?.additionalModelRequestFields?.[schemaPath]?.effort,
    upstreamCalls: () => payloads.length,
    metadataFetches: () => metadataFetches,
  }
}

/**
 * The smallest request that exercises the effort branch: no tools, no streaming, one short user
 * turn. `tools: []` keeps the web-search auto-injection and its preflight out of the picture, so
 * the only upstream call a run makes is the generate call the assertions count.
 */
function probeRequest(requested?: string, thinking?: Canonical_Request["thinking"], extra?: Partial<Canonical_Request>): Canonical_Request {
  return {
    model: PROBE_MODEL,
    instructions: "Be helpful",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [],
    stream: false,
    passthrough: false,
    metadata: {},
    ...(requested !== undefined ? { reasoningEffort: requested } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(extra ?? {}),
  }
}

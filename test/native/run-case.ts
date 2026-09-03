// Role: run one Live_Case end to end and hand back what it produced. This is the only module
// in the harness that performs a live call, so `live.test.ts` stays a thin, registry-driven
// declaration of the 14 cases and every step below is reachable from an offline test.
//
// Order of operations, and why: credentials are copied first so nothing downstream can reach
// the real account files (Requirement 24.11); the MCP fixture starts before the gateway so the
// case body can carry its loopback url (Requirement 24.10); the gateway starts with exactly
// the flags the case declares and none inherited from the shell; the transcript is written
// before assertions are reported, so a failing case still leaves the evidence behind
// (Requirement 25.1).
import { copyNativeCredentials, type NativeCredentialCopy } from "./credentials"
import { callUpstreamDirectly, type DirectUpstreamCall } from "./direct-upstream"
import { startNativeGateway } from "./gateway"
import { nativeMatrixObservationsFor } from "./matrix-records"
import { startNativeMcpFixture, type NativeMcpFixture } from "./mcp-fixture"
import { resolveNativeCaseBody } from "./cases"
import { captureNativeObservation } from "./response-capture"
import { nativeUpstreamCapture, writeNativeTranscript, type NativeTranscriptResult } from "./transcript"
import type { NativeLiveCase, NativeLiveObservation } from "./types"
import type { NativeMatrixObservation } from "./verify-matrix"

/** One live call plus a possible direct reference call; generous, since providers are slow. */
export const DEFAULT_NATIVE_CASE_TIMEOUT_MS = 180_000

/** How long to wait for the sync request log carrying the upstream capture. */
export const DEFAULT_NATIVE_LOG_TIMEOUT_MS = 30_000

export interface NativeAssertionFailure {
  id: string
  description: string
  detail: string
}

export interface NativeCaseRunResult {
  liveCase: NativeLiveCase
  observation: NativeLiveObservation
  transcript: NativeTranscriptResult
  /** Empty when the case passed. Each entry names the assertion and why it failed. */
  failures: readonly NativeAssertionFailure[]
  matrixObservations: readonly NativeMatrixObservation[]
  /** True when the client bytes equal the upstream bytes captured for this same request. */
  clientBytesMatchUpstreamBytes?: boolean
}

export interface RunNativeLiveCaseOptions {
  /** Transcript output directory; defaults to the Transcript_Writer's own resolution. */
  transcriptDir?: string
  logTimeoutMs?: number
  signal?: AbortSignal
}

export async function runNativeLiveCase(
  liveCase: NativeLiveCase,
  options: RunNativeLiveCaseOptions = {},
): Promise<NativeCaseRunResult> {
  const started = Date.now()
  const teardown: Array<() => Promise<void>> = []

  let credentials: NativeCredentialCopy | undefined
  let fixture: NativeMcpFixture | undefined

  try {
    credentials = await copyNativeCredentials(liveCase.upstream)
    const copy = credentials
    teardown.push(() => copy.cleanup())
    // Printed, not swallowed: a case that goes red because a credential expired must be readable
    // as expiry rather than as a fidelity regression (Requirement 26.3, research §10.8 finding B).
    for (const note of copy.notes) console.warn(`${liveCase.id} credential: ${note}`)

    if (liveCase.requiresMcpFixture) {
      fixture = await startNativeMcpFixture()
      const running = fixture
      teardown.push(() => running.stop())
    }

    const gateway = await startNativeGateway({ upstream: liveCase.upstream, flags: liveCase.flags, credentials })
    teardown.push(() => gateway.stop())

    const body = resolveNativeCaseBody(liveCase, fixture ? { mcpServerUrl: fixture.url } : {})
    const response = await gateway.post(liveCase.route, body, options.signal ? { signal: options.signal } : undefined)
    const clientBody = await response.text()

    // `requestLogMode: "sync"` emits the entry once the client body is fully read, so this
    // resolves immediately in the normal case; the timeout only covers a run that errored
    // before the log landed, and a missing log is recorded rather than thrown.
    const requestLog = await gateway
      .waitForLog({
        predicate: (entry) => entry.path === liveCase.route,
        timeoutMs: options.logTimeoutMs ?? DEFAULT_NATIVE_LOG_TIMEOUT_MS,
      })
      .catch(() => undefined)

    let direct: DirectUpstreamCall | undefined
    if (liveCase.requiresDirectUpstreamCall) {
      direct = await callUpstreamDirectly({
        liveCase,
        credentials,
        fallbackBody: body,
        ...(requestLog?.proxy?.requestBody ? { upstreamRequestBody: requestLog.proxy.requestBody } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    }

    const observation = captureNativeObservation({
      caseId: liveCase.id,
      response,
      clientBody,
      logs: gateway.logs,
      ...(requestLog ? { requestLog } : {}),
      ...(direct ? { directUpstreamBody: direct.body } : {}),
    })

    const upstreamBytes = nativeUpstreamCapture(observation).responseBody
    const clientBytesMatchUpstreamBytes = upstreamBytes === undefined ? undefined : upstreamBytes === observation.clientBody

    const transcript = await writeNativeTranscript({
      liveCase,
      observation,
      clientRequest: { method: "POST", path: liveCase.route, headers: { "content-type": "application/json" }, body },
      volatile: {
        "run duration ms": Date.now() - started,
        "upstream request count": observation.upstreamRequestCount ?? "(not counted)",
        "client bytes": observation.clientBody.length,
        ...telemetryVolatile(observation),
        ...(credentials.notes.length ? { "credential notes": credentials.notes.join(" | ") } : {}),
        ...(clientBytesMatchUpstreamBytes === undefined
          ? {}
          : { "client bytes equal captured upstream bytes": clientBytesMatchUpstreamBytes ? "yes" : "no" }),
        ...(direct
          ? {
              "direct upstream call status": direct.status,
              "direct upstream call body source": direct.bodySource,
              "direct upstream bytes": direct.body.length,
            }
          : {}),
        ...(fixture
          ? {
              "mcp fixture url": fixture.url,
              "mcp fixture methods": fixture.methodSequence().join(", ") || "(none)",
              "mcp fixture tool calls": fixture.toolCallNames().join(", ") || "(none)",
            }
          : {}),
      },
      ...(options.transcriptDir ? { dir: options.transcriptDir } : {}),
    })

    return {
      liveCase,
      observation,
      transcript,
      failures: evaluateAssertions(liveCase, observation),
      matrixObservations: nativeMatrixObservationsFor(liveCase, observation),
      ...(clientBytesMatchUpstreamBytes === undefined ? {} : { clientBytesMatchUpstreamBytes }),
    }
  } finally {
    // Reverse order, and every step is attempted: one failing teardown must not leak a
    // listening socket, a running server, or a credential copy into the next case.
    for (const step of teardown.reverse()) await step().catch(() => {})
  }
}

/**
 * The stream telemetry the inbound provider attached to `RequestProxyLog` (task 8.3b/8.4),
 * quarantined in `## volatile` because provider credits and durations change every run
 * (Requirement 25.8). Read-only: it reports what the request log already carries and adds no
 * capture mechanism, so a maintainer can read a run's spend out of the transcript instead of
 * re-deriving it from raw upstream frames.
 */
export function telemetryVolatile(observation: NativeLiveObservation): Record<string, string | number> {
  const telemetry = observation.requestLog?.proxy?.telemetry
  if (!telemetry) return { "telemetry on request log": observation.requestLog?.proxy ? "absent" : "(no proxy log)" }

  const notices = telemetry.featureNotices
  return {
    "telemetry on request log": "present",
    "provider credits": telemetry.providerCredits === undefined ? "(not measured)" : telemetry.providerCredits,
    "telemetry feature notices": notices?.length
      ? notices.map((notice) => `${notice.feature}=${notice.policy}`).join(", ")
      : notices
        ? "(empty array)"
        : "(omitted)",
  }
}

/** A throwing assertion is reported as a failure, never propagated past the transcript. */
export function evaluateAssertions(
  liveCase: NativeLiveCase,
  observation: NativeLiveObservation,
): NativeAssertionFailure[] {
  const failures: NativeAssertionFailure[] = []

  for (const assertion of liveCase.assertions) {
    try {
      const result = assertion.evaluate(observation)
      if (!result.ok) failures.push({ id: assertion.id, description: assertion.description, detail: result.detail })
    } catch (error) {
      failures.push({
        id: assertion.id,
        description: assertion.description,
        detail: `assertion threw: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return failures
}

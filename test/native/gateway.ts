// Role: in-process gateway lifecycle for the live harness. Starts the real runtime on an
// ephemeral port against copied credentials, captures request logs, and restores the
// environment on stop.
//
// `logBody: true` plus `requestLogMode: "sync"` is what makes the transcript possible: the
// inbound providers already fill `RequestProxyLog.requestBody` from `onRequestBody` and
// `RequestProxyLog.responseBody` from `onResponseBodyChunk`, so the harness adds no capture
// mechanism of its own (Requirement 25.4).
import { startRuntime } from "../../src/app/runtime"
import type { ProviderMode } from "../../src/core/provider-state"
import type { JsonObject, RequestLogEntry, RuntimeOptions } from "../../src/core/types"

import { copyNativeCredentials, type NativeCredentialCopy } from "./credentials"
import type { NativeFlagName, NativeFlagValues, NativeUpstreamKind } from "./types"

/**
 * Every native-mode flag. A case declares the ones it needs; the rest are cleared, so an
 * ambient value in the developer's shell cannot change what a case measures.
 * `src/app/native-flags.ts` becomes the runtime's only reader of these in M7.
 */
export const NATIVE_FLAG_NAMES: readonly NativeFlagName[] = [
  "NATIVE_STRICT",
  "NATIVE_PASSTHROUGH",
  "NATIVE_MCP_EMULATION",
  "KIRO_WEB_SEARCH_HEURISTICS",
]

/** Enabling values match `kiroDebugOnErrorEnabled()`; everything else is disabled. */
export function isEnablingValue(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase())
}

/** Bootstrap accepts these beyond `RuntimeOptions`; passing them avoids mutating the env. */
type NativeRuntimeOptions = RuntimeOptions & { providerMode: ProviderMode; providerConfigPath?: string }

export interface NativeGatewayOptions {
  upstream: NativeUpstreamKind
  flags?: NativeFlagValues
  /** Reuse an existing credential copy; one is made and owned by the gateway when omitted. */
  credentials?: NativeCredentialCopy
  onRequestLog?: (entry: RequestLogEntry) => void
}

export interface NativeGateway {
  upstream: NativeUpstreamKind
  url: string
  port: number
  authFile: string
  credentials: NativeCredentialCopy
  /** Completed request log entries, in arrival order. */
  logs: RequestLogEntry[]
  resetLogs: () => void
  waitForLog: (options?: { predicate?: (entry: RequestLogEntry) => boolean; timeoutMs?: number }) => Promise<RequestLogEntry>
  post: (routePath: string, body: JsonObject, init?: RequestInit) => Promise<Response>
  stop: () => Promise<void>
}

export async function startNativeGateway(options: NativeGatewayOptions): Promise<NativeGateway> {
  const ownsCredentials = !options.credentials
  const credentials = options.credentials ?? (await copyNativeCredentials(options.upstream))
  const restoreFlags = applyFlags(options.flags ?? {})
  const logs: RequestLogEntry[] = []

  const runtimeOptions: NativeRuntimeOptions = {
    providerMode: options.upstream,
    authFile: credentials.authFile,
    ...(credentials.providerConfigPath ? { providerConfigPath: credentials.providerConfigPath } : {}),
    hostname: "127.0.0.1",
    port: 0,
    healthIntervalMs: 0,
    logBody: true,
    requestLogMode: "sync",
    quiet: true,
    onRequestLog: (entry) => {
      logs.push(entry)
      options.onRequestLog?.(entry)
    },
  }

  let server: Awaited<ReturnType<typeof startRuntime>>
  try {
    server = await startRuntime(runtimeOptions)
  } catch (error) {
    restoreFlags()
    if (ownsCredentials) await credentials.cleanup().catch(() => {})
    throw error
  }

  const port = server.port
  if (!port) {
    server.stop(true)
    restoreFlags()
    if (ownsCredentials) await credentials.cleanup().catch(() => {})
    throw new Error("The native gateway started without exposing a port")
  }

  const url = `http://127.0.0.1:${port}`

  return {
    upstream: options.upstream,
    url,
    port,
    authFile: credentials.authFile,
    credentials,
    logs,
    resetLogs() {
      logs.length = 0
    },
    async waitForLog({ predicate, timeoutMs = 30_000 } = {}) {
      const matches = (entry: RequestLogEntry) => entry.state !== "pending" && (predicate?.(entry) ?? true)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = logs.find(matches)
        if (found) return found
        await Bun.sleep(10)
      }
      throw new Error(`No matching request log arrived within ${timeoutMs}ms`)
    },
    post(routePath, body, init) {
      return fetch(`${url}${routePath}`, {
        method: "POST",
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        body: JSON.stringify(body),
      })
    },
    async stop() {
      server.stop(true)
      restoreFlags()
      if (ownsCredentials) await credentials.cleanup().catch(() => {})
    },
  }
}

/**
 * The flag values the process started with, read once before any case can touch them.
 *
 * Restoring to this baseline rather than to a per-call snapshot is what keeps two gateways
 * whose lifetimes overlap from handing each other a stale value: the outer one's `stop()` would
 * otherwise re-set the flags the inner one had just cleared, and the inner case would measure
 * an environment it never declared.
 */
const BASELINE_FLAGS: ReadonlyMap<NativeFlagName, string | undefined> = new Map(
  NATIVE_FLAG_NAMES.map((name) => [name, process.env[name]]),
)

function applyFlags(flags: NativeFlagValues) {
  for (const name of NATIVE_FLAG_NAMES) {
    const value = flags[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  return () => {
    for (const [name, value] of BASELINE_FLAGS) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

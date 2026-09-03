// Abort behavior of the core MCP client (task 31.5, Requirement 20.6).
//
// The client layers three signals over one `fetch`: a client-wide signal, a per-call signal, and a
// timeout it creates itself. `mergeSignals` folds the first two together and `withTimeout` wraps the
// result, so what reaches `fetch` is a *derived* signal two hops from anything the caller holds.
// Two things can go wrong in that arrangement and neither shows up in a happy-path test:
//
//   1. A hop that forgets to forward. Then the caller aborts, the derived signal stays live, and the
//      in-flight request runs to completion — the request is not cancelled, only ignored. So the
//      assertion is on the signal `fetch` actually received, not on how fast the promise settled,
//      and it is made for each signal source independently.
//   2. Reclassification. `fetchOnce` wraps every thrown error into `McpProtocolError("transport")`,
//      which is right for a connection reset and wrong for a caller's own abort: the caller asked to
//      stop, and it must see its `AbortError` back, not a transport diagnosis. The timeout case is
//      the contrast — that abort is *not* caller-initiated, so `transport` is the correct answer
//      there. Both are asserted, because only the pair shows the distinction is deliberate.
//
// No network and no timers left running: the injected `fetch` hangs until its signal fires.

import { describe, expect, test } from "bun:test"

import { McpProtocolError, isMcpProtocolError } from "../../../src/core/mcp/errors"
import { McpClient } from "../../../src/core/mcp/client"

const SERVER_URL = "https://mcp.invalid/rpc"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface HangingFetch {
  /** The signal `fetch` received, per attempt — the thing that must actually abort. */
  signals: AbortSignal[]
  /** Bodies received, so a test can prove *which* request was in flight. */
  bodies: string[]
  /** Resolves once the first request is in flight. */
  inFlight: Promise<void>
  fetchFn: typeof fetch
}

/**
 * A `fetch` that never resolves on its own. It settles only by rejecting with its signal's reason,
 * which is what the platform `fetch` does on abort.
 */
function hangingFetch(): HangingFetch {
  const signals: AbortSignal[] = []
  const bodies: string[] = []
  const started = deferred<void>()

  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined
    signals.push(signal!)
    bodies.push(typeof init?.body === "string" ? init.body : "")
    started.resolve()

    return await new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"))
      if (signal?.aborted) {
        fail()
        return
      }
      signal?.addEventListener("abort", fail, { once: true })
    })
  }) as unknown as typeof fetch

  return { signals, bodies, inFlight: started.promise, fetchFn }
}

/** Await a rejection and hand back whatever was thrown. Resolving is itself a failure. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    const value = await promise
    throw new Error(`expected a rejection, but the call resolved with ${JSON.stringify(value)}`)
  } catch (error) {
    return error
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
}

describe("core MCP client abort", () => {
  test("a per-call signal cancels the in-flight tools/call on the signal fetch received", async () => {
    const transport = hangingFetch()
    const controller = new AbortController()
    const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn })

    const call = client.callTool("search", { query: "q" }, { signal: controller.signal })
    await transport.inFlight

    // The request really is in flight, and it is the one under test.
    expect(transport.signals).toHaveLength(1)
    expect(transport.signals[0].aborted).toBe(false)
    expect(JSON.parse(transport.bodies[0]).method).toBe("tools/call")

    controller.abort()
    const thrown = await rejection(call)

    // The in-flight request was cancelled, not merely abandoned.
    expect(transport.signals[0].aborted).toBe(true)
    // And the caller's own abort came back as an AbortError, not as `transport`.
    expect(isAbortError(thrown)).toBe(true)
    expect(isMcpProtocolError(thrown)).toBe(false)
    expect(thrown).toBe(controller.signal.reason)
  })

  test("a client-wide signal cancels the in-flight tools/call the same way", async () => {
    const transport = hangingFetch()
    const controller = new AbortController()
    const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn, signal: controller.signal })

    const call = client.callTool("search", {})
    await transport.inFlight
    expect(transport.signals[0].aborted).toBe(false)

    controller.abort()
    const thrown = await rejection(call)

    expect(transport.signals[0].aborted).toBe(true)
    expect(isAbortError(thrown)).toBe(true)
    expect(isMcpProtocolError(thrown)).toBe(false)
  })

  test("with both signals supplied, either one cancels the call", async () => {
    for (const source of ["client-wide", "per-call"] as const) {
      const transport = hangingFetch()
      const clientWide = new AbortController()
      const perCall = new AbortController()
      const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn, signal: clientWide.signal })

      const call = client.callTool("search", {}, { signal: perCall.signal })
      await transport.inFlight
      expect(transport.signals[0].aborted).toBe(false)

      const firing = source === "client-wide" ? clientWide : perCall
      firing.abort()
      const thrown = await rejection(call)

      expect(transport.signals[0].aborted, `${source} did not reach fetch`).toBe(true)
      expect(isAbortError(thrown), `${source} was reclassified`).toBe(true)
      expect(isMcpProtocolError(thrown)).toBe(false)
      // The signal that did not fire is untouched — the merge does not abort both.
      const idle = source === "client-wide" ? perCall : clientWide
      expect(idle.signal.aborted).toBe(false)
    }
  })

  test("a signal already aborted before the call yields an already-aborted request", async () => {
    for (const source of ["client-wide", "per-call"] as const) {
      const transport = hangingFetch()
      const controller = new AbortController()
      controller.abort()

      const client = new McpClient(
        SERVER_URL,
        {},
        { fetch: transport.fetchFn, ...(source === "client-wide" ? { signal: controller.signal } : {}) },
      )
      const call = client.callTool("search", {}, source === "per-call" ? { signal: controller.signal } : {})
      const thrown = await rejection(call)

      // `fetch` is still invoked — the client does not short-circuit — but with a signal that is
      // already aborted, so the request is cancelled at once rather than left running.
      expect(transport.signals[0].aborted).toBe(true)
      expect(isAbortError(thrown)).toBe(true)
      expect(isMcpProtocolError(thrown)).toBe(false)
    }
  })

  test("a caller abort preserves the caller's own AbortError instance", async () => {
    const transport = hangingFetch()
    const controller = new AbortController()
    const reason = new DOMException("user pressed stop", "AbortError")
    const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn })

    const call = client.callTool("search", {}, { signal: controller.signal })
    await transport.inFlight
    controller.abort(reason)

    const thrown = await rejection(call)
    expect(thrown).toBe(reason)
    expect((thrown as DOMException).message).toBe("user pressed stop")
  })

  test("a timeout abort is not a caller abort, so it classifies as transport", async () => {
    const transport = hangingFetch()
    const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn, timeoutMs: 5 })

    const thrown = await rejection(client.callTool("search", {}))

    expect(transport.signals[0].aborted).toBe(true)
    expect(isMcpProtocolError(thrown)).toBe(true)
    expect((thrown as McpProtocolError).category).toBe("transport")
  })

  test("a timeout abort still classifies as transport when an unfired caller signal is present", async () => {
    const transport = hangingFetch()
    const controller = new AbortController()
    const client = new McpClient(SERVER_URL, {}, { fetch: transport.fetchFn, timeoutMs: 5 })

    const thrown = await rejection(client.callTool("search", {}, { signal: controller.signal }))

    expect(controller.signal.aborted).toBe(false)
    expect(isMcpProtocolError(thrown)).toBe(true)
    expect((thrown as McpProtocolError).category).toBe("transport")
  })

  test("a non-abort transport failure is still a transport error", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch

    const thrown = await rejection(new McpClient(SERVER_URL, {}, { fetch: fetchFn }).callTool("search", {}))

    expect(isMcpProtocolError(thrown)).toBe(true)
    expect((thrown as McpProtocolError).category).toBe("transport")
    expect((thrown as McpProtocolError).message).toContain("fetch failed")
  })

  test("an abort during the post-401 retry is still the caller's AbortError", async () => {
    // First attempt is rejected with 401 so `onUnauthorized` runs and the request is repeated; the
    // retry is the hanging one, and that is what the caller aborts.
    const signals: AbortSignal[] = []
    const started = deferred<void>()
    let attempts = 0

    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      attempts += 1
      const signal = init?.signal as AbortSignal | undefined
      signals.push(signal!)
      if (attempts === 1) return new Response("denied", { status: 401 })
      started.resolve()
      return await new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"))
        if (signal?.aborted) fail()
        else signal?.addEventListener("abort", fail, { once: true })
      })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    const client = new McpClient(
      SERVER_URL,
      { authorization: "stale" },
      { fetch: fetchFn, onUnauthorized: async () => "fresh" },
    )

    const call = client.callTool("search", {}, { signal: controller.signal })
    await started.promise
    controller.abort()
    const thrown = await rejection(call)

    expect(attempts).toBe(2)
    expect(signals[1].aborted).toBe(true)
    expect(isAbortError(thrown)).toBe(true)
    expect(isMcpProtocolError(thrown)).toBe(false)
  })
})

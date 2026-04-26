import { describe, expect, test } from "bun:test"

import { Kiro_Client, Kiro_Auth_Manager } from "../../../src/upstream/kiro"
import { KiroHttpError, KiroMcpError, KiroNetworkError } from "../../../src/upstream/kiro/types"

function auth(overrides: Record<string, unknown> = {}) {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-west-2",
    ...overrides,
  } as any, "/tmp/unused", {
    fetch: (() => Promise.resolve(Response.json({ accessToken: "refreshed", refreshToken: "refresh2", expiresIn: 700 }))) as unknown as typeof fetch,
  })
}

function payload() {
  return {
    conversationState: {
      conversationId: "id",
      currentMessage: {
        userInputMessage: {
          content: "hi",
          modelId: "m",
          origin: "AI_EDITOR" as const,
        },
      },
      chatTriggerType: "MANUAL" as const,
    },
  }
}

describe("Kiro client", () => {
  test("sends required headers to the default Kiro API host", async () => {
    let url = ""
    let headers: Headers | undefined
    const client = new Kiro_Client(auth(), {
      fingerprint: "fingerprint",
      kiroVersion: "1.0.0",
      fetch: ((input, init) => {
        url = String(input)
        headers = new Headers(init?.headers)
        return Promise.resolve(new Response("{}"))
      }) as unknown as typeof fetch,
    })

    await client.generateAssistantResponse(payload())

    expect(url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
    expect(headers?.get("authorization")).toBe("Bearer access")
    expect(headers?.get("content-type")).toBe("application/json")
    expect(headers?.get("x-amzn-codewhisperer-optout")).toBe("true")
    expect(headers?.get("x-amzn-kiro-agent-mode")).toBe("vibe")
    expect(headers?.get("amz-sdk-invocation-id")).toMatch(/[0-9a-f-]{36}/)
    expect(headers?.get("amz-sdk-request")).toBe("attempt=1; max=3")
    expect(headers?.get("user-agent")).toContain("KiroIDE-1.0.0-fingerprint")
  })

  test("supports explicit API region override without changing auth region", async () => {
    const calls: string[] = []
    const client = new Kiro_Client(auth({ region: "ap-northeast-1" }), {
      apiRegion: "us-west-2",
      fetch: ((input) => {
        calls.push(String(input))
        return Promise.resolve(new Response("{}"))
      }) as unknown as typeof fetch,
    })

    await client.generateAssistantResponse(payload())

    expect(calls[0]).toBe("https://q.us-west-2.amazonaws.com/generateAssistantResponse")
  })

  test("calls Kiro MCP web_search endpoint and parses nested result JSON", async () => {
    let url = ""
    let requestBody: any
    let headers = new Headers()
    const client = new Kiro_Client(auth(), {
      apiRegion: "us-west-2",
      fetch: ((input, init) => {
        url = String(input)
        headers = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body))
        return Promise.resolve(Response.json({
          id: requestBody.id,
          jsonrpc: "2.0",
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                results: [{ title: "Kiro", url: "https://example.com", snippet: "Result" }],
                totalResults: 1,
              }),
            }],
            isError: false,
          },
        }))
      }) as unknown as typeof fetch,
    })

    const result = await client.callMcpWebSearch("latest Kiro")

    expect(url).toBe("https://q.us-west-2.amazonaws.com/mcp")
    expect(headers.get("authorization")).toBe("Bearer access")
    expect(headers.get("x-amzn-codewhisperer-optout")).toBe("false")
    expect(requestBody).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "web_search", arguments: { query: "latest Kiro" } } })
    expect(requestBody.id).toMatch(/^web_search_tooluse_[A-Za-z0-9]{22}_\d+_[A-Za-z0-9]{8}$/)
    expect(result.toolUseId).toMatch(/^srvtoolu_[0-9a-f]{32}$/)
    expect(result.results.results).toEqual([{ title: "Kiro", url: "https://example.com", snippet: "Result" }])
    expect(result.summary).toContain("latest Kiro")
  })

  test("throws KiroMcpError for JSON-RPC web_search errors", async () => {
    const client = new Kiro_Client(auth(), {
      apiRegion: "us-west-2",
      fetch: (() => Promise.resolve(Response.json({
        id: "web_search_tooluse_id",
        jsonrpc: "2.0",
        error: { code: -32_000, message: "search failed" },
      }))) as unknown as typeof fetch,
    })

    try {
      await client.callMcpWebSearch("latest Kiro")
      throw new Error("expected MCP error")
    } catch (error) {
      expect(error).toBeInstanceOf(KiroMcpError)
      expect((error as Error).message).toContain("search failed")
    }
  })

  test("throws KiroMcpError for malformed MCP web_search result text", async () => {
    const client = new Kiro_Client(auth(), {
      apiRegion: "us-west-2",
      fetch: (() => Promise.resolve(Response.json({
        id: "web_search_tooluse_id",
        jsonrpc: "2.0",
        result: {
          content: [{ type: "text", text: "not json" }],
          isError: false,
        },
      }))) as unknown as typeof fetch,
    })

    try {
      await client.callMcpWebSearch("latest Kiro")
      throw new Error("expected MCP parse error")
    } catch (error) {
      expect(error).toBeInstanceOf(KiroMcpError)
      expect((error as Error).message).toContain("malformed result text")
    }
  })

  test("refreshes and retries once after 403", async () => {
    const statuses = [403, 200]
    const calls: string[] = []
    const authorizations: string[] = []
    let refreshCalls = 0
    const manager = auth({ expiresAt: new Date(Date.now() + 700_000).toISOString() })
    const originalRefresh = manager.refresh.bind(manager)
    manager.refresh = async () => {
      refreshCalls += 1
      await originalRefresh()
    }
    const client = new Kiro_Client(manager, {
      fetch: ((input, init) => {
        calls.push(String(input))
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
        return Promise.resolve(new Response("{}", { status: statuses.shift() ?? 200 }))
      }) as unknown as typeof fetch,
    })

    const response = await client.generateAssistantResponse(payload())
    expect(response.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(refreshCalls).toBe(1)
    expect(authorizations).toEqual(["Bearer access", "Bearer refreshed"])
  })

  test("retries 429 and 5xx with exponential backoff", async () => {
    const sleeps: number[] = []
    const requests: string[] = []
    const statuses = [429, 500, 502, 200]
    const client = new Kiro_Client(auth(), {
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      fetch: ((_, init) => {
        requests.push(new Headers(init?.headers).get("amz-sdk-request") ?? "")
        return Promise.resolve(new Response("{}", { status: statuses.shift() ?? 200 }))
      }) as unknown as typeof fetch,
    })

    await client.generateAssistantResponse(payload())
    expect(sleeps).toEqual([1000, 2000, 4000])
    expect(requests).toEqual(["attempt=1; max=3", "attempt=1; max=3", "attempt=1; max=3", "attempt=1; max=3"])
  })

  test("does not retry non-retryable 400 and 401 responses", async () => {
    for (const status of [400, 401]) {
      let calls = 0
      const client = new Kiro_Client(auth(), {
        fetch: (() => {
          calls += 1
          return Promise.resolve(new Response(`body-${status}`, { status }))
        }) as unknown as typeof fetch,
      })

      try {
        await client.generateAssistantResponse(payload())
        throw new Error(`expected ${status} to throw`)
      } catch (error) {
        expect(error).toBeInstanceOf(KiroHttpError)
        expect((error as KiroHttpError).status).toBe(status)
        expect((error as KiroHttpError).body).toBe(`body-${status}`)
        expect(calls).toBe(1)
      }
    }
  })

  test("throws the last KiroHttpError after exhausting retries", async () => {
    const sleeps: number[] = []
    let calls = 0
    const client = new Kiro_Client(auth(), {
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      fetch: (() => {
        calls += 1
        return Promise.resolve(new Response("still broken", { status: 503 }))
      }) as unknown as typeof fetch,
    })

    try {
      await client.generateAssistantResponse(payload())
      throw new Error("expected retries to exhaust")
    } catch (error) {
      expect(error).toBeInstanceOf(KiroHttpError)
      expect((error as KiroHttpError).status).toBe(503)
      expect((error as KiroHttpError).body).toBe("still broken")
      expect(calls).toBe(4)
      expect(sleeps).toEqual([1000, 2000, 4000])
    }
  })

  test("rethrows caller abort errors without wrapping", async () => {
    const abortError = new DOMException("caller aborted", "AbortError")
    const controller = new AbortController()
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.reject(abortError)) as unknown as typeof fetch,
    })

    controller.abort()

    try {
      await client.generateAssistantResponse(payload(), { signal: controller.signal })
      throw new Error("expected abort")
    } catch (error) {
      expect(error).toBe(abortError)
    }
  })

  test("wraps internal timeout-style aborts as KiroNetworkError", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.reject(new DOMException("stream timed out", "AbortError"))) as unknown as typeof fetch,
    })

    try {
      await client.generateAssistantResponse(payload(), { stream: true })
      throw new Error("expected timeout to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(KiroNetworkError)
      expect((error as KiroNetworkError).message).toBe("stream timed out")
    }
  })

  test("wraps network failures as KiroNetworkError", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    })

    try {
      await client.generateAssistantResponse(payload())
      throw new Error("expected network error")
    } catch (error) {
      expect(error).toBeInstanceOf(KiroNetworkError)
      expect((error as KiroNetworkError).message).toBe("network down")
    }
  })

  test("refreshes the token before requests when it is already expired", async () => {
    const calls: string[] = []
    let authorization = ""
    const manager = new Kiro_Auth_Manager({
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      region: "us-west-2",
    }, "/tmp/unused", {
      fetch: ((url) => {
        calls.push(String(url))
        return Promise.resolve(Response.json({ accessToken: "fresh", refreshToken: "refresh-2", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })
    const client = new Kiro_Client(manager, {
      fetch: ((url, init) => {
        calls.push(String(url))
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return Promise.resolve(new Response("{}"))
      }) as unknown as typeof fetch,
    })

    await client.generateAssistantResponse(payload())

    expect(calls[0]).toContain("refreshToken")
    expect(calls[1]).toContain("/generateAssistantResponse")
    expect(authorization).toBe("Bearer fresh")
  })

  test("combines caller abort signal with streaming read timeout", async () => {
    let signal: AbortSignal | undefined
    const controller = new AbortController()
    const client = new Kiro_Client(auth(), {
      fetch: ((_, init) => {
        signal = init?.signal as AbortSignal
        return Promise.resolve(new Response("{}"))
      }) as unknown as typeof fetch,
    })

    await client.generateAssistantResponse(payload(), { signal: controller.signal, stream: true })
    controller.abort()

    expect(signal).toBeDefined()
    expect(signal).not.toBe(controller.signal)
    expect(signal?.aborted).toBe(true)
  })

  test("listAvailableModels includes profileArn for Desktop Auth", async () => {
    let url = ""
    const client = new Kiro_Client(auth({ profileArn: "arn:desktop" }), {
      fetch: ((input) => {
        url = String(input)
        return Promise.resolve(Response.json({ models: [{ modelId: "claude-sonnet-4" }] }))
      }) as unknown as typeof fetch,
    })

    expect(await client.listAvailableModels()).toEqual(["claude-sonnet-4"])
    expect(url).toContain("/ListAvailableModels")
    expect(url).toContain("origin=AI_EDITOR")
    expect(url).toContain("profileArn=arn%3Adesktop")
  })

  test("listAvailableModels omits profileArn for SSO OIDC", async () => {
    let url = ""
    const client = new Kiro_Client(auth({ clientId: "id", clientSecret: "secret", profileArn: "arn" }), {
      fetch: ((input) => {
        url = String(input)
        return Promise.resolve(Response.json({ models: [{ modelId: "claude-sonnet-4" }] }))
      }) as unknown as typeof fetch,
    })

    expect(await client.listAvailableModels()).toEqual(["claude-sonnet-4"])
    expect(url).toContain("origin=AI_EDITOR")
    expect(url).not.toContain("profileArn")
  })

  test("getUsageLimits uses GET account credit endpoint", async () => {
    let url = ""
    let method = ""
    let body: BodyInit | null | undefined
    const client = new Kiro_Client(auth({ profileArn: "arn:desktop" }), {
      fetch: ((input, init) => {
        url = String(input)
        method = init?.method ?? "GET"
        body = init?.body
        return Promise.resolve(Response.json({ usageBreakdownList: [] }))
      }) as unknown as typeof fetch,
    })

    const response = await client.getUsageLimits()

    expect(response.ok).toBe(true)
    expect(url).toBe("https://q.us-east-1.amazonaws.com/getUsageLimits?profileArn=arn%3Adesktop")
    expect(method).toBe("GET")
    expect(body).toBeUndefined()
  })

  test("checkHealth probes ListAvailableModels and reports success on 2xx", async () => {
    let url = ""
    const client = new Kiro_Client(auth({ profileArn: "arn:desktop" }), {
      fetch: ((input) => {
        url = String(input)
        return Promise.resolve(new Response("{}", { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const health = await client.checkHealth(50)
    expect(health).toMatchObject({ ok: true, status: 200 })
    expect(url).toContain("/ListAvailableModels")
    expect(url).toContain("origin=AI_EDITOR")
    expect(url).toContain("profileArn=arn%3Adesktop")
  })

  test("checkHealth reports auth failures for 401 and 403 responses", async () => {
    for (const status of [401, 403]) {
      const client = new Kiro_Client(auth(), {
        fetch: (() => Promise.resolve(new Response("denied", { status }))) as unknown as typeof fetch,
      })

      expect(await client.checkHealth(50)).toMatchObject({
        ok: false,
        status,
        error: `Kiro auth rejected health check with ${status}`,
      })
    }
  })

  test("checkHealth reports server errors", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.resolve(new Response("down", { status: 503 }))) as unknown as typeof fetch,
    })

    expect(await client.checkHealth(50)).toMatchObject({
      ok: false,
      status: 503,
      error: "Kiro server error during health check: 503",
    })
  })

  test("checkHealth reports rate limits and other client errors", async () => {
    const rateLimited = new Kiro_Client(auth(), {
      fetch: (() => Promise.resolve(new Response("slow down", { status: 429 }))) as unknown as typeof fetch,
    })
    const badRequest = new Kiro_Client(auth(), {
      fetch: (() => Promise.resolve(new Response("bad", { status: 400 }))) as unknown as typeof fetch,
    })

    expect(await rateLimited.checkHealth(50)).toMatchObject({
      ok: false,
      status: 429,
      error: "Kiro rate limited the health check",
    })
    expect(await badRequest.checkHealth(50)).toMatchObject({
      ok: false,
      status: 400,
      error: "Kiro client error during health check: 400",
    })
  })

  test("checkHealth reports network failures", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    })

    expect(await client.checkHealth(50)).toMatchObject({
      ok: false,
      error: "network down",
    })
  })

  test("checkHealth reports timeout aborts", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: ((_, init) => new Promise((_, reject) => {
        ;(init?.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("Signal timed out", "AbortError")), { once: true })
      })) as unknown as typeof fetch,
    })

    expect(await client.checkHealth(1)).toMatchObject({
      ok: false,
      error: "Signal timed out",
    })
  })

  test("checkHealth triggers proactive token refresh before probing", async () => {
    const calls: string[] = []
    let authorization = ""
    const manager = new Kiro_Auth_Manager({
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      region: "us-west-2",
    }, "/tmp/unused", {
      fetch: ((url) => {
        calls.push(String(url))
        return Promise.resolve(Response.json({ accessToken: "fresh", refreshToken: "refresh-2", expiresIn: 60 }))
      }) as unknown as typeof fetch,
    })
    const client = new Kiro_Client(manager, {
      fetch: ((url, init) => {
        calls.push(String(url))
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return Promise.resolve(new Response("{}", { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const health = await client.checkHealth(50)

    expect(health.ok).toBe(true)
    expect(calls[0]).toContain("refreshToken")
    expect(calls[1]).toContain("/ListAvailableModels")
    expect(authorization).toBe("Bearer fresh")
  })
})

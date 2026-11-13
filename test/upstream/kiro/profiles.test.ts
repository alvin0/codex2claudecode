import { describe, expect, test } from "bun:test"

import { Kiro_Auth_Manager } from "../../../src/upstream/kiro/auth"
import { Kiro_Client } from "../../../src/upstream/kiro/client"
import { Kiro_Upstream_Provider } from "../../../src/upstream/kiro/index"
import { LIST_AVAILABLE_PROFILES_MAX_PAGES, resolveKiroVersion } from "../../../src/upstream/kiro/constants"
import type { KiroGeneratePayload } from "../../../src/upstream/kiro/types"

const PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test"
const SECOND_PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/second"

function auth(profileArn?: string) {
  return new Kiro_Auth_Manager({
    accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: "ap-southeast-1", clientId: "client", clientSecret: "secret", profileArn,
  }, "/tmp/unused-kiro-profiles")
}

function payload(profileArn?: string): KiroGeneratePayload {
  return {
    ...(profileArn ? { profileArn } : {}),
    conversationState: {
      conversationId: "conversation",
      currentMessage: { userInputMessage: { content: "Reply OK", modelId: "claude-sonnet-4.5", origin: "AI_EDITOR" } },
      chatTriggerType: "MANUAL",
    },
  }
}

interface RecordedRequest {
  url: string
  method?: string
  headers: Headers
  body: Record<string, unknown>
}

function fixture(pages: unknown[], options: {
  profileArn?: string
  storedProfileArn?: string
  kiroVersion?: string
  modelPages?: unknown[]
} = {}) {
  const manager = auth(options.storedProfileArn)
  const calls: RecordedRequest[] = []
  let page = 0
  let modelPage = 0
  const client = new Kiro_Client(manager, {
    ...options,
    apiRegion: "us-east-1",
    fingerprint: "test-fingerprint",
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body })
      if (url.endsWith("/ListAvailableProfiles")) {
        const value = pages[page++]
        if (value instanceof Response) return value
        return Response.json(value)
      }
      if (url.endsWith("/generateAssistantResponse")) return new Response('{"content":"OK"}')
      if (new URL(url).pathname === "/getUsageLimits") return Response.json({ usageBreakdownList: [] })
      if (new URL(url).pathname === "/ListAvailableModels") {
        if (options.modelPages) return Response.json(options.modelPages[modelPage++])
        return Response.json({ models: [{ modelId: "claude-opus-4.6" }] })
      }
      throw new Error("Unexpected Kiro test request")
    }) as unknown as typeof fetch,
  })
  return { client, manager, calls }
}

describe("Kiro request profiles", () => {
  for (const stream of [false, true]) {
    test(`discovers and caches the single SSO profile for stream=${stream}`, async () => {
      const { client, manager, calls } = fixture([{ profiles: [{ arn: PROFILE }] }])
      const original = payload()
      const response = await client.generateAssistantResponse(original, { stream })
      expect(await response.text()).toBe('{"content":"OK"}')
      await client.generateAssistantResponse(payload(), { stream })

      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/ListAvailableProfiles", "/generateAssistantResponse", "/generateAssistantResponse",
      ])
      expect(calls[0]!.method).toBe("POST")
      expect(calls[0]!.body).toEqual({})
      expect(calls[1]!.body.profileArn).toBe(PROFILE)
      expect(calls[2]!.body.profileArn).toBe(PROFILE)
      expect(original.profileArn).toBeUndefined()
      expect(manager.getProfileArn()).toBeUndefined()
      expect(manager.getRegion()).toBe("ap-southeast-1")
      for (const call of calls) {
        expect(call.headers.get("authorization")).toBe("Bearer access")
        expect(call.headers.get("user-agent")).toContain(`KiroIDE-${resolveKiroVersion()}-test-fingerprint`)
        expect(call.headers.get("x-amz-user-agent")).toContain(`KiroIDE-${resolveKiroVersion()}-test-fingerprint`)
      }
    })
  }

  test("uses an existing SSO profile without an extra discovery request", async () => {
    const { client, calls } = fixture([], { storedProfileArn: PROFILE })
    await client.generateAssistantResponse(payload())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.profileArn).toBe(PROFILE)
  })

  test("preserves an explicit payload profile without modifying the input", async () => {
    const { client, calls } = fixture([])
    const original = payload(PROFILE)
    await client.generateAssistantResponse(original)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.profileArn).toBe(PROFILE)
    expect(original.profileArn).toBe(PROFILE)
  })

  test("follows all pages and deduplicates profiles before selecting", async () => {
    const { client, calls } = fixture([
      { profiles: [{ arn: PROFILE }], nextToken: "page-2" },
      { profiles: [{ arn: PROFILE }], nextToken: null },
    ])
    await client.generateAssistantResponse(payload())
    expect(calls[1]!.body).toEqual({ nextToken: "page-2" })
    expect(calls[2]!.body.profileArn).toBe(PROFILE)
  })

  test("does not select a profile from an incomplete list", async () => {
    const { client, calls } = fixture([
      { profiles: [{ arn: PROFILE }], nextToken: "page-2" },
      { profiles: [{ arn: SECOND_PROFILE }] },
    ])
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({
      status: 400, body: expect.stringContaining("Multiple Kiro profiles"),
    })
    expect(calls).toHaveLength(2)
  })

  test("validates an explicit selection against the entire account profile list", async () => {
    const { client, calls } = fixture([
      { profiles: [{ arn: PROFILE }], nextToken: "page-2" },
      { profiles: [{ arn: SECOND_PROFILE }] },
    ], { profileArn: SECOND_PROFILE })
    await client.generateAssistantResponse(payload())
    expect(calls[2]!.body.profileArn).toBe(SECOND_PROFILE)
  })

  test("rejects an explicit profile unavailable to the account", async () => {
    const { client, calls } = fixture([{ profiles: [{ arn: PROFILE }] }], { profileArn: SECOND_PROFILE })
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({
      status: 400, body: expect.stringContaining("not available to the active account"),
    })
    expect(calls).toHaveLength(1)
  })

  test("rejects an empty profile list without sending inference", async () => {
    const { client, calls } = fixture([{ profiles: [] }])
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({
      status: 400, body: expect.stringContaining("No Kiro profiles"),
    })
    expect(calls).toHaveLength(1)
  })

  test("rejects malformed responses and profiles from another region", async () => {
    const pages = [
      {}, null, { profiles: "invalid" }, { profiles: [{}] }, { profiles: [{ arn: "invalid" }] },
      { profiles: [], nextToken: 1 },
      { profiles: [{ arn: PROFILE.replace("us-east-1", "us-west-2") }] },
      new Response("not-json"),
    ]
    for (const page of pages) {
      const { client, calls } = fixture([page])
      await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({ status: 502 })
      expect(calls).toHaveLength(1)
    }
  })

  test("rejects repeated pagination cursors and does not cache a partial selection", async () => {
    const { client, calls } = fixture([
      { profiles: [{ arn: PROFILE }], nextToken: "a" },
      { profiles: [], nextToken: "b" },
      { profiles: [], nextToken: "a" },
      { profiles: [{ arn: SECOND_PROFILE }] },
    ])
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({ status: 502 })
    expect(calls).toHaveLength(3)
    await client.generateAssistantResponse(payload())
    expect(calls[4]!.body.profileArn).toBe(SECOND_PROFILE)
  })

  test("bounds pagination instead of selecting from truncated results", async () => {
    const pages = Array.from({ length: LIST_AVAILABLE_PROFILES_MAX_PAGES }, (_, index) => ({
      profiles: [{ arn: PROFILE }], nextToken: `page-${index + 1}`,
    }))
    const { client, calls } = fixture(pages)
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({
      status: 502, body: expect.stringContaining("page limit"),
    })
    expect(calls).toHaveLength(LIST_AVAILABLE_PROFILES_MAX_PAGES)
  })

  test("does not reuse a discovered profile after the token changes", async () => {
    const { client, manager, calls } = fixture([
      { profiles: [{ arn: PROFILE }] }, { profiles: [{ arn: SECOND_PROFILE }] },
    ])
    let accessToken = "first"
    manager.getAccessToken = async () => accessToken
    await client.generateAssistantResponse(payload())
    accessToken = "second"
    await client.generateAssistantResponse(payload())
    expect(calls).toHaveLength(4)
    expect(calls[1]!.body.profileArn).toBe(PROFILE)
    expect(calls[3]!.body.profileArn).toBe(SECOND_PROFILE)
    expect(calls[2]!.headers.get("authorization")).toBe("Bearer second")
  })

  test("does not share discovered profiles between client instances", async () => {
    const first = fixture([{ profiles: [{ arn: PROFILE }] }])
    const second = fixture([{ profiles: [{ arn: SECOND_PROFILE }] }])
    await first.client.generateAssistantResponse(payload())
    await second.client.generateAssistantResponse(payload())
    expect(first.calls[1]!.body.profileArn).toBe(PROFILE)
    expect(second.calls[1]!.body.profileArn).toBe(SECOND_PROFILE)
  })

  for (const usageFirst of [false, true]) {
    test(`shares profile discovery between usage and inference with usageFirst=${usageFirst}`, async () => {
      const { client, calls } = fixture([{ profiles: [{ arn: PROFILE }] }])
      if (usageFirst) await client.getUsageLimits()
      await client.generateAssistantResponse(payload())
      const usage = await client.getUsageLimits()
      expect(await usage.json()).toEqual({ usageBreakdownList: [] })
      expect(calls.filter((call) => new URL(call.url).pathname === "/ListAvailableProfiles")).toHaveLength(1)
      const usageCalls = calls.filter((call) => new URL(call.url).pathname === "/getUsageLimits")
      expect(usageCalls.length).toBe(usageFirst ? 2 : 1)
      for (const call of usageCalls) {
        const url = new URL(call.url)
        expect(call.method).toBe("GET")
        expect(call.body).toEqual({})
        expect(url.hostname).toBe("q.us-east-1.amazonaws.com")
        expect(url.searchParams.get("profileArn")).toBe(PROFILE)
        expect(url.searchParams.get("origin")).toBe("AI_EDITOR")
        expect(url.searchParams.get("resourceType")).toBe("AGENTIC_REQUEST")
      }
    })
  }

  test("includes a stored SSO profile in usage queries without discovery", async () => {
    const { client, calls } = fixture([], { storedProfileArn: PROFILE })
    await client.getUsageLimits()
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).searchParams.get("profileArn")).toBe(PROFILE)
  })

  test("does not query usage when profile selection is ambiguous", async () => {
    const { client, calls } = fixture([{ profiles: [{ arn: PROFILE }, { arn: SECOND_PROFILE }] }])
    await expect(client.getUsageLimits()).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).pathname).toBe("/ListAvailableProfiles")
  })

  test("uses one discovered profile for all model catalog paths and health", async () => {
    const { client, calls } = fixture([{ profiles: [{ arn: PROFILE }] }])
    expect(await client.listAvailableModels()).toEqual(["claude-opus-4.6"])
    expect(await (await client.listAvailableModelsRaw()).json()).toEqual({ models: [{ modelId: "claude-opus-4.6" }] })
    expect(await client.listAvailableModelsFull()).toMatchObject({ models: [{ modelId: "claude-opus-4.6" }] })
    expect(await client.checkHealth(1000)).toMatchObject({ ok: true, status: 200 })
    expect(calls).toHaveLength(5)
    for (const call of calls.slice(1)) {
      const url = new URL(call.url)
      expect(call.method).toBe("GET")
      expect(url.pathname).toBe("/ListAvailableModels")
      expect(url.searchParams.get("profileArn")).toBe(PROFILE)
      expect(url.searchParams.get("origin")).toBe("AI_EDITOR")
    }
  })

  test("retains the profile on every model catalog page", async () => {
    const { client, calls } = fixture([{ profiles: [{ arn: PROFILE }] }], {
      modelPages: [
        { models: [{ modelId: "claude-sonnet-4.5" }], nextToken: "models-2" },
        { models: [{ modelId: "claude-opus-4.6" }] },
      ],
    })
    expect(await client.listAvailableModelsFull()).toMatchObject({
      models: [{ modelId: "claude-sonnet-4.5" }, { modelId: "claude-opus-4.6" }],
    })
    expect(calls).toHaveLength(3)
    expect(new URL(calls[1]!.url).searchParams.get("profileArn")).toBe(PROFILE)
    const secondPage = new URL(calls[2]!.url)
    expect(secondPage.searchParams.get("profileArn")).toBe(PROFILE)
    expect(secondPage.searchParams.get("nextToken")).toBe("models-2")
  })

  test("reports profile discovery failure as unhealthy without a model request", async () => {
    const { client, calls } = fixture([new Response('{"message":"denied"}', { status: 401 })])
    expect(await client.checkHealth(1000)).toMatchObject({ ok: false, status: 401, error: expect.stringContaining("denied") })
    expect(calls).toHaveLength(1)
  })

  test("applies the health timeout while discovering a missing profile", async () => {
    const calls: string[] = []
    const client = new Kiro_Client(auth(), {
      apiRegion: "us-east-1",
      fetch: ((input, init) => {
        calls.push(String(input))
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) return reject(new Error("Expected health signal"))
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      }) as unknown as typeof fetch,
    })
    const result = await client.checkHealth(20)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!).pathname).toBe("/ListAvailableProfiles")
  })

  test("loads Opus metadata and forwards high effort without degrading the request", async () => {
    const { client, manager, calls } = fixture([{ profiles: [{ arn: PROFILE }] }], {
      modelPages: [{ models: [{
        modelId: "claude-opus-4.6",
        additionalModelRequestFieldsSchema: {
          properties: { output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"], default: "high" } } } },
        },
      }] }],
    })
    const provider = new Kiro_Upstream_Provider({ auth: manager, client })
    const result = await provider.proxy({
      model: "claude-opus-4.6", input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }],
      reasoningEffort: "high", thinking: { mode: "adaptive" }, stream: false, passthrough: false, metadata: {},
    })
    expect(result.type).toBe("canonical_response")
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/ListAvailableProfiles", "/ListAvailableModels", "/generateAssistantResponse",
    ])
    expect(calls[2]!.body.profileArn).toBe(PROFILE)
    expect(calls[2]!.body.additionalModelRequestFields).toEqual({ output_config: { effort: "high" } })
  })

  test("uses a profile supplied by token refresh before attempting discovery", async () => {
    const { client, manager, calls } = fixture([])
    let profileArn: string | undefined
    manager.getProfileArn = () => profileArn
    manager.getAccessToken = async () => {
      profileArn = PROFILE
      return "refreshed"
    }
    await client.generateAssistantResponse(payload())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.profileArn).toBe(PROFILE)
  })

  test("captures environment configuration and lets explicit options take precedence", async () => {
    const clients = (() => {
      const previousVersion = process.env.KIRO_VERSION
      const previousProfile = process.env.KIRO_PROFILE_ARN
      try {
        process.env.KIRO_VERSION = "1.4.156"
        process.env.KIRO_PROFILE_ARN = PROFILE
        const pages = [{ profiles: [{ arn: PROFILE }, { arn: SECOND_PROFILE }] }]
        return {
          environment: fixture(pages),
          explicit: fixture(pages, { kiroVersion: "1.4.157", profileArn: SECOND_PROFILE }),
        }
      } finally {
        if (previousVersion === undefined) delete process.env.KIRO_VERSION
        else process.env.KIRO_VERSION = previousVersion
        if (previousProfile === undefined) delete process.env.KIRO_PROFILE_ARN
        else process.env.KIRO_PROFILE_ARN = previousProfile
      }
    })()
    for (const [key, version, profile] of [
      ["environment", "1.4.156", PROFILE], ["explicit", "1.4.157", SECOND_PROFILE],
    ] as const) {
      const { client, calls } = clients[key]
      await client.generateAssistantResponse(payload())
      expect(calls[1]!.body.profileArn).toBe(profile)
      expect(calls[1]!.headers.get("user-agent")).toContain(`KiroIDE-${version}-test-fingerprint`)
      expect(calls[1]!.headers.get("x-amz-user-agent")).toContain(`KiroIDE-${version}-test-fingerprint`)
    }
  })

  test("preserves upstream failures instead of selecting an unverified profile", async () => {
    const { client, calls } = fixture([new Response('{"message":"denied"}', { status: 401 })])
    await expect(client.generateAssistantResponse(payload())).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
  })

  test("does not make requests when the caller has already cancelled", async () => {
    const { client, calls } = fixture([])
    const controller = new AbortController()
    controller.abort()
    await expect(client.generateAssistantResponse(payload(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

import { describe, expect, test } from "bun:test"

import { KiroStandaloneClient } from "../src/llm-connect/kiro/client"

describe("KiroStandaloneClient", () => {
  test("sends required headers and payload to generateAssistantResponse", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "access",
      refreshToken: "refresh",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/id",
      fetch: ((url, init) => {
        calls.push({ url: String(url), init })
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    const response = await client.generateAssistantResponse({
      content: "hello",
      modelId: "MODEL_1",
      conversationId: "conversation-1",
    })

    expect(response.ok).toBe(true)
    expect(calls[0].url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
    const headers = calls[0].init?.headers as Headers
    expect(headers.get("Authorization")).toBe("Bearer access")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.get("x-amzn-codewhisperer-optout")).toBe("true")
    expect(headers.get("x-amzn-kiro-agent-mode")).toBe("vibe")
    expect(headers.get("amz-sdk-invocation-id")).toBeTruthy()
    expect(headers.get("amz-sdk-request")).toBe("attempt=1; max=3")
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "conversation-1",
      },
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/id",
    })
  })

  test("adds origin and desktop-only profileArn to listAvailableModels", async () => {
    const calls: Array<string> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "access",
      refreshToken: "refresh",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/id",
      fetch: ((url) => {
        calls.push(String(url))
        return Promise.resolve(Response.json({ models: [] }))
      }) as typeof fetch,
    })

    await expect(client.listAvailableModels()).resolves.toEqual({ models: [] })
    expect(calls[0]).toBe(
      "https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123%3Aprofile%2Fid",
    )
  })

  test("retries once after a 401 and refreshes the token", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "old-access",
      refreshToken: "refresh",
      fetch: ((url, init) => {
        calls.push({ url: String(url), init })
        if (String(url).includes("refreshToken")) return Promise.resolve(Response.json({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }))
        if (calls.filter((call) => call.url.includes("generateAssistantResponse")).length === 1) {
          return Promise.resolve(new Response("denied", { status: 401 }))
        }
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    const response = await client.generateAssistantResponse({
      content: "hello",
      modelId: "MODEL_1",
      conversationId: "conversation-1",
    })

    expect(response.ok).toBe(true)
    const generateCalls = calls.filter((call) => call.url.includes("generateAssistantResponse"))
    expect(generateCalls).toHaveLength(2)
    expect((generateCalls[1].init?.headers as Headers).get("Authorization")).toBe("Bearer new-access")
  })

  test("omits profileArn for oidc model listing", async () => {
    const calls: Array<string> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "access",
      refreshToken: "refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      profileArn: "arn:should-not-be-sent",
      fetch: ((url) => {
        calls.push(String(url))
        return Promise.resolve(Response.json({ models: [] }))
      }) as typeof fetch,
    })

    await client.listAvailableModels()
    expect(calls[0]).toBe("https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR")
  })

  test("falls back to a common API region when the file-derived region is unreachable", async () => {
    const calls: Array<string> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "access",
      refreshToken: "refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      region: "ap-northeast-1",
      fetch: ((url) => {
        calls.push(String(url))
        if (String(url).includes("q.ap-northeast-1.amazonaws.com")) {
          return Promise.reject(new Error("Unable to connect"))
        }
        return Promise.resolve(Response.json({ models: ["ok"] }))
      }) as typeof fetch,
    })

    await expect(client.listAvailableModels()).resolves.toEqual({ models: ["ok"] })
    expect(calls[0]).toBe("https://q.ap-northeast-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR")
    expect(calls[1]).toBe("https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR")
  })

  test("reuses the first reachable API region for generateAssistantResponse", async () => {
    const calls: Array<string> = []
    const client = await KiroStandaloneClient.create({
      accessToken: "access",
      refreshToken: "refresh",
      clientId: "client-id",
      clientSecret: "client-secret",
      region: "ap-northeast-1",
      fetch: ((url) => {
        calls.push(String(url))
        if (String(url).includes("q.ap-northeast-1.amazonaws.com")) {
          return Promise.reject(new Error("Unable to connect"))
        }
        return Promise.resolve(Response.json({ ok: true }))
      }) as typeof fetch,
    })

    await client.listAvailableModels()
    const response = await client.generateAssistantResponse({
      content: "hello",
      modelId: "MODEL_1",
      conversationId: "conversation-1",
    })

    expect(response.ok).toBe(true)
    expect(calls.at(-1)).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
  })
})

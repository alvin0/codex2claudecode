import { afterEach, describe, expect, test } from "bun:test"

import { mkdtemp, path, rm, tmpdir, writeFile } from "../helpers"
import { ENDPOINT_PROXY_ROUTES, endpointProxyProviderLabel, normalizeEndpointProxyMap, readEndpointProxyMap, resolveEndpointProxyDisplayValue, resolveEndpointProxySourceMode, writeEndpointProxyMap } from "../../src/app/endpoint-share"
import { endpointShareEndpointOptions, endpointShareSourceOptions, endpointShareSummaryLines } from "../../src/ui/endpoint-share"
import type { EndpointShareAvailabilityMap } from "../../src/ui/endpoint-share"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempStateFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "endpoint-share-test-"))
  tempDirs.push(dir)
  return path.join(dir, "provider-state.json")
}

const availability: EndpointShareAvailabilityMap = {
  codex: { connected: true, message: "Codex connected" },
  kiro: { connected: false, message: "Kiro needs an account" },
  copilot: { connected: true, message: "Copilot connected" },
}

describe("endpoint proxy helpers", () => {
  test("normalizes stored config and resolves display values", async () => {
    const file = await tempStateFile()

    await writeEndpointProxyMap("codex", file, {
      messages: "self",
      count_tokens: "self",
      responses: "self",
      chat_completions: "kiro",
      embeddings: "self",
    })

    const proxy = await readEndpointProxyMap("codex", file)
    expect(proxy).toEqual({
      chat_completions: "kiro",
    })
    expect(normalizeEndpointProxyMap("codex", { messages: "self", count_tokens: "self", responses: "self", chat_completions: "kiro", embeddings: "self" })).toEqual({
      chat_completions: "kiro",
    })
    expect(resolveEndpointProxySourceMode("codex", "messages", proxy)).toBe("codex")
    expect(resolveEndpointProxySourceMode("codex", "count_tokens", proxy)).toBe("codex")
    expect(resolveEndpointProxySourceMode("codex", "responses", proxy)).toBe("codex")
    expect(resolveEndpointProxySourceMode("codex", "chat_completions", proxy)).toBe("kiro")
    expect(resolveEndpointProxySourceMode("codex", "embeddings", proxy)).toBeUndefined()
    expect(resolveEndpointProxyDisplayValue("codex", "messages", proxy)).toBe("self")
    expect(resolveEndpointProxyDisplayValue("codex", "count_tokens", proxy)).toBe("self")
    expect(resolveEndpointProxyDisplayValue("codex", "responses", proxy)).toBe("self")
    expect(resolveEndpointProxyDisplayValue("codex", "chat_completions", proxy)).toBe(endpointProxyProviderLabel("kiro"))
    expect(resolveEndpointProxyDisplayValue("codex", "embeddings", proxy)).toBe("Unavailable")
  })

  test("builds endpoint and source options with validation-aware markers", () => {
    const endpointOptions = endpointShareEndpointOptions("codex", { responses: "copilot" })
    expect(endpointOptions).toEqual([
      { endpoint: "messages", label: "Messages", value: "self" },
      { endpoint: "count_tokens", label: "Count tokens", value: "self" },
      { endpoint: "responses", label: "Responses", value: "Copilot" },
      { endpoint: "chat_completions", label: "Chat completions", value: "self" },
      { endpoint: "embeddings", label: "Embeddings", value: "Unavailable" },
    ])

    const responseSources = endpointShareSourceOptions("codex", "responses", availability, { responses: "copilot" })
    expect(responseSources.map((option) => option.target)).toEqual(["self", "kiro", "copilot"])
    expect(responseSources.find((option) => option.target === "copilot")).toMatchObject({
      available: true,
      current: true,
    })
    expect(responseSources.find((option) => option.target === "kiro")).toMatchObject({
      available: false,
      description: "Kiro needs an account",
    })

    const embeddingsSources = endpointShareSourceOptions("codex", "embeddings", availability, {})
    expect(embeddingsSources).toEqual([
      {
        target: "copilot",
        label: "Copilot",
        description: "Use the Copilot account",
        available: true,
        current: false,
      },
    ])

    const copilotEmbeddingsSources = endpointShareSourceOptions("copilot", "embeddings", availability, { embeddings: "self" })
    expect(copilotEmbeddingsSources).toEqual([
      {
        target: "self",
        label: "self",
        description: "Use the selected Copilot account",
        available: true,
        current: true,
      },
    ])
  })

  test("renders only proxied endpoint paths in the summary", () => {
    expect(endpointShareSummaryLines("codex", { responses: "copilot" })).toEqual([
      {
        label: "Responses",
        source: "Copilot",
        path: "/v1/responses",
        available: true,
      },
    ])
  })

  test("declares only the supported proxy routes", () => {
    expect(ENDPOINT_PROXY_ROUTES.map((route) => route.path)).toEqual([
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/embeddings",
    ])
  })
})

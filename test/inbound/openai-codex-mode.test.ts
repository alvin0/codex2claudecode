import { describe, expect, test } from "bun:test"

import { OpenAI_Inbound_Provider } from "../../src/inbound/openai"
import { codexBasePathRoutes, CODEX_MODELS_ROUTE, OPENAI_MODELS_ROUTE } from "../../src/inbound/openai/routes"
import { codex2ClaudeModelIds, resolveCodex2ClaudeModel } from "../../src/inbound/openai/model-alias"
import { codexCliConfigPreview, mergeCodexCliConfig, unmergeCodexCliConfig } from "../../src/inbound/openai/export-config-codex"
import type { Canonical_Request } from "../../src/core/canonical"
import type { Upstream_Provider } from "../../src/core/interfaces"

function stubUpstream(capture?: (request: Canonical_Request) => void): Upstream_Provider {
  return {
    providerKind: "codex",
    async proxy(request) {
      capture?.(request)
      return {
        type: "canonical_response",
        id: "resp_1",
        model: request.model,
        stopReason: "end_turn",
        content: [{ type: "text", text: "OK" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
    async checkHealth() {
      return { ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 }
    },
    async listModelDescriptors() {
      return [
        { id: "gpt-5.6-sol", effort: { schemaPath: "reasoning" as const, levels: ["low", "xhigh"] } },
        "gpt-5.6-luna",
      ]
    },
  } as unknown as Upstream_Provider
}

const context = { requestId: "test", logBody: false, quiet: true }

describe("codex2claude model alias", () => {
  test("strips the prefix and promotes the effort suffix over the client default", () => {
    expect(resolveCodex2ClaudeModel({ model: "codex2claude-gpt-5.6-sol_xhigh", reasoning: { effort: "low", summary: "auto" } })).toEqual({
      model: "gpt-5.6-sol",
      reasoning: { effort: "xhigh", summary: "auto" },
    })
  })

  test("strips the prefix when no effort suffix is present", () => {
    expect(resolveCodex2ClaudeModel({ model: "codex2claude-claude-opus-5" })).toEqual({ model: "claude-opus-5" })
  })

  test("leaves unprefixed models untouched", () => {
    const body = { model: "gpt-5.6-sol", reasoning: { effort: "low" } }
    expect(resolveCodex2ClaudeModel(body)).toBe(body)
  })

  test("names models according to CODEX_MODEL_PREFIX", () => {
    const naming = (value?: string) => {
      if (value === undefined) delete process.env.CODEX_MODEL_PREFIX
      else process.env.CODEX_MODEL_PREFIX = value
      try {
        return codex2ClaudeModelIds("gpt-5.6-sol")
      } finally {
        delete process.env.CODEX_MODEL_PREFIX
      }
    }

    expect(naming()).toEqual(["codex2claude-gpt-5.6-sol"])
    expect(naming("0")).toEqual(["gpt-5.6-sol"])
    expect(naming("both")).toEqual(["gpt-5.6-sol", "codex2claude-gpt-5.6-sol"])
  })

  test("lists an upstream catalog under both names when asked", async () => {
    process.env.CODEX_MODEL_PREFIX = "both"
    try {
      const upstream = {
        ...stubUpstream(),
        async modelsRaw() {
          return Response.json({
            default_model_slug: "gpt-5.6-sol",
            models: [{ slug: "gpt-5.6-sol", display_name: "Sol" }, { slug: "gpt-5.6-terra", display_name: "Terra" }],
          })
        },
      } as unknown as Upstream_Provider
      const provider = new OpenAI_Inbound_Provider({ routes: [CODEX_MODELS_ROUTE] })

      const response = await provider.handle(new Request("http://localhost/codex/v1/models?client_version=0.147.0"), CODEX_MODELS_ROUTE, upstream, context)
      const body = await response.json() as { models: Array<{ slug: string; display_name: string }>; default_model_slug: string }

      expect(body.models.map((model) => model.slug)).toEqual([
        "gpt-5.6-sol",
        "codex2claude-gpt-5.6-sol",
        "gpt-5.6-terra",
        "codex2claude-gpt-5.6-terra",
      ])
      // Both copies keep the upstream's own metadata.
      expect(body.models[1]!.display_name).toBe("Sol")
      expect(body.default_model_slug).toBe("gpt-5.6-sol")
    } finally {
      delete process.env.CODEX_MODEL_PREFIX
    }
  })

  test("lists one id per model, leaving effort to the client", () => {
    expect(codex2ClaudeModelIds({ id: "gpt-5.6-sol", effort: { schemaPath: "reasoning", levels: ["low", "xhigh"] } })).toEqual([
      "codex2claude-gpt-5.6-sol",
    ])
    expect(codex2ClaudeModelIds("gpt-5.6-luna")).toEqual(["codex2claude-gpt-5.6-luna"])
  })
})

describe("OpenAI inbound codex mode", () => {
  test("sends the stripped model and suffix effort upstream", async () => {
    let captured: Canonical_Request | undefined
    const provider = new OpenAI_Inbound_Provider({ passthrough: false })
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "codex2claude-gpt-5.6-sol_xhigh",
        reasoning: { effort: "low" },
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    })

    const response = await provider.handle(request, { path: "/v1/responses", method: "POST" }, stubUpstream((value) => { captured = value }), context)

    expect(response.status).toBe(200)
    expect(captured?.model).toBe("gpt-5.6-sol")
    expect(captured?.reasoningEffort).toBe("xhigh")
  })

  test("serves the catalog under /codex without needing a header to disambiguate", async () => {
    const provider = new OpenAI_Inbound_Provider({ routes: [CODEX_MODELS_ROUTE] })
    const request = new Request("http://localhost/codex/v1/models?client_version=0.147.0")

    const response = await provider.handle(request, CODEX_MODELS_ROUTE, stubUpstream(), context)
    const body = await response.json() as { models: Array<{ slug: string }> }

    expect(body.models.map((model) => model.slug)).toEqual([
      "codex2claude-gpt-5.6-sol",
      "codex2claude-gpt-5.6-luna",
    ])
  })

  test("mirrors every proxy route under /codex", () => {
    const mirrored = codexBasePathRoutes([{ path: "/v1/responses", method: "POST" }])
    expect(mirrored).toEqual([{ path: "/v1/responses", method: "POST", basePath: "/codex" }])
  })

  test("serves the plain OpenAI list to ordinary clients", async () => {
    const provider = new OpenAI_Inbound_Provider({ routes: [OPENAI_MODELS_ROUTE] })
    const request = new Request("http://localhost/v1/models")

    const response = await provider.handle(request, OPENAI_MODELS_ROUTE, stubUpstream(), context)
    const body = await response.json() as { object: string; data: Array<{ id: string; owned_by: string }> }

    expect(body.object).toBe("list")
    expect(body.data.map((model) => model.id)).toEqual([
      "codex2claude-gpt-5.6-sol",
      "codex2claude-gpt-5.6-luna",
    ])
    expect(body.data[0]!.owned_by).toBe("codex2claude")
  })

  test("serves the Codex catalog shape when Codex asks with client_version", async () => {
    const provider = new OpenAI_Inbound_Provider({ routes: [OPENAI_MODELS_ROUTE] })
    const request = new Request("http://localhost/v1/models?client_version=0.146.0", { headers: { originator: "codex_cli_rs" } })

    const response = await provider.handle(request, OPENAI_MODELS_ROUTE, stubUpstream(), context)
    const body = await response.json() as { models: Array<{ slug: string; supported_reasoning_levels: Array<{ effort: string }> }>; default_model_slug: string }

    expect(body.models.map((model) => model.slug)).toEqual([
      "codex2claude-gpt-5.6-sol",
      "codex2claude-gpt-5.6-luna",
    ])
    expect(body.default_model_slug).toBe("codex2claude-gpt-5.6-sol")
    expect(body.models[0]!.supported_reasoning_levels.map((level) => level.effort)).toEqual(["low", "xhigh"])
  })

  test("serves every model the upstream catalog lists", async () => {
    const upstream = {
      ...stubUpstream(),
      async modelsRaw() {
        return Response.json({
          models: [
            { slug: "gpt-5.6-sol", display_name: "Sol" },
            { slug: "gpt-5.6-terra", display_name: "Terra" },
            { slug: "gpt-5.6-luna", display_name: "Luna" },
          ],
        })
      },
    } as unknown as Upstream_Provider
    const provider = new OpenAI_Inbound_Provider({ routes: [OPENAI_MODELS_ROUTE] })

    const response = await provider.handle(new Request("http://localhost/v1/models?client_version=0.147.0"), OPENAI_MODELS_ROUTE, upstream, context)
    const body = await response.json() as { models: Array<{ slug: string }> }

    expect(body.models.map((model) => model.slug)).toEqual([
      "codex2claude-gpt-5.6-sol",
      "codex2claude-gpt-5.6-terra",
      "codex2claude-gpt-5.6-luna",
    ])
  })

  test("falls back to synthesized entries when the upstream catalog is empty", async () => {
    const upstream = {
      ...stubUpstream(),
      async modelsRaw() {
        return Response.json({ models: [] })
      },
    } as unknown as Upstream_Provider
    const provider = new OpenAI_Inbound_Provider({ routes: [OPENAI_MODELS_ROUTE] })

    const response = await provider.handle(new Request("http://localhost/v1/models?client_version=0.147.0"), OPENAI_MODELS_ROUTE, upstream, context)
    const body = await response.json() as { models: Array<{ slug: string; model_messages: { instructions_template: string } }> }

    expect(body.models.map((model) => model.slug)).toEqual(["codex2claude-gpt-5.6-sol", "codex2claude-gpt-5.6-luna"])
    expect(body.models[0]!.model_messages.instructions_template).toContain("codex2claudecode")
  })

  test("passes an upstream catalog through, renaming only the slugs", async () => {
    const upstream = {
      ...stubUpstream(),
      async modelsRaw() {
        return Response.json({
          default_model_slug: "gpt-5.6-sol",
          models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", base_instructions: "You are Codex", priority: 1 }],
        })
      },
    } as unknown as Upstream_Provider
    const provider = new OpenAI_Inbound_Provider({ routes: [OPENAI_MODELS_ROUTE] })
    const request = new Request("http://localhost/v1/models?client_version=0.146.0")

    const response = await provider.handle(request, OPENAI_MODELS_ROUTE, upstream, context)
    const body = await response.json() as { models: Array<Record<string, unknown>>; default_model_slug: string }

    expect(body.models[0]).toMatchObject({
      slug: "codex2claude-gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      base_instructions: "You are Codex",
      priority: 1,
    })
    expect(body.default_model_slug).toBe("codex2claude-gpt-5.6-sol")
  })
})

const USER_CONFIG = [
  `model = "gpt-5.6-sol"`,
  `model_reasoning_effort = "high"`,
  ``,
  `[features]`,
  `memories = true`,
  ``,
  `[plugins."documents@openai"]`,
  `enabled = true`,
  ``,
].join("\n")

describe("Codex config.toml merge", () => {
  test("adds the provider without taking over model_provider", () => {
    const preview = codexCliConfigPreview({ baseUrl: "http://127.0.0.1:9000/v1" })
    expect(preview).toContain("[model_providers.codex2claude]")
    expect(preview).toContain(`base_url = "http://127.0.0.1:9000/v1"`)
    expect(preview).not.toMatch(/^model_provider =/m)
    expect(preview).not.toMatch(/^model =/m)
  })

  test("leaves plain codex on its own provider", () => {
    const merged = mergeCodexCliConfig(USER_CONFIG, { baseUrl: "http://127.0.0.1:9000/v1" })
    expect(merged).not.toMatch(/^model_provider =/m)
    expect(merged).toContain("[model_providers.codex2claude]")
  })

  test("takes over model_provider only when asked, before the first table", () => {
    const lines = mergeCodexCliConfig(USER_CONFIG, { baseUrl: "http://127.0.0.1:9000/v1", makeDefault: true }).split("\n")
    const selection = lines.findIndex((line) => line === `model_provider = "codex2claude"`)
    const firstTable = lines.findIndex((line) => line.startsWith("["))
    const providerTable = lines.findIndex((line) => line === "[model_providers.codex2claude]")

    expect(selection).toBeGreaterThan(-1)
    expect(selection).toBeLessThan(firstTable)
    expect(providerTable).toBeGreaterThan(lines.findIndex((line) => line === `[plugins."documents@openai"]`))
  })

  test("keeps the user's own settings", () => {
    const merged = mergeCodexCliConfig(USER_CONFIG)
    expect(merged).toContain(`model = "gpt-5.6-sol"`)
    expect(merged).toContain(`model_reasoning_effort = "high"`)
    expect(merged).toContain("[features]")
    expect(merged).toContain(`[plugins."documents@openai"]`)
  })

  test("replaces its own blocks instead of stacking them", () => {
    const once = mergeCodexCliConfig(USER_CONFIG, { baseUrl: "http://127.0.0.1:8787/v1" })
    const twice = mergeCodexCliConfig(once, { baseUrl: "http://127.0.0.1:9000/v1" })

    expect(twice.split("[model_providers.codex2claude]")).toHaveLength(2)
    expect(twice).toContain(`base_url = "http://127.0.0.1:9000/v1"`)
    expect(twice).not.toContain("8787")
  })

  test("restores a model_provider it had taken over once it stops being the default", () => {
    const withProvider = `model_provider = "openai"\n${USER_CONFIG}`
    const asDefault = mergeCodexCliConfig(withProvider, { makeDefault: true })
    expect(asDefault).toContain(`# codex2claudecode replaced: model_provider = "openai"`)
    expect(asDefault.split(/^model_provider = /m)).toHaveLength(2)

    const handedBack = mergeCodexCliConfig(asDefault)
    expect(handedBack).toContain(`model_provider = "openai"`)
    expect(handedBack).not.toMatch(/^model_provider = "codex2claude"/m)

    const restored = unmergeCodexCliConfig(asDefault)
    expect(restored).toContain(`model_provider = "openai"`)
    expect(restored).not.toContain("codex2claude")
  })

  test("works on an empty config", () => {
    const merged = mergeCodexCliConfig("")
    expect(merged).toContain("[model_providers.codex2claude]")
  })
})

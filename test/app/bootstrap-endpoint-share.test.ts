import { afterEach, describe, expect, test } from "bun:test"

import { startRuntimeWithBootstrap } from "../../src/app/runtime"
import { bootstrapRuntime } from "../../src/app/bootstrap"
import { readRecentRequestLogs } from "../../src/core/request-logs"
import { mkdir, mkdtemp, path, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function mockCopilotFetch() {
  return ((url, init) => {
    const target = String(url)
    if (init?.method === "HEAD") return Promise.resolve(new Response(null, { status: 405 }))
    if (target.includes("copilot_internal/v2/token")) {
      return Promise.resolve(Response.json({ token: `copilot-token;exp=${Math.floor(Date.now() / 1000) + 3600}` }))
    }
    if (target.includes("copilot_internal/user")) {
      return Promise.resolve(Response.json({
        access_type_sku: "free_limited_copilot",
        copilot_plan: "copilot_pro",
        userInfo: { email: "dev@example.com", userId: "user-1" },
        limited_user_quotas: { chat: 100, completions: 100 },
        limited_user_reset_date: "2026-01-01",
      }))
    }
    if (target.includes("api.githubcopilot.com") && target.endsWith("/models")) {
      return Promise.resolve(Response.json({ data: [{ id: "copilot-model", model_picker_enabled: true }], object: "list" }))
    }
    if (target.includes("api.githubcopilot.com") && target.endsWith("/responses")) {
      return Promise.resolve(Response.json({
        id: "resp_1",
        model: "copilot-model",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 2 },
      }))
    }
    if (target.includes("api.githubcopilot.com") && target.endsWith("/chat/completions")) {
      return Promise.resolve(Response.json({
        id: "chatcmpl_1",
        model: "copilot-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }))
    }
    if (target.includes("api.githubcopilot.com") && target.endsWith("/embeddings")) {
      return Promise.resolve(Response.json({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        model: "copilot-model",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }))
    }
    if (target.includes("/usage")) return Promise.resolve(Response.json({ used: true }))
    if (target.includes("/environments")) return Promise.resolve(Response.json([]))
    if (target.includes("/responses/input_tokens")) return Promise.resolve(Response.json({ object: "response.input_tokens", input_tokens: 7 }))
    return Promise.resolve(new Response("ok"))
  }) as unknown as typeof fetch
}

async function createSandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "endpoint-share-bootstrap-"))
  tempDirs.push(dir)
  process.env.HOME = dir
  await mkdir(path.join(dir, ".codex2claudecode"), { recursive: true })
  return {
    dir,
    providerStatePath: path.join(dir, ".codex2claudecode", "provider-state.json"),
    codexAuthFile: path.join(dir, "auth-codex.json"),
    kiroAuthFile: path.join(dir, "kiro-auth-token.json"),
    copilotAuthFile: path.join(dir, "copilot-auth.json"),
  }
}

async function writeCodexAuthFile(file: string) {
  await writeFile(file, JSON.stringify([
    {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      accountId: "codex-account",
    },
  ]))
}

async function writeKiroAuthFile(file: string) {
  await writeFile(file, JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  }))
}

async function writeCopilotAuthFile(file: string) {
  await writeFile(file, JSON.stringify({
    type: "copilot",
    githubToken: "github-token",
    accountType: "individual",
  }))
}

describe.serial("bootstrap endpoint proxying", () => {
  test("Codex main can proxy responses and embeddings to Copilot", async () => {
    const sandbox = await createSandbox()
    globalThis.fetch = mockCopilotFetch()
    process.env.CODEX_AUTH_FILE = sandbox.codexAuthFile
    process.env.COPILOT_AUTH_FILE = sandbox.copilotAuthFile
    await writeCodexAuthFile(sandbox.codexAuthFile)
    await writeCopilotAuthFile(sandbox.copilotAuthFile)
    await writeFile(sandbox.providerStatePath, JSON.stringify({
      codex: {
        endpointProxy: {
          responses: "copilot",
          embeddings: "copilot",
        },
      },
    }))

    const runtime = await bootstrapRuntime({ providerMode: "codex" })
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-codex")
    expect(runtime.registry.match("POST", "/v1/messages/count_tokens", new Headers())?.provider.name).toBe("claude-codex")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai")
    expect(runtime.registry.match("POST", "/v1/embeddings", new Headers())?.provider.name).toBe("openai-copilot")
  })

  test("Kiro main can proxy responses to Copilot while keeping chat self", async () => {
    const sandbox = await createSandbox()
    globalThis.fetch = mockCopilotFetch()
    process.env.KIRO_AUTH_FILE = sandbox.kiroAuthFile
    process.env.COPILOT_AUTH_FILE = sandbox.copilotAuthFile
    await writeKiroAuthFile(sandbox.kiroAuthFile)
    await writeCopilotAuthFile(sandbox.copilotAuthFile)
    await writeFile(sandbox.providerStatePath, JSON.stringify({
      kiro: {
        endpointProxy: {
          responses: "copilot",
        },
      },
    }))

    const runtime = await bootstrapRuntime({ providerMode: "kiro" })
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-kiro")
    expect(runtime.registry.match("POST", "/v1/messages/count_tokens", new Headers())?.provider.name).toBe("claude-kiro")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai-kiro")
    expect(runtime.registry.match("POST", "/v1/embeddings", new Headers())).toBeUndefined()
  })

  test("Kiro runtime root and request logs reflect the proxied Copilot endpoint", async () => {
    const sandbox = await createSandbox()
    globalThis.fetch = mockCopilotFetch()
    process.env.KIRO_AUTH_FILE = sandbox.kiroAuthFile
    process.env.COPILOT_AUTH_FILE = sandbox.copilotAuthFile
    await writeKiroAuthFile(sandbox.kiroAuthFile)
    await writeCopilotAuthFile(sandbox.copilotAuthFile)
    await writeFile(sandbox.providerStatePath, JSON.stringify({
      kiro: {
        endpointProxy: {
          responses: "copilot",
        },
      },
    }))

    const bootstrapped = await bootstrapRuntime({ providerMode: "kiro" })
    const server = await startRuntimeWithBootstrap(
      { port: 0, healthIntervalMs: 0, logBody: false, quiet: true, requestLogMode: "sync" },
      async () => bootstrapped,
    )
    const base = `http://${server.hostname}:${server.port}`
    try {
      const root = await originalFetch(`${base}/`)
      expect(root.status).toBe(200)
      const body = await root.json() as { registered_routes: Array<{ path: string; method: string; provider: string }> }
      expect(body.registered_routes.some((route) => route.path === "/v1/messages" && route.provider === "claude-kiro")).toBe(true)
      expect(body.registered_routes.some((route) => route.path === "/v1/messages/count_tokens" && route.provider === "claude-kiro")).toBe(true)
      expect(body.registered_routes.some((route) => route.path === "/v1/responses" && route.provider === "openai-copilot")).toBe(true)
      expect(body.registered_routes.some((route) => route.path === "/v1/chat/completions" && route.provider === "openai-kiro")).toBe(true)

      const response = await originalFetch(`${base}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "m", input: "hi" }),
      })
      expect(response.status).toBe(200)

      const logs = await readRecentRequestLogs(bootstrapped.authFile)
      const proxied = logs.find((entry) => entry.path === "/v1/responses")
      expect(proxied?.proxy).toMatchObject({
        label: "Copilot OpenAI",
        method: "POST",
        target: "upstream",
        status: 200,
      })
    } finally {
      server.stop(true)
    }
  })

  test("Copilot main keeps embeddings on self by default", async () => {
    const sandbox = await createSandbox()
    globalThis.fetch = mockCopilotFetch()
    process.env.COPILOT_AUTH_FILE = sandbox.copilotAuthFile
    await writeCopilotAuthFile(sandbox.copilotAuthFile)
    await writeFile(sandbox.providerStatePath, JSON.stringify({
      copilot: {},
    }))

    const runtime = await bootstrapRuntime({ providerMode: "copilot" })
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-copilot")
    expect(runtime.registry.match("POST", "/v1/messages/count_tokens", new Headers())?.provider.name).toBe("claude-copilot")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/embeddings", new Headers())?.provider.name).toBe("openai-copilot")
  })
})

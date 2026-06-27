import { afterEach, describe, expect, test } from "bun:test"

import { bootstrapRuntime } from "../../src/app/bootstrap"
import { homedir, mkdtemp, path, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

afterEach(async () => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function kiroAuthFile(region = "us-east-1") {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-bootstrap-test-"))
  tempDirs.push(dir)
  process.env.HOME = dir
  const file = path.join(dir, "kiro-auth-token.json")
  await writeFile(file, JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 700_000).toISOString(), region }))
  return file
}

async function codexAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-bootstrap-test-"))
  tempDirs.push(dir)
  process.env.HOME = dir
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000, accountId: "acct" }))
  return file
}

async function copilotAuthFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-test-"))
  tempDirs.push(dir)
  process.env.HOME = dir
  const file = path.join(dir, "copilot-auth.json")
  await writeFile(file, JSON.stringify({ type: "copilot", githubToken: "github-token", accountType: "individual" }))
  return file
}

async function providerConfigFile(provider: "codex" | "kiro") {
  const dir = await mkdtemp(path.join(tmpdir(), "provider-bootstrap-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "provider-config.json")
  await writeFile(file, JSON.stringify({ provider }))
  return file
}

describe("bootstrap Kiro integration", () => {
  test("UPSTREAM_PROVIDER=kiro creates Kiro upstream, Kiro registry, and synthetic auth path", async () => {
    process.env.UPSTREAM_PROVIDER = "kiro"
    process.env.KIRO_AUTH_FILE = await kiroAuthFile()

    const runtime = await bootstrapRuntime()
    expect(runtime.upstream.constructor.name).toBe("Kiro_Upstream_Provider")
    expect(runtime.authFile).toBe(path.join(homedir(), ".codex2claudecode", "provider-state.json"))
    expect(path.dirname(runtime.authFile)).toBe(path.join(homedir(), ".codex2claudecode"))
    expect(runtime.authAccount).toBeUndefined()
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-kiro")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-kiro")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai-kiro")
    expect(runtime.registry.match("POST", "/v1/complete", new Headers())).toBeUndefined()
  })

  test("UPSTREAM_PROVIDER=codex creates Codex upstream and keeps OpenAI routes", async () => {
    process.env.UPSTREAM_PROVIDER = "codex"
    process.env.CODEX_AUTH_FILE = await codexAuthFile()

    const runtime = await bootstrapRuntime()
    expect(runtime.upstream.constructor.name).toBe("Codex_Upstream_Provider")
    expect(runtime.authFile).toBe(process.env.CODEX_AUTH_FILE)
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-codex")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai")
  })

  test("UPSTREAM_PROVIDER=copilot creates Copilot upstream and exposes embeddings", async () => {
    process.env.UPSTREAM_PROVIDER = "copilot"
    process.env.COPILOT_AUTH_FILE = await copilotAuthFile()
    globalThis.fetch = ((url) => {
      const target = String(url)
      if (target.includes("/copilot_internal/v2/token")) {
        return Promise.resolve(Response.json({ token: `copilot-token;exp=${Math.floor(Date.now() / 1000) + 3600}` }))
      }
      if (target.includes("/copilot_internal/user")) {
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
      return Promise.resolve(Response.json({ ok: true }))
    }) as unknown as typeof fetch

    const runtime = await bootstrapRuntime()
    expect(runtime.upstream.constructor.name).toBe("Copilot_Upstream_Provider")
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-copilot")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai-copilot")
    expect(runtime.registry.match("POST", "/v1/embeddings", new Headers())?.provider.name).toBe("openai-copilot")
  })

  test("unset UPSTREAM_PROVIDER defaults to Codex", async () => {
    delete process.env.UPSTREAM_PROVIDER
    process.env.CODEX_AUTH_FILE = await codexAuthFile()
    const dir = await mkdtemp(path.join(tmpdir(), "missing-provider-bootstrap-test-"))
    tempDirs.push(dir)

    const runtime = await bootstrapRuntime({ providerConfigPath: path.join(dir, "missing.json") })
    expect(runtime.upstream.constructor.name).toBe("Codex_Upstream_Provider")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai")
  })

  test("provider config selects Kiro when environment is unset", async () => {
    delete process.env.UPSTREAM_PROVIDER
    process.env.KIRO_AUTH_FILE = await kiroAuthFile()

    const runtime = await bootstrapRuntime({ providerConfigPath: await providerConfigFile("kiro") })
    expect(runtime.upstream.constructor.name).toBe("Kiro_Upstream_Provider")
    expect(runtime.registry.match("POST", "/v1/messages", new Headers())?.provider.name).toBe("claude-kiro")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai-kiro")
    expect(runtime.registry.match("POST", "/v1/chat/completions", new Headers())?.provider.name).toBe("openai-kiro")
  })

  test("UPSTREAM_PROVIDER overrides provider config", async () => {
    process.env.UPSTREAM_PROVIDER = "codex"
    process.env.CODEX_AUTH_FILE = await codexAuthFile()
    process.env.KIRO_AUTH_FILE = await kiroAuthFile()

    const runtime = await bootstrapRuntime({ providerConfigPath: await providerConfigFile("kiro") })
    expect(runtime.upstream.constructor.name).toBe("Codex_Upstream_Provider")
    expect(runtime.registry.match("POST", "/v1/responses", new Headers())?.provider.name).toBe("openai")
  })

  test("explicit providerMode overrides UPSTREAM_PROVIDER", async () => {
    process.env.UPSTREAM_PROVIDER = "kiro"
    process.env.CODEX_AUTH_FILE = await codexAuthFile()
    expect((await bootstrapRuntime({ providerMode: "codex" })).upstream.constructor.name).toBe("Codex_Upstream_Provider")

    process.env.UPSTREAM_PROVIDER = "codex"
    process.env.KIRO_AUTH_FILE = await kiroAuthFile()
    expect((await bootstrapRuntime({ providerMode: "kiro" })).upstream.constructor.name).toBe("Kiro_Upstream_Provider")
  })

  test("KIRO_AUTH_FILE is respected and Kiro modelResolver is observable through GET /v1/models", async () => {
    const result = await runKiroModelResolverScenario()
    const sonnetModel = result.data.find((model) => model.id === "claude-sonnet-4.5")
    const customModel = result.data.find((model) => model.id === "custom-kiro-model")

    expect(result.data.map((model) => model.id)).toContain("claude-sonnet-4.5")
    expect(result.data.map((model) => model.id)).toContain("custom-kiro-model")
    expect(result.first_id).toBe(result.data[0].id)
    expect(typeof result.has_more).toBe("boolean")
    expect(result.last_id).toBe(result.data.at(-1)?.id ?? null)
    expect(sonnetModel).toMatchObject({
      id: "claude-sonnet-4.5",
      created_at: "2025-09-29T16:01:16Z",
      display_name: "Claude Sonnet 4.5",
      max_input_tokens: 1000000,
      max_tokens: 64000,
      type: "model",
    })
    expect(Object.keys(customModel ?? {}).sort()).toEqual(["capabilities", "created_at", "display_name", "id", "max_input_tokens", "max_tokens", "type"])
    expect(customModel).toMatchObject({
      id: "custom-kiro-model",
      capabilities: expect.any(Object),
      created_at: "1970-01-01T00:00:00Z",
      display_name: "Custom Kiro Model",
      max_input_tokens: 0,
      max_tokens: 0,
      type: "model",
    })
  })
})

async function runKiroModelResolverScenario() {
  const script = `
    import { mkdtempSync, writeFileSync } from "node:fs"
    import os from "node:os"
    import path from "node:path"

    const home = mkdtempSync(path.join(os.tmpdir(), "kiro-bootstrap-home-"))
    process.env.HOME = home

    const { bootstrapRuntime } = await import("./src/app/bootstrap.ts")

    const authDir = mkdtempSync(path.join(os.tmpdir(), "kiro-bootstrap-auth-"))
    const legacyAuthFile = path.join(authDir, "kiro-auth-token.json")
    writeFileSync(
      legacyAuthFile,
      JSON.stringify({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 700000).toISOString(),
        region: "eu-west-1",
      }),
    )

    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.includes("ListAvailableModels")) {
        return Response.json({ models: ["claude-sonnet-4-5", "custom-kiro-model"] })
      }
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    process.env.UPSTREAM_PROVIDER = "kiro"
    process.env.KIRO_AUTH_FILE = legacyAuthFile

    const runtime = await bootstrapRuntime()
    const route = runtime.registry.match("GET", "/v1/models", new Headers())
    if (!route) throw new Error("Kiro model route missing")

    const response = await route.provider.handle(
      new Request("http://localhost/v1/models", { method: "GET" }),
      route.descriptor,
      runtime.upstream,
      { requestId: "req_1", logBody: false, quiet: true },
    )
    const body = await response.json() as {
      data: Array<{ id: string } & Record<string, unknown>>
      first_id: string | null
      has_more: boolean
      last_id: string | null
    }

    console.log(JSON.stringify(body))
  `

  const proc = Bun.spawn({
    cmd: ["bun", "-e", script],
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    throw new Error(`Child process failed (${exitCode}): ${stderr || stdout}`)
  }

  return JSON.parse(stdout) as {
    data: Array<{ id: string } & Record<string, unknown>>
    first_id: string | null
    has_more: boolean
    last_id: string | null
  }
}

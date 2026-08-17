import { afterEach, describe, expect, test } from "bun:test"

import { writeCodexCliConfig } from "../../src/app/codex-cli-config"
import { codexCliModelIds, codexCliProfilePreview, codexCliStaticEntries } from "../../src/ui/codex-cli"
import type { Upstream_Provider } from "../../src/core/interfaces"
import { exists, mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempConfig(contents?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-cli-ui-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "config.toml")
  if (contents !== undefined) await writeFile(file, contents)
  return file
}

describe("Codex CLI setup preview", () => {
  test("shows the gateway as the provider target", () => {
    const entries = codexCliStaticEntries("http://127.0.0.1:8791")
    expect(entries.find((entry) => entry.key === "base_url")?.value).toBe("http://127.0.0.1:8791/codex/v1")
    expect(entries.find((entry) => entry.key === "wire_api")?.value).toBe("responses")
  })

  test("previews only what gets added to config.toml", () => {
    const preview = codexCliProfilePreview("http://127.0.0.1:8791")
    expect(preview).toContain("[model_providers.codex2claude]")
    expect(preview).toContain(`base_url = "http://127.0.0.1:8791/codex/v1"`)
    expect(preview).not.toMatch(/^model =/m)
  })

  test("lists one id per model, with no effort variants", async () => {
    const upstream = {
      async listModelDescriptors() {
        return [
          { id: "gpt-5.6-sol", effort: { schemaPath: "reasoning" as const, levels: ["low", "max"] } },
          "gpt-5.6-luna",
        ]
      },
    } as unknown as Upstream_Provider

    expect(await codexCliModelIds(upstream)).toEqual(["codex2claude-gpt-5.6-sol", "codex2claude-gpt-5.6-luna"])
    expect(await codexCliModelIds(undefined)).toEqual([])
  })
})

describe("Codex config.toml writer", () => {
  test("merges into the existing config and backs it up first", async () => {
    const original = `model = "gpt-5.6-sol"\n\n[features]\nmemories = true\n`
    const file = await tempConfig(original)

    const result = await writeCodexCliConfig({ path: file, baseUrl: "http://127.0.0.1:8787/v1" })

    expect(result.backupPath).toBe(`${file}.codex2claudecode.bak`)
    expect(await readFile(result.backupPath!, "utf8")).toBe(original)

    const written = await readFile(file, "utf8")
    expect(written).toContain(`model = "gpt-5.6-sol"`)
    expect(written).toContain("[features]")
    expect(written).toContain("[model_providers.codex2claude]")
    expect(written).toContain(`base_url = "http://127.0.0.1:8787/v1"`)
  })

  test("clears the shared models cache so Codex refetches the catalog", async () => {
    const file = await tempConfig(`model = "gpt-5.6-sol"\n`)
    const cache = path.join(path.dirname(file), "models_cache.json")
    await writeFile(cache, `{"models":[{"slug":"gpt-5.6-sol"}]}`)

    const result = await writeCodexCliConfig({ path: file })

    expect(result.clearedModelsCache).toBe(true)
    expect(await exists(cache)).toBe(false)
  })

  test("reports nothing to clear when there is no models cache", async () => {
    const file = await tempConfig(`model = "gpt-5.6-sol"\n`)
    expect((await writeCodexCliConfig({ path: file })).clearedModelsCache).toBe(false)
  })

  test("creates the config when there is none", async () => {
    const file = await tempConfig()

    const result = await writeCodexCliConfig({ path: file })

    expect(result.backupPath).toBeUndefined()
    expect(await readFile(file, "utf8")).toContain("[model_providers.codex2claude]")
  })

  test("running it twice leaves a single managed block", async () => {
    const file = await tempConfig(`model = "gpt-5.6-sol"\n\n[features]\nmemories = true\n`)

    await writeCodexCliConfig({ path: file, baseUrl: "http://127.0.0.1:8787/v1" })
    await writeCodexCliConfig({ path: file, baseUrl: "http://127.0.0.1:9000/v1" })

    const written = await readFile(file, "utf8")
    expect(written.split("[model_providers.codex2claude]")).toHaveLength(2)
    expect(written).toContain("http://127.0.0.1:9000/v1")
    expect(written).not.toContain("8787")
  })
})

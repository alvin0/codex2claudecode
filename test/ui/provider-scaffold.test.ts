import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { codexProviderDefinition } from "../../src/ui/providers/codex"
import { copilotProviderDefinition } from "../../src/ui/providers/copilot"
import { kiroProviderDefinition } from "../../src/ui/providers/kiro"
import { exists, mkdtemp, path, readFile, rm, tmpdir } from "../helpers"

const tempDirs: string[] = []
const originalEnv = { ...process.env }

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "provider-scaffold-home-"))
  tempDirs.push(home)
  Bun.env.HOME = home
  process.env.HOME = home
})

afterEach(async () => {
  Bun.env.HOME = originalEnv.HOME
  if (originalEnv.HOME) process.env.HOME = originalEnv.HOME
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("provider auth scaffolds", () => {
  test("codex validate creates an empty auth file and loadState accepts it", async () => {
    const authFile = codexProviderDefinition.authFile()

    await expect(codexProviderDefinition.validate()).resolves.toBeUndefined()
    expect(await exists(authFile)).toBe(true)
    expect(JSON.parse(await readFile(authFile, "utf8"))).toEqual({ codex: { data: [] } })

    const state = await codexProviderDefinition.accounts!.loadState(authFile)
    expect(state.data).toEqual([])
    expect(state.selected).toBe(0)
    expect(codexProviderDefinition.accounts!.toAccounts(state.data)).toEqual([])
  })

  test("kiro validate creates a scaffold file and loadState accepts the empty state", async () => {
    const authFile = kiroProviderDefinition.authFile()

    await expect(kiroProviderDefinition.validate()).resolves.toBeUndefined()
    expect(await exists(authFile)).toBe(true)
    expect(JSON.parse(await readFile(authFile, "utf8"))).toMatchObject({ kiro: { data: { accounts: [] } } })

    const state = await kiroProviderDefinition.accounts!.loadState(authFile)
    expect(state.selected).toBe(0)
    expect(kiroProviderDefinition.accounts!.toAccounts(state.data)).toEqual([])
  })

  test("copilot validate creates a scaffold file and loadState accepts the empty state", async () => {
    const authFile = copilotProviderDefinition.authFile()

    await expect(copilotProviderDefinition.validate()).resolves.toBeUndefined()
    expect(await exists(authFile)).toBe(true)
    expect(JSON.parse(await readFile(authFile, "utf8"))).toMatchObject({ copilot: { data: { accounts: [] } } })

    const state = await copilotProviderDefinition.accounts!.loadState(authFile)
    expect(state.selected).toBe(0)
    expect(copilotProviderDefinition.accounts!.toAccounts(state.data)).toEqual([])
  })
})

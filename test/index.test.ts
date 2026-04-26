import { afterEach, describe, expect, test } from "bun:test"

import { runExample } from "../src/app/example"
import { mkdtemp, path, rm, tmpdir, writeFile } from "./helpers"

const originalFetch = globalThis.fetch
const originalAuthFile = process.env.CODEX_AUTH_FILE
const tempDirs: string[] = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAuthFile === undefined) delete process.env.CODEX_AUTH_FILE
  else process.env.CODEX_AUTH_FILE = originalAuthFile
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("runExample uses the standalone client", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-index-test-"))
  tempDirs.push(dir)
  process.env.CODEX_AUTH_FILE = path.join(dir, "auth-codex.json")
  await writeFile(process.env.CODEX_AUTH_FILE, JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 }))
  globalThis.fetch = (() => Promise.resolve(Response.json({ ok: true }))) as unknown as typeof fetch

  const logs: unknown[][] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => logs.push(args)
  try {
    await runExample()
  } finally {
    console.log = originalLog
  }

  expect(JSON.stringify(logs)).toContain('\\"ok\\": true')
})

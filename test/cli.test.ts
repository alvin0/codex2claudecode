import { expect, test } from "bun:test"

import { parseCliOptions } from "../src/app/cli"

test("parses port flags", () => {
  expect(parseCliOptions(["-p", "8786"])).toEqual({ port: 8786 })
  expect(parseCliOptions(["--port", "8785"])).toEqual({ port: 8785 })
  expect(parseCliOptions(["--port=8784"])).toEqual({ port: 8784 })
  expect(parseCliOptions([])).toEqual({})
  expect(parseCliOptions(["--unknown"])).toEqual({})
  expect(parseCliOptions()).toEqual({})
  expect(() => parseCliOptions(["--port", "bad"])).toThrow("Invalid port")
  expect(() => parseCliOptions(["--port", "0"])).toThrow("Invalid port")
  expect(() => parseCliOptions(["--port", "70000"])).toThrow("Invalid port")
})

test("npm launcher explains Bun and npm fallback when both are unavailable", async () => {
  const proc = Bun.spawn({
    cmd: ["node", "bin/codex2claudecode"],
    env: {
      ...process.env,
      BUN_BINARY: "/definitely/missing/bun",
      NPX_BINARY: "/definitely/missing/npx",
    },
    stderr: "pipe",
    stdout: "pipe",
  })

  const [exitCode, stderr] = await Promise.all([proc.exited, streamText(proc.stderr)])

  expect(exitCode).not.toBe(0)
  expect(stderr).toContain("codex2claudecode requires Bun at runtime")
  expect(stderr).toContain("npx --yes bun@latest --version")
})

async function streamText(stream: ReadableStream<Uint8Array> | number | undefined) {
  if (!(stream instanceof ReadableStream)) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    output += decoder.decode(chunk.value, { stream: true })
  }
  return output + decoder.decode()
}

import { describe, expect, test } from "bun:test"

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

describe("password flag parsing", () => {
  test("--password <value> parses the password", () => {
    expect(parseCliOptions(["--password", "mysecret"])).toEqual({ password: "mysecret" })
  })

  test("--password=<value> parses the password", () => {
    expect(parseCliOptions(["--password=mysecret"])).toEqual({ password: "mysecret" })
  })

  test("--password without a value throws an error", () => {
    expect(() => parseCliOptions(["--password"])).toThrow("--password requires a value")
  })

  test("--password followed by another flag throws an error", () => {
    expect(() => parseCliOptions(["--password", "--port"])).toThrow("--password requires a value")
    expect(() => parseCliOptions(["--password", "-p"])).toThrow("--password requires a value")
    expect(() => parseCliOptions(["--password", "-H"])).toThrow("--password requires a value")
  })

  test("no --password flag returns options without password", () => {
    const result = parseCliOptions([])
    expect(result).toEqual({})
    expect("password" in result).toBe(false)
  })

  test("-p 8080 still works for port (no conflict with password)", () => {
    expect(parseCliOptions(["-p", "8080"])).toEqual({ port: 8080 })
  })

  test("--password and -p can be used together", () => {
    expect(parseCliOptions(["--password", "secret123", "-p", "9090"])).toEqual({
      password: "secret123",
      port: 9090,
    })
  })

  test("--password= with empty value returns no password", () => {
    const result = parseCliOptions(["--password="])
    expect(result).toEqual({})
    expect("password" in result).toBe(false)
  })
})

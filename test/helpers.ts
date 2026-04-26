import { expect } from "bun:test"

import { fileStat, makeTempDir, pathExists, readTextFile, removePath, writeTextFile, type BunRemoveOptions, type BunWriteFileOptions } from "../src/core/bun-fs"
import { bunPath as path, homeDir, makeDir, pathToFileHref, tempDir } from "../src/core/paths"

export { path }

export function homedir() {
  return homeDir()
}

export function tmpdir() {
  return tempDir()
}

export async function mkdtemp(prefix: string) {
  return makeTempDir(prefix)
}

export async function mkdir(dir: string, _options?: { recursive?: boolean }) {
  return makeDir(dir)
}

export async function readFile(file: string, _encoding?: string) {
  return readTextFile(file)
}

export async function writeFile(file: string, content: string, options?: BunWriteFileOptions) {
  return writeTextFile(file, content, options)
}

export async function rm(file: string, options?: BunRemoveOptions) {
  return removePath(file, options)
}

export async function stat(file: string) {
  return fileStat(file)
}

export async function exists(file: string) {
  return pathExists(file)
}

export function pathToFileURL(file: string) {
  return new URL(pathToFileHref(file))
}

export function randomUUID() {
  return crypto.randomUUID()
}

export function jwt(payload: unknown) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".")
}

export function sse(events: unknown[]) {
  return events.map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

export async function readSse(response: Response) {
  expect(response.body).toBeTruthy()
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: Array<{ event?: string; data: any }> = []

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    while (buffer.includes("\n\n")) {
      const index = buffer.indexOf("\n\n")
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const name = raw
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim()
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data) events.push({ event: name, data: JSON.parse(data) })
    }
  }

  return events
}

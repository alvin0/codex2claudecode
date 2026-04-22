import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const APP_DATA_DIR_NAME = ".codex2claudecode"
export const AUTH_FILE_NAME = "auth-codex.json"

export function appDataDir() {
  return path.join(homedir(), APP_DATA_DIR_NAME)
}

export function defaultAuthFile() {
  return path.join(appDataDir(), AUTH_FILE_NAME)
}

export async function ensureParentDir(file: string) {
  await mkdir(path.dirname(file), { recursive: true })
}

export function expandHome(value: string) {
  if (value === "~") return homedir()
  // Support both Unix-style "~/" and Windows-style "~\" separators
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2))
  return value
}

export function resolveAuthFile(input?: string) {
  return input ? expandHome(input) : defaultAuthFile()
}

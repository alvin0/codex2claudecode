import { runBunCommand, windowsPowerShellCommands } from "./bun-command"

export const APP_DATA_DIR_NAME = ".codex2claudecode"
export const AUTH_FILE_NAME = "auth-codex.json"

const WINDOWS_DRIVE_ROOT = /^([A-Za-z]:)(?:[\\/]|$)/
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/

export const bunPath = {
  dirname: dirnamePath,
  join: joinPath,
  normalize: normalizePath,
  resolve: resolvePath,
}

export function homeDir(env: Record<string, string | undefined> = Bun.env) {
  const home = env.HOME || env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
  if (!home) throw new Error("Unable to resolve the home directory from Bun.env")
  return home
}

export function tempDir(env: Record<string, string | undefined> = Bun.env) {
  return env.TMPDIR || env.TEMP || env.TMP || joinPath(homeDir(env), ".tmp")
}

export function appDataDir() {
  return joinPath(homeDir(), APP_DATA_DIR_NAME)
}

export function defaultAuthFile() {
  return joinPath(appDataDir(), AUTH_FILE_NAME)
}

export async function ensureParentDir(file: string) {
  await makeDir(dirnamePath(file))
}

export function expandHome(value: string) {
  if (value === "~") return homeDir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return joinPath(homeDir(), value.slice(2))
  return value
}

export function resolveAuthFile(input?: string) {
  return input ? expandHome(input) : defaultAuthFile()
}

export async function makeDir(dir: string) {
  if (!dir || dir === ".") return
  if (await isDirectory(dir)) return

  await runBunCommand(
    process.platform === "win32"
      ? windowsPowerShellCommands("New-Item -ItemType Directory -Force -LiteralPath $args[0] | Out-Null", dir)
      : [["mkdir", "-p", "--", dir]],
    { action: "create directory", target: dir },
  )
}

export function joinPath(...parts: string[]) {
  const nonEmpty = parts.filter((part) => part.length > 0)
  if (!nonEmpty.length) return "."

  let joined = nonEmpty[0]
  for (const part of nonEmpty.slice(1)) {
    joined = isAbsolutePath(part) ? part : `${trimTrailingSlashes(joined)}/${trimLeadingSlashes(part)}`
  }
  return normalizePath(joined)
}

export function dirnamePath(file: string) {
  const normalized = normalizePath(file)
  const canonical = toCanonicalSlashes(normalized)
  const drive = canonical.match(WINDOWS_DRIVE_ROOT)?.[1]
  const root = drive ? `${drive}/` : canonical.startsWith("/") ? "/" : ""
  const trimmed = trimTrailingSlashes(canonical)

  if (trimmed === root.replace(/\/$/, "")) return root ? fromCanonicalSlashes(root) : "."
  const index = trimmed.lastIndexOf("/")
  if (index < 0) return "."
  if (index === 0) return fromCanonicalSlashes("/")
  return fromCanonicalSlashes(trimmed.slice(0, index))
}

export function resolvePath(...parts: string[]) {
  let resolved = process.cwd()
  for (const part of parts.length ? parts : ["."]) {
    if (!part) continue
    resolved = isAbsolutePath(part) ? part : joinPath(resolved, part)
  }
  return normalizePath(resolved)
}

export function normalizePath(value: string) {
  if (!value) return "."

  const canonical = toCanonicalSlashes(value)
  const driveMatch = canonical.match(WINDOWS_DRIVE_ROOT)
  let root = ""
  let rest = canonical

  if (driveMatch) {
    root = canonical.startsWith(`${driveMatch[1]}/`) ? `${driveMatch[1]}/` : driveMatch[1]
    rest = canonical.slice(root.length)
  } else if (canonical.startsWith("/")) {
    root = "/"
    rest = canonical.slice(1)
  }

  const stack: string[] = []
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") {
        stack.pop()
      } else if (!root) {
        stack.push(part)
      }
      continue
    }
    stack.push(part)
  }

  const normalized = `${root}${stack.join("/")}`
  return fromCanonicalSlashes(normalized || root || ".")
}

export function pathToFileHref(file: string) {
  return Bun.pathToFileURL(file).href
}

export function fileUrlToPath(url: string | URL) {
  return Bun.fileURLToPath(url)
}

export function isAbsolutePath(value: string) {
  return value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE_ABSOLUTE.test(value)
}

async function isDirectory(value: string) {
  try {
    return (await Bun.file(value).stat()).isDirectory()
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined
}

function toCanonicalSlashes(value: string) {
  return value.replace(/[\\/]+/g, "/")
}

function fromCanonicalSlashes(value: string) {
  return process.platform === "win32" ? value.replace(/\//g, "\\") : value
}

function trimLeadingSlashes(value: string) {
  return value.replace(/^[\\/]+/, "")
}

function trimTrailingSlashes(value: string) {
  return value.replace(/[\\/]+$/, "")
}

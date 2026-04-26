import { makeDir } from "./paths"
import { runBunCommand, windowsPowerShellCommands } from "./bun-command"

export interface BunWriteFileOptions {
  mode?: number
}

export interface BunRemoveOptions {
  force?: boolean
  recursive?: boolean
}

export async function readTextFile(file: string) {
  return Bun.file(file).text()
}

export async function writeTextFile(file: string, content: string, options: BunWriteFileOptions = {}) {
  await Bun.write(file, content, options.mode === undefined ? undefined : { mode: options.mode })
}

export async function pathExists(file: string) {
  try {
    await Bun.file(file).stat()
    return true
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

export async function readDirectory(dir: string) {
  const entries: string[] = []
  for await (const entry of new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false })) {
    entries.push(entry)
  }
  return entries
}

export async function removePath(target: string, options: BunRemoveOptions = {}) {
  if (options.recursive) return removeWithCommand(target, options.force)

  try {
    const stat = await Bun.file(target).stat()
    if (stat.isDirectory()) return removeWithCommand(target, options.force)
    await Bun.file(target).delete()
  } catch (error) {
    if (options.force && isNotFoundError(error)) return
    throw error
  }
}

export async function makeTempDir(prefix: string) {
  const dir = `${prefix}${crypto.randomUUID()}`
  await makeDir(dir)
  return dir
}

export async function setFileMode(file: string, mode: number) {
  if (process.platform === "win32") return
  await runBunCommand([["chmod", mode.toString(8), file]], { action: `set mode ${mode.toString(8)} on`, target: file })
}

export async function fileStat(file: string) {
  return Bun.file(file).stat()
}

export function isNotFoundError(error: unknown) {
  return errorCode(error) === "ENOENT"
}

export function isBusyError(error: unknown) {
  const code = errorCode(error)
  return code === "EBUSY" || code === "EPERM"
}

export function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined
}

async function removeWithCommand(target: string, force = false) {
  if (force && !(await pathExists(target))) return

  await runBunCommand(
    process.platform === "win32"
      ? windowsPowerShellCommands(`Remove-Item -LiteralPath $args[0] -Recurse${force ? " -Force" : ""}`, target)
      : [["rm", force ? "-rf" : "-r", "--", target]],
    { action: "remove", target },
  )
}

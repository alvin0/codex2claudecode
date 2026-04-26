export interface BunCommandContext {
  action: string
  target: string
}

export function windowsPowerShellCommands(script: string, ...args: string[]) {
  const commandArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, ...args]
  return [
    ["powershell.exe", ...commandArgs],
    ["pwsh", ...commandArgs],
  ]
}

export async function runBunCommand(candidates: string[][], context: BunCommandContext) {
  const missingCommands: string[] = []

  for (const cmd of candidates) {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
    try {
      proc = Bun.spawn({
        cmd,
        stderr: "pipe",
        stdout: "pipe",
      })
    } catch (error) {
      if (isCommandNotFoundError(error)) {
        missingCommands.push(cmd[0] ?? "<unknown>")
        continue
      }
      throw error
    }

    const [exitCode, stderr, stdout] = await Promise.all([
      proc.exited,
      streamText(proc.stderr),
      streamText(proc.stdout),
    ])

    if (exitCode === 0) return
    throw commandFailure(context, cmd, exitCode, stderr || stdout)
  }

  const commands = [...new Set(missingCommands)].join(", ")
  throw new Error(`Failed to ${context.action} ${context.target}: command not found${commands ? ` (${commands})` : ""}`)
}

async function streamText(stream: ReadableStream<Uint8Array> | number | undefined) {
  if (!(stream instanceof ReadableStream)) return ""

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  text += decoder.decode()
  return text.trim()
}

function commandFailure(context: BunCommandContext, cmd: string[], exitCode: number, output: string) {
  const command = cmd.map(formatCommandPart).join(" ")
  return new Error(
    `Failed to ${context.action} ${context.target}: command exited with ${exitCode} (${command})${output ? `: ${output}` : ""}`,
  )
}

function formatCommandPart(value: string) {
  return /\s/.test(value) ? JSON.stringify(value) : value
}

function isCommandNotFoundError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined
  if (code === "ENOENT") return true
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes("no such file") || message.includes("not found")
}

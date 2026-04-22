const encoder = new TextEncoder()

type ClipboardBackend = {
  name: string
  isAvailable: () => boolean
  write: (text: string) => Promise<void>
}

const BACKENDS: ClipboardBackend[] = [
  {
    name: "powershell.exe",
    isAvailable: () => Boolean(Bun.which("powershell.exe")),
    write: async (text) => {
      await runCommand(["powershell.exe", "-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], text)
    },
  },
  {
    name: "clip.exe",
    isAvailable: () => Boolean(Bun.which("clip.exe")),
    write: async (text) => {
      await runCommand(["bash", "-lc", "clip.exe"], text)
    },
  },
  {
    name: "pbcopy",
    isAvailable: () => Boolean(Bun.which("pbcopy")),
    write: async (text) => {
      await runCommand(["pbcopy"], text)
    },
  },
  {
    name: "wl-copy",
    isAvailable: () => Boolean(Bun.which("wl-copy")),
    write: async (text) => {
      await runCommand(["wl-copy"], text)
    },
  },
  {
    name: "xclip",
    isAvailable: () => Boolean(Bun.which("xclip")),
    write: async (text) => {
      await runCommand(["xclip", "-selection", "clipboard"], text)
    },
  },
]

export async function writeClipboard(text: string) {
  const attemptedErrors: string[] = []

  for (const backend of BACKENDS) {
    if (!backend.isAvailable()) continue
    try {
      await backend.write(text)
      return
    } catch (error) {
      attemptedErrors.push(`${backend.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!attemptedErrors.length) throw new Error("No clipboard backend available")
  throw new Error(attemptedErrors.join(" | "))
}

async function runCommand(cmd: string[], text: string) {
  const process = Bun.spawn({
    cmd,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  })

  try {
    process.stdin.write(encoder.encode(text))
    process.stdin.end()
    const exitCode = await process.exited
    if (exitCode === 0) return

    const errorText = (await new Response(process.stderr).text()).trim()
    throw new Error(errorText || `exited with code ${exitCode}`)
  } finally {
    process.kill()
  }
}

import type { ProviderName } from "./llm-connect/factory"

export interface CliOptions {
  port?: number
  provider?: ProviderName
}

export function parseCliOptions(args = process.argv.slice(2)): CliOptions {
  const port = args.flatMap((arg, index) => {
    if (arg === "-p" || arg === "--port") return [args[index + 1]]
    if (arg.startsWith("--port=")) return [arg.slice("--port=".length)]
    return []
  })[0]

  const provider = args.flatMap((arg, index) => {
    if (arg === "--provider") return [args[index + 1]]
    if (arg.startsWith("--provider=")) return [arg.slice("--provider=".length)]
    return []
  })[0]

  return {
    ...(port !== undefined && { port: parsePort(port) }),
    ...(provider !== undefined && { provider: parseProvider(provider) }),
  }
}

function parsePort(value: string) {
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid port: ${value}`)
  return port
}

function parseProvider(value: string): ProviderName {
  const normalized = value.toLowerCase()
  if (normalized === "codex" || normalized === "kiro") return normalized
  throw new Error(`Invalid provider: ${value}. Must be "codex" or "kiro".`)
}

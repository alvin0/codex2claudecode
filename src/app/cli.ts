export interface CliOptions {
  port?: number
  hostname?: string
}

export function parseCliOptions(args = process.argv.slice(2)): CliOptions {
  const port = args.flatMap((arg, index) => {
    if (arg === "-p" || arg === "--port") return [args[index + 1]]
    if (arg.startsWith("--port=")) return [arg.slice("--port=".length)]
    return []
  })[0]
  const hostname = args.flatMap((arg, index) => {
    if (arg === "-H" || arg === "--hostname") return [args[index + 1]]
    if (arg.startsWith("--hostname=")) return [arg.slice("--hostname=".length)]
    return []
  })[0]
  return {
    ...(port !== undefined && { port: parsePort(port) }),
    ...(hostname !== undefined && { hostname }),
  }
}

function parsePort(value: string) {
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid port: ${value}`)
  return port
}

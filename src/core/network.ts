import { networkInterfaces } from "os"

/** Returns the first non-internal IPv4 address, or undefined when none is found. */
export function getLocalNetworkIp(): string | undefined {
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  return undefined
}

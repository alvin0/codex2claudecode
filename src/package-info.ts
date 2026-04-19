import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface PackageJson {
  version?: string
  author?: string
}

export function packageInfo(): Required<PackageJson> {
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as PackageJson
  return {
    version: pkg.version ?? "0.0.0",
    author: pkg.author ?? "unknown",
  }
}

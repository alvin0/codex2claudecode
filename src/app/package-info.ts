import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface PackageJson {
  version?: string
  author?: string
}

function findPackageJson(startDir: string): string {
  let dir = startDir
  while (true) {
    const candidate = path.join(dir, "package.json")
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find package.json in any ancestor directory starting from ${startDir}`)
    }
    dir = parent
  }
}

export function packageInfo(): Required<PackageJson> {
  const pkg = JSON.parse(readFileSync(findPackageJson(path.dirname(fileURLToPath(import.meta.url))), "utf8")) as PackageJson
  return {
    version: pkg.version ?? "0.0.0",
    author: pkg.author ?? "unknown",
  }
}

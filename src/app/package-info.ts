import pkg from "../../package.json"

interface PackageJson {
  version?: string
  author?: string
}

export function packageInfo(): Required<PackageJson> {
  return {
    version: pkg.version ?? "0.0.0",
    author: pkg.author ?? "unknown",
  }
}

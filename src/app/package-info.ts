import pkg from "../../package.json"

interface PackageJson {
  version?: string
  author?: string
}

const DEFAULT_PACKAGE_INFO: Required<PackageJson> = {
  version: "0.0.0",
  author: "unknown",
}

export function packageInfo(): Required<PackageJson> {
  return {
    ...DEFAULT_PACKAGE_INFO,
    ...pkg,
  }
}

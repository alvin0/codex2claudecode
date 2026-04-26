import { path, readFile } from "./helpers"

const cache = new Map<string, Promise<string[]>>()

function fileExists(file: string) {
  return Bun.file(file).size > 0
}

function resolveRelative(fromFile: string, specifier: string) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]
  return candidates.find(fileExists)
}

function parseExportNames(spec: string) {
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^type\s+/, ""))
    .map((part) => {
      const match = part.match(/^(.*?)\s+as\s+(.*)$/)
      return (match ? match[2] : part).trim()
    })
    .filter((name) => name.length > 0 && name !== "default")
}

export async function extractModuleExportNames(file: string): Promise<string[]> {
  const resolved = path.resolve(file)
  if (cache.has(resolved)) return cache.get(resolved)!

  const promise = (async () => {
    const content = await readFile(resolved, "utf8")
    const names = new Set<string>()

    for (const match of content.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(match[1])
    }

    for (const match of content.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s*from\s*["']([^"']+)["'])?/g)) {
      for (const name of parseExportNames(match[1])) names.add(name)
    }

    for (const match of content.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g)) {
      names.add(match[1])
    }

    for (const match of content.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
      const target = resolveRelative(resolved, match[1])
      if (!target) continue
      for (const name of await extractModuleExportNames(target)) names.add(name)
    }

    return [...names].sort()
  })()

  cache.set(resolved, promise)
  return promise
}

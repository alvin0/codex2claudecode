import type { Inbound_Provider, Route_Descriptor } from "./interfaces"

export interface RegisteredRoute {
  descriptor: Route_Descriptor
  provider: Inbound_Provider
}

interface InternalRegisteredRoute extends RegisteredRoute {
  fullPath: string
  registrationOrder: number
}

export class Provider_Registry {
  private readonly routes: InternalRegisteredRoute[] = []

  register(provider: Inbound_Provider): void {
    for (const descriptor of provider.routes()) {
      const fullPath = resolveRoutePath(descriptor)
      const conflict = this.routes.find((registered) => {
        return (
          registered.descriptor.method === descriptor.method &&
          equivalentPathPattern(registered.fullPath, fullPath) &&
          equivalentDiscriminator(registered.descriptor.headerDiscriminator, descriptor.headerDiscriminator)
        )
      })

      if (conflict) {
        throw new Error(
          `Route conflict for ${descriptor.method} ${fullPath} between providers ${conflict.provider.name} and ${provider.name}`,
        )
      }

      this.routes.push({
        descriptor,
        provider,
        fullPath,
        registrationOrder: this.routes.length,
      })
    }
  }

  match(method: string, pathname: string, headers: Headers): RegisteredRoute | undefined {
    const matches = this.routes
      .filter((route) => route.descriptor.method === method)
      .filter((route) => matchesPath(route.fullPath, pathname))
      .map((route) => ({ route, specificity: routeSpecificity(route.descriptor, headers) }))
      .filter((entry): entry is { route: InternalRegisteredRoute; specificity: number } => entry.specificity >= 0)
      .sort((left, right) => {
        if (right.specificity !== left.specificity) return right.specificity - left.specificity
        return left.route.registrationOrder - right.route.registrationOrder
      })

    const winner = matches[0]?.route
    return winner ? { descriptor: winner.descriptor, provider: winner.provider } : undefined
  }

  listRoutes() {
    return this.routes.map((route) => ({
      path: route.fullPath,
      method: route.descriptor.method,
      provider: route.provider.name,
    }))
  }
}

function routeSpecificity(descriptor: Route_Descriptor, headers: Headers): number {
  const discriminator = descriptor.headerDiscriminator
  if (!discriminator) return 0
  const value = headers.get(discriminator.name)
  if (discriminator.mode === "presence") return value !== null ? 1 : -1
  return value === discriminator.value ? 2 : -1
}

function resolveRoutePath(descriptor: Route_Descriptor) {
  return normalizeJoinedPath(descriptor.basePath, descriptor.path)
}

function normalizeJoinedPath(basePath = "", pathname = "") {
  const base = normalizePathSegment(basePath)
  const path = normalizePathSegment(pathname)
  if (base === "/") return path
  if (path === "/") return base
  return `${base}${path}`.replace(/\/{2,}/g, "/")
}

function normalizePathSegment(value: string) {
  if (!value || value === "/") return "/"
  return `/${value.replace(/^\/+|\/+$/g, "")}`
}

function tokenizePath(pathname: string) {
  const normalized = normalizePathSegment(pathname)
  if (normalized === "/") return []
  return normalized.slice(1).split("/")
}

function matchesPath(pattern: string, pathname: string) {
  const patternSegments = tokenizePath(pattern)
  const pathSegments = tokenizePath(pathname)
  if (patternSegments.length !== pathSegments.length) return false

  return patternSegments.every((segment, index) => {
    if (segment.startsWith(":")) return pathSegments[index]?.length > 0
    return segment === pathSegments[index]
  })
}

function equivalentPathPattern(left: string, right: string) {
  const leftSegments = tokenizePath(left)
  const rightSegments = tokenizePath(right)
  if (leftSegments.length !== rightSegments.length) return false

  return leftSegments.every((segment, index) => {
    const other = rightSegments[index]
    if (segment.startsWith(":") && other?.startsWith(":")) return true
    return segment === other
  })
}

function equivalentDiscriminator(left: Route_Descriptor["headerDiscriminator"], right: Route_Descriptor["headerDiscriminator"]) {
  if (!left && !right) return true
  if (!left || !right) return false
  if (left.mode !== right.mode) return false
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false
  if (left.mode === "exact") return left.value === right.value
  return true
}

// Exposed-name mangling and reverse resolution for MCP tools (design D6).
//
// An MCP tool is exposed to the upstream as an ordinary function tool named
// `mcp__<serverLabel>__<toolName>`, matching the `mcp__${server}` convention already used by the
// inbound Claude MCP adapter. Upstreams cap tool-name length, so the mangler needs a ceiling — and
// that ceiling is **supplied by the caller**, never hardcoded here: this module is provider-agnostic
// (Requirement 20.7) and imports nothing outside `src/core/`.
//
// The map is the round trip. `exposedName()` registers both directions; `resolve()` reads the
// reverse direction back. `resolve()` returning `undefined` is meaningful rather than an error: the
// tool call is not an MCP call, so it passes through to the client as an ordinary function tool.

import { createHash } from "node:crypto"

/** A tool on a specific MCP server. `serverUrl` is what keeps two same-labelled servers distinct. */
export interface McpToolIdentity {
  serverLabel: string
  serverUrl: string
  toolName: string
}

export interface McpToolNameMap {
  /**
   * The exposed function-tool name for `identity`, within the configured limit. Idempotent: the
   * same identity always yields the same name, and repeated calls register nothing new.
   */
  exposedName(identity: McpToolIdentity): string
  /**
   * The identity behind an exposed name, or `undefined` when the name was never exposed by this
   * map — meaning the call is not an MCP call and passes through as an ordinary client tool call.
   */
  resolve(exposedName: string): McpToolIdentity | undefined
  /** Every registration, in the order the names were first handed out. */
  entries(): ReadonlyArray<[string, McpToolIdentity]>
}

/** `mcp__` + `__` + `__` + an 8-character digest. */
const NAME_PREFIX = "mcp__"
const SEGMENT_SEPARATOR = "__"
const DIGEST_LENGTH = 8

/**
 * Fixed cost of the mangled form: the prefix, the two separators, and the digest. Any limit must
 * leave room for this plus one character of each segment.
 */
const MANGLED_OVERHEAD = NAME_PREFIX.length + SEGMENT_SEPARATOR.length * 2 + DIGEST_LENGTH

/**
 * The smallest ceiling this mangler accepts: the mangled overhead, one character per segment, and
 * two characters for the deterministic collision counter, so the collision path stays inside the
 * limit as well. Callers pass their own upstream limit, which is far larger in practice.
 */
export const MCP_EXPOSED_NAME_MIN_LENGTH = MANGLED_OVERHEAD + 2 + 2

/** RFC 4648 base32, lowercased. Every character is already legal in a tool name. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

/** Characters a tool name may not carry; every other run of one is replaced by a single `_`. */
const ILLEGAL_CHARACTERS = /[^A-Za-z0-9_-]/g

function sanitizeSegment(value: string): string {
  return value.replace(ILLEGAL_CHARACTERS, "_")
}

/**
 * The canonical key of an identity — `serverUrl`, `serverLabel`, `toolName` joined by NUL. NUL
 * cannot occur inside any of the three in a way that shifts a boundary, so the key is injective in
 * the identity, which is what makes the digest distinguish two servers whose labels truncate equal.
 */
function identityKey(identity: McpToolIdentity): string {
  return `${identity.serverUrl}\u0000${identity.serverLabel}\u0000${identity.toolName}`
}

/** First {@link DIGEST_LENGTH} lowercase base32 characters of SHA-256 over the canonical key. */
function digest8(key: string): string {
  const bytes = createHash("sha256").update(key, "utf8").digest()
  let bits = 0
  let accumulator = 0
  let out = ""
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(accumulator >>> bits) & 0b11111]
      if (out.length === DIGEST_LENGTH) return out
    }
  }
  return out
}

/**
 * Split `budget` characters between the two segments in proportion to their lengths.
 *
 * When both fit, nothing is shortened. When they do not, the two kept lengths sum to `budget`
 * *exactly*, so the mangled name lands exactly on the limit — that is what makes the bound tight
 * rather than approximate. Each segment keeps at least one character whenever it had one and the
 * budget can afford it, so neither side collapses into invisibility.
 */
export function allocateSegmentBudget(
  budget: number,
  serverLength: number,
  toolLength: number,
): { server: number; tool: number } {
  if (budget <= 0) return { server: 0, tool: 0 }
  const total = serverLength + toolLength
  if (total <= budget) return { server: serverLength, tool: toolLength }

  let server = Math.min(Math.round((budget * serverLength) / total), serverLength, budget)
  let tool = budget - server
  if (tool > toolLength) {
    tool = toolLength
    server = budget - tool
  }
  if (serverLength > 0 && server === 0 && tool > 1) {
    server = 1
    tool -= 1
  }
  if (toolLength > 0 && tool === 0 && server > 1) {
    tool = 1
    server -= 1
  }
  return { server, tool }
}

/**
 * Create an exposed-name map bounded by `maxNameLength`.
 *
 * @throws RangeError when the limit cannot hold a mangled name — a limit that small is a
 * configuration mistake, not an input to work around silently.
 */
export function createMcpToolNameMap(options: { maxNameLength: number }): McpToolNameMap {
  const maxNameLength = options.maxNameLength
  if (!Number.isInteger(maxNameLength) || maxNameLength < MCP_EXPOSED_NAME_MIN_LENGTH) {
    throw new RangeError(
      `maxNameLength must be an integer of at least ${MCP_EXPOSED_NAME_MIN_LENGTH}, received ${String(maxNameLength)}`,
    )
  }

  /** Forward direction, keyed by canonical identity key — this is what makes the map idempotent. */
  const byIdentity = new Map<string, string>()
  /** Reverse direction, in insertion order, which `entries()` returns. */
  const byName = new Map<string, McpToolIdentity>()

  function register(key: string, name: string, identity: McpToolIdentity): string {
    byIdentity.set(key, name)
    byName.set(name, { ...identity })
    return name
  }

  /**
   * Deterministic last resort, reached only if the digest form collides for every counter the limit
   * can express. Scans short numeric names until it finds a free one, so a name always exists: the
   * registry is finite and this family is not.
   */
  function fallbackName(): string {
    for (let index = 1; ; index += 1) {
      const candidate = `${NAME_PREFIX}${index}`
      if (candidate.length <= maxNameLength && !byName.has(candidate)) return candidate
    }
  }

  return {
    exposedName(identity: McpToolIdentity): string {
      const key = identityKey(identity)
      const existing = byIdentity.get(key)
      if (existing !== undefined) return existing

      const server = sanitizeSegment(identity.serverLabel)
      const tool = sanitizeSegment(identity.toolName)

      // 1. The plain candidate, when it fits and nothing else holds it.
      const plain = `${NAME_PREFIX}${server}${SEGMENT_SEPARATOR}${tool}`
      if (plain.length <= maxNameLength && !byName.has(plain)) return register(key, plain, identity)

      // 2. The mangled form, shortened to land exactly on the limit.
      const digest = digest8(key)
      for (let counter = 1; ; counter += 1) {
        // A counter suffix appears only after the first attempt, so the common mangled name carries
        // no `_2` noise; on a collision the segments give back the two characters it costs.
        const suffix = counter === 1 ? "" : `_${counter}`
        const budget = maxNameLength - MANGLED_OVERHEAD - suffix.length
        if (budget < 2) return register(key, fallbackName(), identity)
        const kept = allocateSegmentBudget(budget, server.length, tool.length)
        const candidate =
          NAME_PREFIX +
          server.slice(0, kept.server) +
          SEGMENT_SEPARATOR +
          tool.slice(0, kept.tool) +
          SEGMENT_SEPARATOR +
          digest +
          suffix
        if (!byName.has(candidate)) return register(key, candidate, identity)
      }
    },

    resolve(exposedName: string): McpToolIdentity | undefined {
      const identity = byName.get(exposedName)
      return identity ? { ...identity } : undefined
    },

    entries(): ReadonlyArray<[string, McpToolIdentity]> {
      return [...byName.entries()].map(([name, identity]) => [name, { ...identity }])
    },
  }
}

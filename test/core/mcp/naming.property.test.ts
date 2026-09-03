// Property 30 for MCP exposed-name mangling (task 32.2, design D6).
//
// Injectivity under a length bound is exactly the kind of claim examples cannot establish: a handful
// of hand-picked identities say nothing about the pairs that collide only after truncation. So the
// generators are built to manufacture the hard cases on purpose — labels that share a long prefix
// (so truncation makes the label segments equal), the same tool name on several servers, illegal
// characters that sanitize into the same `_`, and segment texts that already contain `__` so a plain
// candidate can be spelled two ways.
//
// **Validates: Requirements 21.4, 21.5**

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import type { McpToolIdentity } from "../../../src/core/mcp/naming"
import {
  MCP_EXPOSED_NAME_MIN_LENGTH,
  allocateSegmentBudget,
  createMcpToolNameMap,
} from "../../../src/core/mcp/naming"

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Characters a segment may carry, including several the mangler must sanitize to `_`. */
const SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-.:/ @+".split("")

function segmentText(minLength: number, maxLength: number) {
  return fc
    .array(fc.constantFrom(...SEGMENT_CHARS), { minLength, maxLength })
    .map((chars) => chars.join(""))
}

/**
 * A shared prefix long enough that any realistic limit truncates it away, so two labels built from
 * it differ only past the truncation point. This is what forces the digest to carry the distinction.
 */
const LONG_SHARED_PREFIX = "corporate-internal-mcp-server-gateway-"

/** Tool names reused across servers, which Requirement 21.5 says must stay distinct. */
const SHARED_TOOL_NAMES = ["search", "read_file", "list", "a", "very_long_tool_name_for_truncation"]

const serverLabel = fc.oneof(
  segmentText(0, 40),
  segmentText(1, 12).map((tail) => `${LONG_SHARED_PREFIX}${tail}`),
  // Already carries the separator, so a plain candidate is ambiguous with a differently split pair.
  segmentText(1, 8).map((tail) => `${tail}__nested`),
  fc.constantFrom("srv", "srv_a", "srv__a", "同名", ""),
)

const serverUrl = fc.oneof(
  fc.constantFrom(
    "https://mcp.example.com/sse",
    "https://mcp.example.com/sse?v=2",
    "http://localhost:9000/mcp",
  ),
  segmentText(1, 10).map((host) => `https://${host}.example.com/mcp`),
)

const toolName = fc.oneof(
  segmentText(0, 40),
  fc.constantFrom(...SHARED_TOOL_NAMES),
  segmentText(1, 10).map((tail) => `${LONG_SHARED_PREFIX}${tail}`),
)

const identity: fc.Arbitrary<McpToolIdentity> = fc.record({ serverLabel, serverUrl, toolName })

/** A non-empty set of identities, deduplicated by canonical key so no input is a repeat. */
const identitySet = fc
  .array(identity, { minLength: 1, maxLength: 12 })
  .map((identities) => dedupe(identities))

function canonicalKey(value: McpToolIdentity): string {
  return `${value.serverUrl}\u0000${value.serverLabel}\u0000${value.toolName}`
}

function dedupe(identities: readonly McpToolIdentity[]): McpToolIdentity[] {
  const seen = new Set<string>()
  const unique: McpToolIdentity[] = []
  for (const value of identities) {
    const key = canonicalKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(value)
  }
  return unique
}

/** Any limit at or above the minimum, including the Kiro ceiling of 64 the caller supplies. */
const maxNameLength = fc.oneof(
  fc.integer({ min: MCP_EXPOSED_NAME_MIN_LENGTH, max: MCP_EXPOSED_NAME_MIN_LENGTH + 6 }),
  fc.integer({ min: MCP_EXPOSED_NAME_MIN_LENGTH, max: 128 }),
  fc.constant(64),
)

const NAME_CHARACTERS = /^[A-Za-z0-9_-]+$/

// ---------------------------------------------------------------------------------------------
// Property 30
// ---------------------------------------------------------------------------------------------

describe("MCP exposed tool names", () => {
  /**
   * All four clauses over the same generated map: bounded, pairwise distinct, reversible to the
   * identity that produced it, and silent on a name it never handed out.
   *
   * **Validates: Requirements 21.4, 21.5**
   */
  test("Feature: native-api-mode, Property 30: exposed MCP tool names are bounded, injective, and reversible", () => {
    fc.assert(
      fc.property(identitySet, maxNameLength, (identities, limit) => {
        const map = createMcpToolNameMap({ maxNameLength: limit })
        const names = identities.map((value) => map.exposedName(value))

        for (const name of names) {
          // Clause 1 — bounded, and still a legal tool name after sanitization.
          expect(name.length).toBeLessThanOrEqual(limit)
          expect(name.length).toBeGreaterThan(0)
          expect(name).toMatch(NAME_CHARACTERS)
        }

        // Clause 2 — pairwise distinct, including two servers exposing the same tool name.
        expect(new Set(names).size).toBe(identities.length)

        // Clause 3 — each name resolves back to its own identity, and the forward direction is
        // idempotent, so a second call cannot mint a second name for the same tool.
        identities.forEach((value, index) => {
          expect(map.resolve(names[index])).toEqual(value)
          expect(map.exposedName(value)).toBe(names[index])
        })

        // The reverse map is exactly the registrations, nothing more.
        expect(map.entries().map(([name]) => name)).toEqual(names)
        expect(map.entries().map(([, value]) => value)).toEqual(identities)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * Clause 4 — an unknown name resolves to nothing, which is the routing rule that lets ordinary
   * client tool calls pass through untouched. Generated against a populated map so the negative arm
   * is tested against real registrations rather than an empty one.
   *
   * **Validates: Requirement 21.5**
   */
  test("Feature: native-api-mode, Property 30: a name the map never exposed resolves to nothing", () => {
    fc.assert(
      fc.property(
        identitySet,
        maxNameLength,
        fc.oneof(segmentText(0, 30), fc.constantFrom("Bash", "Read", "mcp__", "mcp__unknown__tool")),
        (identities, limit, foreignName) => {
          const map = createMcpToolNameMap({ maxNameLength: limit })
          const names = new Set(identities.map((value) => map.exposedName(value)))
          fc.pre(!names.has(foreignName))
          expect(map.resolve(foreignName)).toBeUndefined()
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * The bound is tight, not merely respected: whenever the plain candidate does not fit, the
   * mangled name lands on the limit exactly, so the shortening never wastes characters. Stated as a
   * property over the allocator because that is where the arithmetic lives.
   *
   * **Validates: Requirement 21.4**
   */
  test("Feature: native-api-mode, Property 30: segment shortening spends the whole budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 120 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (budget, serverLength, toolLength) => {
          const kept = allocateSegmentBudget(budget, serverLength, toolLength)
          expect(kept.server).toBeLessThanOrEqual(serverLength)
          expect(kept.tool).toBeLessThanOrEqual(toolLength)
          if (serverLength + toolLength <= budget) {
            expect(kept).toEqual({ server: serverLength, tool: toolLength })
            return
          }
          expect(kept.server + kept.tool).toBe(budget)
          // Neither side collapses while the other could have spared a character.
          if (serverLength > 0) expect(kept.server).toBeGreaterThan(0)
          if (toolLength > 0) expect(kept.tool).toBeGreaterThan(0)
        },
      ),
      { numRuns: 300 },
    )
  })

  /**
   * The name shape and the two hard cases, as examples, so a failure in the property above can be
   * read against a concrete expectation.
   */
  test("plain names use mcp__<serverLabel>__<toolName> and same-named tools stay distinct", () => {
    const map = createMcpToolNameMap({ maxNameLength: 64 })
    const first = map.exposedName({
      serverLabel: "deepwiki",
      serverUrl: "https://a.example/mcp",
      toolName: "ask question",
    })
    const second = map.exposedName({
      serverLabel: "other",
      serverUrl: "https://b.example/mcp",
      toolName: "ask question",
    })
    expect(first).toBe("mcp__deepwiki__ask_question")
    expect(second).toBe("mcp__other__ask_question")

    // Same label on two different URLs: the label segment cannot separate them, the digest does.
    const url1 = map.exposedName({ serverLabel: "dup", serverUrl: "https://one/mcp", toolName: "t" })
    const url2 = map.exposedName({ serverLabel: "dup", serverUrl: "https://two/mcp", toolName: "t" })
    expect(url1).toBe("mcp__dup__t")
    expect(url2).not.toBe(url1)
    expect(url2.length).toBeLessThanOrEqual(64)
    expect(map.resolve(url2)?.serverUrl).toBe("https://two/mcp")
  })

  test("a limit below the minimum is rejected rather than silently widened", () => {
    expect(() => createMcpToolNameMap({ maxNameLength: MCP_EXPOSED_NAME_MIN_LENGTH - 1 })).toThrow(RangeError)
    expect(() => createMcpToolNameMap({ maxNameLength: MCP_EXPOSED_NAME_MIN_LENGTH })).not.toThrow()
  })
})

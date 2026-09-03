import { describe, expect, test } from "bun:test"

import { claudeSamplingMembers } from "../../src/inbound/claude/sampling"
import type { ClaudeMessagesRequest } from "../../src/inbound/types"

function body(overrides: Partial<ClaudeMessagesRequest> = {}): ClaudeMessagesRequest {
  return {
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

describe("claudeSamplingMembers — sampling", () => {
  test("maps max_tokens, temperature, top_p, and stop_sequences", () => {
    const members = claudeSamplingMembers(
      body({ max_tokens: 512, temperature: 0.2, top_p: 0.9, stop_sequences: ["STOP", "HALT"] }),
    )
    expect(members.sampling).toEqual({
      maxOutputTokens: 512,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["STOP", "HALT"],
    })
  })

  test("omits the sampling member entirely when no sampling field is present", () => {
    const members = claudeSamplingMembers(body())
    expect("sampling" in members).toBe(false)
  })

  test("carries only the sub-members that were sent, with none holding undefined", () => {
    const members = claudeSamplingMembers(body({ temperature: 0.7 }))
    expect(members.sampling).toEqual({ temperature: 0.7 })
    expect(Object.keys(members.sampling ?? {})).toEqual(["temperature"])
  })

  test("keeps zero-valued controls, which truthiness would drop", () => {
    const members = claudeSamplingMembers(body({ temperature: 0, top_p: 0 }))
    expect(members.sampling).toEqual({ temperature: 0, topP: 0 })
  })

  test("omits stopSequences when the array carries nothing usable", () => {
    expect(claudeSamplingMembers(body({ stop_sequences: [] })).sampling).toBeUndefined()
    expect(claudeSamplingMembers(body({ stop_sequences: [""] })).sampling).toBeUndefined()
  })

  test("ignores non-finite numbers rather than carrying them", () => {
    expect(claudeSamplingMembers(body({ temperature: Number.NaN })).sampling).toBeUndefined()
  })
})

describe("claudeSamplingMembers — thinking", () => {
  test("maps thinking.type to mode and budget_tokens to budgetTokens", () => {
    const members = claudeSamplingMembers(body({ thinking: { type: "enabled", budget_tokens: 4096 } }))
    expect(members.thinking).toEqual({ mode: "enabled", budgetTokens: 4096 })
  })

  test("maps disabled and adaptive modes without a budget", () => {
    expect(claudeSamplingMembers(body({ thinking: { type: "disabled" } })).thinking).toEqual({ mode: "disabled" })
    expect(claudeSamplingMembers(body({ thinking: { type: "adaptive" } })).thinking).toEqual({ mode: "adaptive" })
  })

  test("infers enabled when only a budget was sent, keeping the budget", () => {
    expect(claudeSamplingMembers(body({ thinking: { budget_tokens: 2048 } })).thinking).toEqual({
      mode: "enabled",
      budgetTokens: 2048,
    })
  })

  test("omits the member for an unrecognized type with no budget rather than guessing a mode", () => {
    expect("thinking" in claudeSamplingMembers(body({ thinking: { type: "turbo" } }))).toBe(false)
    expect("thinking" in claudeSamplingMembers(body({ thinking: {} }))).toBe(false)
    expect("thinking" in claudeSamplingMembers(body())).toBe(false)
  })
})

describe("claudeSamplingMembers — cacheHint", () => {
  test("derives the scope from where the marker was found", () => {
    const members = claudeSamplingMembers(
      body({
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        tools: [{ name: "save", input_schema: {}, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        ],
      }),
    )
    expect(members.cacheHint).toEqual([{ scope: "tools", ttl: "1h" }, { scope: "system" }, { scope: "history" }])
  })

  test("omits the member entirely when nothing was marked", () => {
    expect("cacheHint" in claudeSamplingMembers(body({ system: "plain system prompt" }))).toBe(false)
    expect(
      "cacheHint" in claudeSamplingMembers(body({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })),
    ).toBe(false)
  })

  test("keeps ttl as the client-supplied string and omits it when absent", () => {
    const members = claudeSamplingMembers(
      body({ system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "5m" } }] }),
    )
    expect(members.cacheHint).toEqual([{ scope: "system", ttl: "5m" }])
    expect(Object.keys(members.cacheHint?.[0] ?? {})).toEqual(["scope", "ttl"])
  })
})

describe("claudeSamplingMembers — parallelToolCalls", () => {
  test("inverts disable_parallel_tool_use: true into parallelToolCalls: false", () => {
    const members = claudeSamplingMembers(body({ tool_choice: { type: "auto", disable_parallel_tool_use: true } }))
    expect(members.parallelToolCalls).toBe(false)
  })

  test("inverts an explicit false into true", () => {
    const members = claudeSamplingMembers(body({ tool_choice: { type: "auto", disable_parallel_tool_use: false } }))
    expect(members.parallelToolCalls).toBe(true)
  })

  test("omits the member when the client expressed no preference", () => {
    expect("parallelToolCalls" in claudeSamplingMembers(body({ tool_choice: { type: "auto" } }))).toBe(false)
    expect("parallelToolCalls" in claudeSamplingMembers(body())).toBe(false)
  })

  test("a toolset can narrow to false but never widen to true", () => {
    const disabled = claudeSamplingMembers(
      body({ tools: [{ type: "mcp_toolset", mcp_server_name: "fs", disable_parallel_tool_use: true }] }),
    )
    expect(disabled.parallelToolCalls).toBe(false)

    const permitted = claudeSamplingMembers(
      body({ tools: [{ type: "mcp_toolset", mcp_server_name: "fs", disable_parallel_tool_use: false }] }),
    )
    expect("parallelToolCalls" in permitted).toBe(false)
  })

  test("the request-level field wins over a toolset", () => {
    const members = claudeSamplingMembers(
      body({
        tool_choice: { type: "auto", disable_parallel_tool_use: false },
        tools: [{ type: "mcp_toolset", mcp_server_name: "fs", disable_parallel_tool_use: true }],
      }),
    )
    expect(members.parallelToolCalls).toBe(true)
  })
})

describe("claudeSamplingMembers — omit-when-absent as a whole", () => {
  test("a request carrying none of the four sources produces no members at all", () => {
    expect(claudeSamplingMembers(body())).toEqual({})
  })
})

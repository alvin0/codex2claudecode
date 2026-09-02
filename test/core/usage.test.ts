import { describe, expect, test } from "bun:test"

import type { Canonical_Usage } from "../../src/core/canonical"
import { canonicalInputTokenTotal, canonicalUsageFromWireUsage, mergeCanonicalUsage } from "../../src/core/usage"

describe("canonical usage helpers", () => {
  test("maps OpenAI Responses cached and reasoning token details", () => {
    const usage = canonicalUsageFromWireUsage({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 2 },
    })

    expect(usage).toEqual({
      inputTokens: 6,
      cacheReadInputTokens: 4,
      outputTokens: 3,
      outputReasoningTokens: 2,
    })
    expect(canonicalInputTokenTotal(usage)).toBe(10)
  })

  test("maps Chat/Completions cached and reasoning token details", () => {
    const usage = canonicalUsageFromWireUsage({
      prompt_tokens: 12,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens: 7,
      completion_tokens_details: { reasoning_tokens: 3 },
    })

    expect(usage).toEqual({
      inputTokens: 7,
      cacheReadInputTokens: 5,
      outputTokens: 7,
      outputReasoningTokens: 3,
    })
    expect(canonicalInputTokenTotal(usage)).toBe(12)
  })

  test("keeps Anthropic-style split input tokens separate", () => {
    const usage = canonicalUsageFromWireUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      output_tokens: 7,
    })

    expect(usage).toEqual({
      inputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      outputTokens: 7,
    })
    expect(canonicalInputTokenTotal(usage)).toBe(10)
  })

  test("maps Anthropic nested cache creation and server tool usage details", () => {
    const usage = canonicalUsageFromWireUsage({
      input_tokens: 2,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 4,
      },
      cache_read_input_tokens: 5,
      output_tokens: 7,
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 2,
        mcp_calls: 3,
      },
    })

    expect(usage).toEqual({
      inputTokens: 2,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 5,
      outputTokens: 7,
      serverToolUse: {
        webSearchRequests: 1,
        webFetchRequests: 2,
        mcpCalls: 3,
      },
    })
    expect(canonicalInputTokenTotal(usage)).toBe(14)
  })

  test("accepts camelCase usage fields from gateway internals", () => {
    expect(canonicalUsageFromWireUsage({
      inputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 5,
      outputReasoningTokens: 1,
    })).toEqual({
      inputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 5,
      outputReasoningTokens: 1,
    })
  })

  test("merges server tool usage cumulatively without decreasing existing counts", () => {
    const usage: Canonical_Usage = {
      inputTokens: 1,
      outputTokens: 2,
      serverToolUse: { webSearchRequests: 3, webFetchRequests: 1 },
    }

    mergeCanonicalUsage(usage, {
      outputTokens: 4,
      serverToolUse: { webSearchRequests: 1, mcpCalls: 2 },
    })

    expect(usage).toEqual({
      inputTokens: 1,
      outputTokens: 4,
      serverToolUse: {
        webSearchRequests: 3,
        webFetchRequests: 1,
        mcpCalls: 2,
      },
    })
  })
})

describe("provider credits in canonical usage", () => {
  test("sums provider credits across merges because one request can make several upstream calls", () => {
    const usage: Canonical_Usage = { inputTokens: 10, outputTokens: 2, providerCredits: 0.0148 }

    mergeCanonicalUsage(usage, { providerCredits: 0.0052 })

    expect(usage.providerCredits).toBeCloseTo(0.02, 10)
  })

  test("takes the incoming value when the target has no credits yet", () => {
    const usage: Canonical_Usage = { inputTokens: 10, outputTokens: 2 }

    mergeCanonicalUsage(usage, { providerCredits: 0.0148 })

    expect(usage.providerCredits).toBe(0.0148)
  })

  test("leaves credits absent rather than zero when neither side reports them", () => {
    const usage: Canonical_Usage = { inputTokens: 10, outputTokens: 2 }

    mergeCanonicalUsage(usage, { inputTokens: 12, outputTokens: 5 })

    expect(usage.providerCredits).toBeUndefined()
    expect("providerCredits" in usage).toBe(false)
  })

  test("keeps an existing credit total when a later merge reports none", () => {
    const usage: Canonical_Usage = { inputTokens: 10, outputTokens: 2, providerCredits: 0.0148 }

    mergeCanonicalUsage(usage, { outputTokens: 9 })

    expect(usage.providerCredits).toBe(0.0148)
  })

  test("accumulates a zero-credit report without discarding it", () => {
    const usage: Canonical_Usage = { inputTokens: 10, outputTokens: 2 }

    mergeCanonicalUsage(usage, { providerCredits: 0 })

    expect(usage.providerCredits).toBe(0)
  })

  test("credits never enter the input token total", () => {
    const usage: Canonical_Usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      providerCredits: 1234.5,
    }

    expect(canonicalInputTokenTotal(usage)).toBe(18)
  })

  test("credits do not perturb any token member when merged", () => {
    const usage: Canonical_Usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      outputReasoningTokens: 1,
    }
    const withoutCredits: Canonical_Usage = { ...usage }

    mergeCanonicalUsage(usage, { providerCredits: 999 })
    const { providerCredits, ...tokenMembers } = usage

    expect(providerCredits).toBe(999)
    expect(tokenMembers).toEqual(withoutCredits)
  })

  test("wire usage readers never invent credits from a token payload", () => {
    expect(canonicalUsageFromWireUsage({ input_tokens: 10, output_tokens: 3 }).providerCredits).toBeUndefined()
    // A wire `usage` object is token accounting; a credit amount arrives on its own frame instead.
    expect(canonicalUsageFromWireUsage({ providerCredits: 0.0148 })).toEqual({})
  })
})

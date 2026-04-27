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

import { describe, expect, test } from "bun:test"

import { welcomeEndpointLines } from "../src/ui/components/welcome-panel"

describe("WelcomePanel endpoint list", () => {
  test("Kiro mode advertises OpenAI-compatible endpoints", () => {
    expect(welcomeEndpointLines("kiro")).toEqual([
      { label: "Claude", value: "/v1/messages" },
      { label: "", value: "/v1/messages/count_tokens" },
      { label: "OpenAI", value: "/v1/responses" },
      { label: "", value: "/v1/chat/completions" },
      { label: "Runtime", value: "/health" },
    ])
  })

  test("Codex mode keeps Chat Completions endpoint", () => {
    expect(welcomeEndpointLines("codex")).toContainEqual({ label: "", value: "/v1/chat/completions" })
  })
})

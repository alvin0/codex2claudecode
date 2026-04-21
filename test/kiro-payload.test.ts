import { describe, expect, test } from "bun:test"

import { buildKiroGenerateAssistantResponsePayload } from "../src/llm-connect/kiro/payload"

describe("Kiro payload", () => {
  test("builds the minimal Kiro payload shape", () => {
    const payload = buildKiroGenerateAssistantResponsePayload({
      content: [{ type: "text", text: "hello" }],
      modelId: "CLAUDE_4_SONNET",
      conversationId: "conversation-1",
      history: [{ role: "assistant", content: "before" }],
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/id",
    })

    expect(payload).toEqual({
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "conversation-1",
        currentMessage: {
          userInputMessage: {
            content: [{ type: "text", text: "hello" }],
            modelId: "CLAUDE_4_SONNET",
            origin: "AI_EDITOR",
          },
        },
        history: [{ role: "assistant", content: "before" }],
      },
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/id",
    })
  })

  test("omits optional fields when not provided", () => {
    const payload = buildKiroGenerateAssistantResponsePayload({
      content: "hi",
      modelId: "MODEL",
      conversationId: "conversation-2",
    })

    expect(payload.profileArn).toBeUndefined()
    expect(payload.conversationState.history).toBeUndefined()
    expect(payload.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR")
  })
})

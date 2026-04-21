import type { KiroGenerateAssistantResponsePayload, KiroMessageInput } from "./types"

export function buildKiroGenerateAssistantResponsePayload(
  input: KiroMessageInput & { profileArn?: string },
): KiroGenerateAssistantResponsePayload {
  const payload: KiroGenerateAssistantResponsePayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: input.conversationId ?? crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: input.content,
          modelId: input.modelId,
          origin: "AI_EDITOR",
        },
      },
    },
  }

  if (input.history?.length) payload.conversationState.history = input.history
  if (input.profileArn) payload.profileArn = input.profileArn

  return payload
}

import type {
  KiroAssistantResponseMessage,
  KiroConversationHistoryEntry,
  KiroGenerateAssistantResponsePayload,
  KiroImage,
  KiroMessageInput,
  KiroToolResult,
  KiroToolSpecification,
  KiroToolUse,
  KiroUserInputMessage,
} from "./types"

export function buildKiroGenerateAssistantResponsePayload(
  input: KiroMessageInput & { profileArn?: string },
): KiroGenerateAssistantResponsePayload {
  const payload: KiroGenerateAssistantResponsePayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: input.conversationId ?? crypto.randomUUID(),
      currentMessage: {
        userInputMessage: input.currentMessage ?? {
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

export function createKiroUserInputMessage(input: {
  content: string
  modelId: string
  images?: KiroImage[]
  tools?: KiroToolSpecification[]
  toolResults?: KiroToolResult[]
}): KiroUserInputMessage {
  return {
    content: input.content,
    modelId: input.modelId,
    origin: "AI_EDITOR",
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.tools?.length || input.toolResults?.length
      ? {
          userInputMessageContext: {
            ...(input.tools?.length ? { tools: input.tools } : {}),
            ...(input.toolResults?.length ? { toolResults: input.toolResults } : {}),
          },
        }
      : {}),
  }
}

export function createKiroAssistantResponseMessage(input: {
  content: string
  toolUses?: KiroToolUse[]
}): KiroAssistantResponseMessage {
  return {
    content: input.content,
    ...(input.toolUses?.length ? { toolUses: input.toolUses } : {}),
  }
}

export function createKiroHistoryEntry(input: {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}): KiroConversationHistoryEntry {
  return {
    ...(input.userInputMessage ? { userInputMessage: input.userInputMessage } : {}),
    ...(input.assistantResponseMessage ? { assistantResponseMessage: input.assistantResponseMessage } : {}),
  }
}


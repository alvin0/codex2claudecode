export const CLAUDE_CODE_ENV_CONFIG = {
  lockedEnv: {
    ANTHROPIC_AUTH_TOKEN: "codex2claudecode",
    ANTHROPIC_API_KEY: "codex2claudecode",
  },
  editableEnvDefaults: {
    ANTHROPIC_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.4",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.4-mini",
  },
  defaultExtraEnv: {
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  },
  defaultUnsetEnv: [],
} as const

export type ClaudeCodeEditableEnvKey = keyof typeof CLAUDE_CODE_ENV_CONFIG.editableEnvDefaults
export type ClaudeCodeLockedEnvKey = keyof typeof CLAUDE_CODE_ENV_CONFIG.lockedEnv

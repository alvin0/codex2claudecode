export type ExportEnvClaudeCodeConfig = {
    codex: ExportEnvClaudeProviderConfig;
    kiro: ExportEnvClaudeProviderConfig;
};

export type ExportEnvClaudeProviderConfig = {
    canEdit: {
        ANTHROPIC_MODEL: string;
        ANTHROPIC_DEFAULT_OPUS_MODEL: string;
        ANTHROPIC_DEFAULT_SONNET_MODEL: string;
        ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
        CLAUDE_CODE_DISABLE_1M_CONTEXT: string;
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: string
    };
    static: {
        NODE_TLS_REJECT_UNAUTHORIZED: string;
        ANTHROPIC_AUTH_TOKEN: string;
        ANTHROPIC_API_KEY: string;
        ANTHROPIC_BASE_URL: string;
    };
};

export const config: ExportEnvClaudeCodeConfig = {
    codex: {
        canEdit: {
            ANTHROPIC_MODEL: "gpt-5.5",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.5",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.4",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.4-mini",
            CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "64"
        },
        static: {
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            ANTHROPIC_AUTH_TOKEN: "codex2claudecode",
            ANTHROPIC_API_KEY: "codex2claudecode",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        },
    },
    kiro: {
        canEdit: {
            ANTHROPIC_MODEL: "claude-opus-4.7",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.7",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4.6",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5",
            CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "64"
        },
        static: {
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            ANTHROPIC_AUTH_TOKEN: "codex2claudecode",
            ANTHROPIC_API_KEY: "codex2claudecode",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        }
    },
};

export type ExportEnvClaudeCodeConfig = {
    codex: {
        canEdit: {
            ANTHROPIC_MODEL: string;
            ANTHROPIC_DEFAULT_OPUS_MODEL: string;
            ANTHROPIC_DEFAULT_SONNET_MODEL: string;
            ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
            CLAUDE_CODE_DISABLE_1M_CONTEXT: string;
        };
        static: {
            NODE_TLS_REJECT_UNAUTHORIZED: string;
            ANTHROPIC_AUTH_TOKEN: string;
            ANTHROPIC_API_KEY: string;
            ANTHROPIC_BASE_URL: string;
        };
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
        },
        static: {
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            ANTHROPIC_AUTH_TOKEN: "codex2claudecode",
            ANTHROPIC_API_KEY: "codex2claudecode",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        }
    },
};

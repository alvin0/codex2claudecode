export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const DEFAULT_ISSUER = "https://auth.openai.com"
export const DEFAULT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const WHAM_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
export const WHAM_ENVIRONMENTS_ENDPOINT = "https://chatgpt.com/backend-api/wham/environments"
export const REFRESH_SAFETY_MARGIN_MS = 30_000
export const LOG_BODY_PREVIEW_LIMIT = 4000

/** Maximum time (ms) to wait for the next SSE chunk from upstream before aborting. */
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 5 * 60_000)

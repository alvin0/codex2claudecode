export const KIRO_AUTH_TOKEN_PATH = "~/.aws/sso/cache/kiro-auth-token.json"
export const KIRO_DESKTOP_REFRESH_TEMPLATE = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken"
export const SSO_OIDC_ENDPOINT_TEMPLATE = "https://oidc.{region}.amazonaws.com/token"

export const KIRO_API_HOST_TEMPLATE = "https://q.{region}.amazonaws.com"
export const DEFAULT_KIRO_API_REGION = "us-east-1"
export const GENERATE_ASSISTANT_RESPONSE_PATH = "/generateAssistantResponse"
export const LIST_AVAILABLE_MODELS_PATH = "/ListAvailableModels"
export const GET_USAGE_LIMITS_PATH = "/getUsageLimits"

export const TOKEN_REFRESH_THRESHOLD_SECONDS = 600
export const STREAMING_READ_TIMEOUT_MS = 300_000
export const KIRO_FIRST_TOKEN_TIMEOUT_MS = 2_000
export const KIRO_FIRST_TOKEN_MAX_RETRIES = 1
export const MAX_RETRIES = 3
export const BASE_RETRY_DELAY_MS = 1000
export const PAYLOAD_SIZE_LIMIT_BYTES = 1_200_000
export const TOOL_DESCRIPTION_MAX_LENGTH = 10_000
export const TOOL_NAME_MAX_LENGTH = 64
export const MODEL_CACHE_TTL_SECONDS = 3600
export const DEFAULT_MAX_INPUT_TOKENS = 200_000

export function kiroPayloadSizeLimitBytes(env: Record<string, string | undefined> = process.env) {
  const bytes = parsePositiveInteger(env.KIRO_PAYLOAD_SIZE_LIMIT_BYTES)
  if (bytes) return bytes

  const megabytes = parsePositiveNumber(env.KIRO_MAX_PAYLOAD_SIZE_MB)
  if (megabytes) return Math.floor(megabytes * 1_000_000)

  return PAYLOAD_SIZE_LIMIT_BYTES
}

export function kiroFirstTokenTimeoutMs(env: Record<string, string | undefined> = process.env) {
  return parsePositiveInteger(env.KIRO_FIRST_TOKEN_TIMEOUT_MS) ?? KIRO_FIRST_TOKEN_TIMEOUT_MS
}

export function kiroFirstTokenMaxRetries(env: Record<string, string | undefined> = process.env) {
  return parsePositiveInteger(env.KIRO_FIRST_TOKEN_MAX_RETRIES) ?? KIRO_FIRST_TOKEN_MAX_RETRIES
}

function parsePositiveInteger(value: string | undefined) {
  if (!value) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parsePositiveNumber(value: string | undefined) {
  if (!value) return
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export const REASONING_EFFORT_BUDGETS: Record<string, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
}

export const USER_AGENT_TEMPLATE = "aws-sdk-js/1.0.27 ua/2.1 os/{platform}#{version} lang/js md/nodejs#{nodeVersion} api/codewhispererstreaming#1.0.27 m/E KiroIDE-{kiroVersion}-{fingerprint}"
export const X_AMZ_USER_AGENT_TEMPLATE = "aws-sdk-js/1.0.27 KiroIDE-{kiroVersion}-{fingerprint}"
export const KIRO_STATE_FILE_NAME = "kiro-state.json"

// Fallback models used only when Kiro's ListAvailableModels endpoint fails.
// The normal model path fetches the upstream list and caches it to avoid stale
// hardcoded availability.
export const HIDDEN_KIRO_MODELS = [
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-3.7-sonnet",
  "claude-opus-4.1",
]

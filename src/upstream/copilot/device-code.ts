import { connectCopilotAccountFromGitHubToken } from "./account-store"
import { getCopilotDeviceCode, pollCopilotDeviceToken, type CopilotDeviceCodeResponse, type CopilotDeviceTokenResponse } from "./auth"

export interface ConnectCopilotDeviceCodeOptions {
  fetch?: typeof fetch
  report?: (message: string) => void
  onDeviceCode?: (deviceCode: CopilotDeviceCodeResponse) => void
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_DEVICE_CODE_INTERVAL_SECONDS = 5
const MAX_DEVICE_CODE_INTERVAL_SECONDS = 60

export async function connectCopilotAccountFromDeviceCode(authFile: string, options: ConnectCopilotDeviceCodeOptions = {}) {
  options.report?.("Requesting GitHub device code...")
  const deviceCode = await getCopilotDeviceCode({ fetch: options.fetch })
  options.onDeviceCode?.(deviceCode)
  options.report?.(`Open ${deviceCode.verification_uri} and enter code ${deviceCode.user_code}`)

  const githubToken = await waitForCopilotDeviceToken(deviceCode, options)
  options.report?.("Device code approved. Loading Copilot account...")

  return connectCopilotAccountFromGitHubToken(authFile, githubToken, {
    fetch: options.fetch,
    authType: "device_code",
  })
}

async function waitForCopilotDeviceToken(deviceCode: CopilotDeviceCodeResponse, options: ConnectCopilotDeviceCodeOptions) {
  let intervalSeconds = normalizeInterval(deviceCode.interval, DEFAULT_DEVICE_CODE_INTERVAL_SECONDS)
  const expiresAt = Date.now() + normalizeInterval(deviceCode.expires_in, 15 * 60) * 1000

  while (true) {
    if (Date.now() >= expiresAt) throw new Error("Copilot device code expired")

    const tokenJson = await pollCopilotDeviceToken(deviceCode.device_code, { fetch: options.fetch })
    if (isDeviceTokenSuccess(tokenJson)) {
      if (!tokenJson.access_token) throw new Error("Copilot device code returned an empty access token")
      return tokenJson.access_token
    }

    if (tokenJson.error === "authorization_pending") {
      options.report?.("Waiting for GitHub approval...")
      await sleep(intervalSeconds, options.sleep)
      continue
    }

    if (tokenJson.error === "slow_down") {
      const serverInterval = normalizeInterval(tokenJson.interval, intervalSeconds + 5)
      intervalSeconds = Math.min(MAX_DEVICE_CODE_INTERVAL_SECONDS, Math.max(intervalSeconds + 1, serverInterval))
      options.report?.("GitHub asked to slow down. Retrying...")
      await sleep(intervalSeconds, options.sleep)
      continue
    }

    if (tokenJson.error === "access_denied") throw new Error("Copilot device code was denied")
    if (tokenJson.error === "expired_token") throw new Error("Copilot device code expired")

    throw new Error(tokenJson.error_description ?? tokenJson.error_uri ?? `Copilot device flow failed: ${tokenJson.error}`)
  }
}

async function sleep(seconds: number, sleepFn: ConnectCopilotDeviceCodeOptions["sleep"]) {
  const delay = Math.max(1, Math.floor(seconds)) * 1000
  if (sleepFn) return sleepFn(delay)
  return new Promise<void>((resolve) => setTimeout(resolve, delay))
}

function normalizeInterval(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback
}

function isDeviceTokenSuccess(value: CopilotDeviceTokenResponse): value is Extract<CopilotDeviceTokenResponse, { access_token: string }> {
  return "access_token" in value
}

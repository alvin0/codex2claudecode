import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { resolveKiroAuthFile } from "../../paths"
import type { KiroCredentialLoadOptions, KiroCredentialSnapshot } from "./types"

export const DEFAULT_KIRO_REGION = "us-east-1"

export async function resolveKiroCredsFile(input = process.env.KIRO_CREDS_FILE) {
  const resolved = resolveKiroAuthFile(input)
  return (await pathExists(resolved)) ? resolved : undefined
}

export async function loadKiroCredentials(options: KiroCredentialLoadOptions = {}) {
  const shouldAutoResolve = !hasInlineCredentialOptions(options) && !options.credsFile
  const credsFile = options.credsFile ? resolveKiroAuthFile(options.credsFile) : shouldAutoResolve ? await resolveKiroCredsFile() : undefined

  const json = credsFile ? await readCredentialsFile(credsFile) : undefined

  const snapshot: KiroCredentialSnapshot = {
    ...json,
    refreshToken: options.refreshToken ?? json?.refreshToken,
    accessToken: options.accessToken ?? json?.accessToken,
    expiresAt: options.expiresAt ?? json?.expiresAt,
    profileArn: options.profileArn ?? json?.profileArn,
    clientId: options.clientId ?? json?.clientId,
    clientSecret: options.clientSecret ?? json?.clientSecret,
    clientIdHash: options.clientIdHash ?? json?.clientIdHash,
    ssoRegion: options.region ?? json?.ssoRegion,
    detectedApiRegion: options.region ?? json?.detectedApiRegion,
    source: options.refreshToken || options.accessToken ? "inline" : json?.source,
  }

  return { snapshot, credsFile }
}

export async function readCredentialsFile(filePath: string): Promise<KiroCredentialSnapshot> {
  const resolved = resolveKiroAuthFile(filePath)
  const data = JSON.parse(await readFile(resolved, "utf8")) as Record<string, unknown>
  const device = typeof data.clientIdHash === "string" ? await readEnterpriseDeviceRegistration(data.clientIdHash) : undefined

  return {
    refreshToken: stringValue(data.refreshToken),
    accessToken: stringValue(data.accessToken),
    profileArn: stringValue(data.profileArn),
    clientIdHash: stringValue(data.clientIdHash),
    clientId: stringValue(data.clientId) ?? device?.clientId,
    clientSecret: stringValue(data.clientSecret) ?? device?.clientSecret,
    ssoRegion: stringValue(data.region),
    detectedApiRegion: stringValue(data.region),
    expiresAt: parseExpiresAt(data.expiresAt),
    source: "json",
  }
}

export async function readEnterpriseDeviceRegistration(clientIdHash: string) {
  const devicePath = path.join(homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`)
  if (!(await pathExists(devicePath))) return undefined
  const data = JSON.parse(await readFile(devicePath, "utf8")) as Record<string, unknown>
  return {
    clientId: stringValue(data.clientId),
    clientSecret: stringValue(data.clientSecret),
  }
}

export function extractRegionFromArn(value?: string) {
  if (!value) return undefined
  const region = value.split(":")[3]
  return /^[a-z]+-[a-z]+-\d+$/.test(region ?? "") ? region : undefined
}

export function parseExpiresAt(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value !== "string" || !value) return undefined
  const normalized = value.replace(/Z$/, "+00:00").replace(/(\.\d{6})\d+/, "$1")
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined
}

function hasInlineCredentialOptions(options: KiroCredentialLoadOptions) {
  return Boolean(
    options.refreshToken ||
      options.accessToken ||
      options.expiresAt ||
      options.profileArn ||
      options.clientId ||
      options.clientSecret ||
      options.clientIdHash,
  )
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

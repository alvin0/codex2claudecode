import { pathExists } from "../../core/bun-fs"
import type { Upstream_Provider } from "../../core/interfaces"
import { appDataDir, expandHome } from "../../core/paths"
import { bunPath as path } from "../../core/paths"
import {
  connectKiroAccount,
  connectKiroAccountFromKiroAuth,
  connectKiroAccountsFromKiroAuth,
  kiroAccountKey,
  kiroAuthEntries,
  readKiroAuthFileData,
  selectKiroAuthEntry,
  writeActiveKiroAccount,
  type ConnectKiroAccountDraft,
} from "../../upstream/kiro/account-store"
import { KIRO_AUTH_TOKEN_CLI_PATH, KIRO_AUTH_TOKEN_PATH, KIRO_STATE_FILE_NAME } from "../../upstream/kiro/constants"
import { existingKiroSourceAuthFiles, resolveKiroSourceAuthFile } from "../../upstream/kiro/auth-source"
import { Kiro_Upstream_Provider } from "../../upstream/kiro"
import type { KiroAuthFileData, KiroAuthTokenFile } from "../../upstream/kiro/types"
import { kiroUsageLimitsToView, type LimitGroupView } from "../limits"
import type { UiProviderDefinition } from "./types"

export const kiroProviderDefinition: UiProviderDefinition = {
  mode: "kiro",
  label: "Kiro",
  authFile: () => path.join(appDataDir(), KIRO_STATE_FILE_NAME),
  bootstrapOptions: (context) => ({
    providerMode: "kiro",
    authFile: context.authFile,
    authAccount: context.accountKey,
  }),
  runtimeSignature: (context) => `kiro:${context.authFile}:${context.accountKey ?? ""}:${context.authRevision}`,
  validate: async () => {
    await Kiro_Upstream_Provider.fromAuthFile(await resolveKiroRuntimeAuthFile())
  },
  validationError: (error) => `Kiro auth token file not found or invalid. Please log in to Kiro IDE first. (${errorMessage(error)})`,
  accounts: {
    selectorTitle: "Select Kiro account",
    selectorDescription: "Switch between managed Kiro accounts. Applies to this session and future requests.",
    loadState: loadKiroAccountState,
    toAccounts: (data) => kiroAuthDataToAccounts(data as KiroAuthFileData),
    persistActive: (authFile, data, accountKey) => writeActiveKiroAccount(authFile, data as KiroAuthFileData, accountKey),
    connect: {
      title: "Connect Kiro account",
      sources: [
        {
          label: "Add from Kiro IDE auth",
          description: "Import tokens from ~/.aws/sso/cache/kiro-auth-token.json",
          savingMessage: "Importing from Kiro IDE auth...",
          import: async (authFile) => {
            const source = process.env.KIRO_AUTH_FILE
              ? expandHome(process.env.KIRO_AUTH_FILE)
              : expandHome(KIRO_AUTH_TOKEN_PATH)
            const result = await connectKiroAccountFromKiroAuth(authFile, source)
            return { accountKey: result.accountKey, data: result.data }
          },
        },
        {
          label: "Add from Kiro CLI auth",
          description: "Import tokens from ~/.aws/sso/cache/kiro-auth-token-cli.json",
          savingMessage: "Importing from Kiro CLI auth...",
          import: async (authFile) => {
            const source = process.env.KIRO_AUTH_FILE
              ? expandHome(process.env.KIRO_AUTH_FILE)
              : expandHome(KIRO_AUTH_TOKEN_CLI_PATH)
            const result = await connectKiroAccountFromKiroAuth(authFile, source)
            return { accountKey: result.accountKey, data: result.data }
          },
        },
      ],
      manualDescription: "Paste Kiro account credentials. Tokens are hidden while typing.",
      fields: [
        { key: "label", label: "label", optional: true },
        { key: "accessToken", label: "accessToken", secret: true },
        { key: "refreshToken", label: "refreshToken", secret: true },
        { key: "region", label: "region" },
        { key: "profileArn", label: "profileArn", optional: true },
      ],
      defaultDraft: () => ({ label: "", accessToken: "", refreshToken: "", region: "us-east-1", profileArn: "" }),
      connectManual: async (authFile, draft) => {
        const result = await connectKiroAccount(authFile, draft as unknown as ConnectKiroAccountDraft)
        return { accountKey: result.accountKey, data: result.data }
      },
    },
  },
}

export async function refreshKiroLimits(upstream: Upstream_Provider): Promise<{ limitGroups: LimitGroupView[]; tier?: string; email?: string } | undefined> {
  if (!upstream.usage) return
  const response = await upstream.usage()
  if (!response.ok) throw new Error(`Kiro API ${response.status}`)

  const view = kiroUsageLimitsToView(await response.json())
  return {
    limitGroups: view.limitGroups,
    ...(view.tier ? { tier: view.tier } : {}),
    ...(view.email ? { email: view.email } : {}),
  }
}

export async function loadKiroAccountState(authFile: string): Promise<{ data: KiroAuthFileData; selected: number }> {
  const data = await readKiroAuthFileData(authFile).catch(async () => readKiroAuthFileData(await resolveKiroSourceAuthFile()))
  return {
    data,
    selected: selectedKiroAccountIndex(data, process.env.KIRO_AUTH_ACCOUNT),
  }
}

async function resolveKiroRuntimeAuthFile(authFile = path.join(appDataDir(), KIRO_STATE_FILE_NAME)) {
  if (await pathExists(authFile)) {
    return authFile
  }
  return resolveKiroSourceAuthFile()
}

function selectedKiroAccountIndex(data: KiroAuthFileData, account?: string) {
  try {
    return selectKiroAuthEntry(data, account).index
  } catch {
    return 0
  }
}

function kiroAuthDataToAccounts(data: KiroAuthFileData) {
  return kiroAuthEntries(data).map((auth, index) => kiroAuthToAccount(auth, index))
}

function kiroAuthToAccount(auth: KiroAuthTokenFile, index: number) {
  const name = firstString(auth.label, auth.name, auth.email, auth.profileArn, auth.accountId) ?? `Kiro ${index + 1}`
  return {
    key: kiroAccountKey(auth, index),
    name,
    email: auth.email,
    accountId: auth.accountId,
    detail: [
      auth.region,
      auth.profileArn ? shortenArn(auth.profileArn) : undefined,
    ].filter(Boolean).join(" · "),
  }
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function shortenArn(value: string) {
  return value.length > 36 ? `${value.slice(0, 18)}...${value.slice(-12)}` : value
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

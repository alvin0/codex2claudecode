import { appDataDir } from "../../core/paths"
import { bunPath as path } from "../../core/paths"
import type { Upstream_Provider } from "../../core/interfaces"
import { COPILOT_AUTH_FILE_NAME } from "../../upstream/copilot/constants"
import { connectCopilotAccount, copilotAuthEntries, ensureCopilotAuthFile, readCopilotAuthFileData, selectCopilotAuthEntry, writeActiveCopilotAccount, type ConnectCopilotAccountDraft } from "../../upstream/copilot/account-store"
import type { CopilotAuthFileData, CopilotAuthTokenFile } from "../../upstream/copilot/types"
import { connectCopilotAccountFromDeviceCode } from "../../upstream/copilot/device-code"
import { copilotUsageToView, type LimitGroupView } from "../limits"
import type { UiProviderDefinition } from "./types"

export const copilotProviderDefinition: UiProviderDefinition = {
  mode: "copilot",
  label: "Copilot",
  authFile: () => path.join(appDataDir(), COPILOT_AUTH_FILE_NAME),
  bootstrapOptions: (context) => ({
    providerMode: "copilot",
    authFile: context.authFile,
    authAccount: context.accountKey,
  }),
  runtimeSignature: (context) => `copilot:${context.authFile}:${context.accountKey ?? ""}:${context.authRevision}:${context.routingRevision}`,
  validate: async () => {
    await ensureCopilotAuthFile()
  },
  validationError: (error) => `Copilot auth file not found or invalid at ${path.join(appDataDir(), COPILOT_AUTH_FILE_NAME)}. (${errorMessage(error)})`,
  accounts: {
    selectorTitle: "Select Copilot account",
    selectorDescription: "Switch between managed Copilot accounts. Applies to this session and future requests.",
    loadState: loadCopilotAccountState,
    toAccounts: (data) => copilotAuthDataToAccounts(data as CopilotAuthFileData),
    persistActive: (authFile, data, accountKey) => writeActiveCopilotAccount(authFile, data as CopilotAuthFileData, accountKey),
    connect: {
      title: "Connect Copilot account",
      sources: [
        {
          label: "Login with device code",
          description: "Open GitHub, approve the device code, and save the connected account locally",
          savingMessage: "Requesting GitHub device code...",
          import: async (authFile, context) => {
            const result = await connectCopilotAccountFromDeviceCode(authFile, {
              report: context?.report,
              onDeviceCode: (deviceCode) => context?.reportProgress?.({
                verificationUri: deviceCode.verification_uri,
                userCode: deviceCode.user_code,
              }),
            })
            return { accountKey: result.accountKey, data: result.data }
          },
        },
      ],
      manualDescription: "Paste a GitHub token with Copilot access. Use device code login above if you do not want to paste a token.",
      fields: [
        { key: "label", label: "label", optional: true },
        { key: "githubToken", label: "githubToken", secret: true },
        { key: "accountType", label: "accountType", optional: true },
      ],
      defaultDraft: () => ({ label: "", githubToken: "", accountType: "individual" }),
      connectManual: async (authFile, draft) => {
        const result = await connectCopilotAccount(authFile, draft as unknown as ConnectCopilotAccountDraft)
        return { accountKey: result.accountKey, data: result.data }
      },
    },
  },
}

export async function refreshCopilotLimits(upstream: Upstream_Provider): Promise<{ accountInfo?: { email?: string; plan?: string; updatedAt: string }; limitGroups: LimitGroupView[] } | undefined> {
  if (!upstream.usage) return
  const response = await upstream.usage()
  if (!response.ok) throw new Error(`Copilot API ${response.status}`)
  const view = copilotUsageToView(await response.json())
  return {
    accountInfo: view.accountInfo ? { ...view.accountInfo, updatedAt: new Date().toISOString() } : undefined,
    limitGroups: view.limitGroups,
  }
}

export async function loadCopilotAccountState(authFile: string): Promise<{ data: CopilotAuthFileData; selected: number }> {
  const resolvedAuthFile = await ensureCopilotAuthFile(authFile)
  const file = await readCopilotAuthFileData(resolvedAuthFile).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("does not contain any accounts")) throw error
    return { activeAccount: undefined, accounts: [] } satisfies CopilotAuthFileData
  })
  const activeAccount = process.env.COPILOT_AUTH_ACCOUNT
  return {
    data: file,
    selected: selectedCopilotAccountIndex(file, activeAccount),
  }
}

function selectedCopilotAccountIndex(data: CopilotAuthFileData, account?: string) {
  try {
    return selectCopilotAuthEntry(data, account).index
  } catch {
    return 0
  }
}

function copilotAuthDataToAccounts(data: CopilotAuthFileData) {
  return copilotAuthEntries(data).map((auth, index) => copilotAuthToAccount(auth, index))
}

function copilotAuthToAccount(auth: CopilotAuthTokenFile, index: number) {
  const name = firstString(auth.label, auth.email, auth.accountId, auth.plan, auth.accountType) ?? `Copilot ${index + 1}`
  return {
    key: auth.accountId ?? auth.email ?? auth.label ?? auth.accountType ?? `copilot-account-${index + 1}`,
    name,
    email: auth.email,
    accountId: auth.accountId,
    plan: auth.plan,
    detail: [auth.accountType, auth.plan].filter(Boolean).join(" · "),
  }
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

import { ensureCodexAuthFile, readAccountInfoFile, refreshActiveAccountInfo, writeAccountInfoFile, writeActiveAccountInfo, type AccountInfo } from "../../upstream/codex/account-info"
import { readAuthFileData } from "../../upstream/codex/auth"
import { CodexStandaloneClient } from "../../upstream/codex/client"
import { connectAccount, connectAccountFromBrowserLogin, connectAccountFromCodexAuth, type ConnectAccountDraft } from "../../upstream/codex/connect-account"
import { resolveAuthFile } from "../../core/paths"
import { providerStatePath } from "../../core/provider-state"
import type { AuthFileData } from "../../upstream/codex/types"
import { authDataToAccounts, selectedAccountIndex } from "../accounts"
import { usageToView, type LimitGroupView } from "../limits"
import type { UiProviderDefinition } from "./types"

export const codexProviderDefinition: UiProviderDefinition = {
  mode: "codex",
  label: "Codex",
  authFile: () => process.env.CODEX_AUTH_FILE ? resolveAuthFile(process.env.CODEX_AUTH_FILE) : providerStatePath(),
  bootstrapOptions: (context) => ({
    providerMode: "codex",
    authFile: context.authFile,
    authAccount: context.accountKey,
  }),
  runtimeSignature: (context) => `codex:${context.authFile}:${context.accountKey ?? ""}:${context.authRevision}:${context.routingRevision}`,
  validate: async () => {
    const authFile = process.env.CODEX_AUTH_FILE ? resolveAuthFile(process.env.CODEX_AUTH_FILE) : providerStatePath()
    await ensureCodexAuthFile(authFile)
  },
  validationError: (error) => `Codex auth file not found at ${process.env.CODEX_AUTH_FILE ? resolveAuthFile(process.env.CODEX_AUTH_FILE) : providerStatePath()}. (${errorMessage(error)})`,
  accounts: {
    selectorTitle: "Select account",
    selectorDescription: "Switch between Codex accounts. Applies to this session and future requests.",
    loadState: loadCodexAccountState,
    toAccounts: (data) => authDataToAccounts(data as AuthFileData),
    persistActive: (authFile, data, accountKey) => persistCodexActiveAccount(authFile, data as AuthFileData, accountKey),
    connect: {
      title: "Connect Codex account",
      sources: [
        {
          label: "Login with browser",
          description: "Sign in to ChatGPT and store the account here only",
          savingMessage: "Opening the ChatGPT sign-in page...",
          import: async (authFile, context) => {
            const result = await connectAccountFromBrowserLogin(authFile, {
              onAuthorizeUrl: (url) => {
                context?.reportProgress?.({ message: "Waiting for the browser sign-in to finish...", verificationUri: url })
                context?.report?.("Waiting for the browser sign-in to finish...")
              },
              openBrowser: openInBrowser,
            })
            return { accountKey: requireAccountKey(result.accountId), data: result.data }
          },
        },
        {
          label: "Add from ~/.codex/auth.json",
          description: "Import ChatGPT tokens from Codex CLI auth file",
          savingMessage: "Importing from ~/.codex/auth.json...",
          import: async (authFile) => {
            const result = await connectAccountFromCodexAuth(authFile)
            return { accountKey: requireAccountKey(result.accountId), data: result.data }
          },
        },
      ],
      manualDescription: "Paste account credentials. Tokens are hidden while typing.",
      fields: [
        { key: "accountId", label: "accountId" },
        { key: "accessToken", label: "accessToken", secret: true },
        { key: "refreshToken", label: "refreshToken", secret: true },
      ],
      defaultDraft: () => ({ accountId: "", accessToken: "", refreshToken: "" }),
      connectManual: async (authFile, draft) => {
        const result = await connectAccount(authFile, draft as unknown as ConnectAccountDraft)
        return { accountKey: requireAccountKey(result.accountId), data: result.data }
      },
    },
  },
}

export async function refreshCodexLimits(authFile: string, accountKey: string): Promise<{ accountInfo: AccountInfo; limitGroups: LimitGroupView[] }> {
  const info = await refreshActiveAccountInfo(authFile, accountKey)
  const client = await CodexStandaloneClient.fromAuthFile(authFile, { authAccount: accountKey })
  const response = await client.usage()
  if (!response.ok) throw new Error(`usage request failed with ${response.status}`)

  const usage = usageToView(await response.json())
  return {
    accountInfo: { ...info, ...usage.accountInfo, updatedAt: usage.accountInfo?.updatedAt ?? info.updatedAt },
    limitGroups: usage.limitGroups,
  }
}

export async function loadCodexAccountState(authFile: string): Promise<{ data: AuthFileData; selected: number }> {
  await ensureCodexAuthFile(authFile)
  const [file, info] = await Promise.all([readAuthFileData(authFile), readAccountInfoFile(authFile)])
  const activeAccount = process.env.CODEX_AUTH_ACCOUNT ?? info?.activeAccount
  void writeAccountInfoFile(authFile, file.data, activeAccount).catch(() => {})
  return {
    data: file.data,
    selected: selectedAccountIndex(file.data, activeAccount),
  }
}

export function persistCodexActiveAccount(authFile: string, data: AuthFileData, accountKey: string) {
  return writeActiveAccountInfo(authFile, data, accountKey)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Best effort: the URL is also printed, so a headless machine can still finish the login. */
function openInBrowser(url: string) {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref()
  } catch {
    // Leave the user with the printed URL.
  }
}

function requireAccountKey(accountKey?: string) {
  if (!accountKey) throw new Error("Connected account is missing an account id")
  return accountKey
}

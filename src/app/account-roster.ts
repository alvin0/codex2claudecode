import type { ProviderMode } from "../core/provider-state"
import { accountInfoKey, readAccountInfoFile, writeActiveAccountInfo } from "../upstream/codex/account-info"
import { readAuthFileData } from "../upstream/codex/auth"
import { copilotAccountKey, copilotAuthEntries, readCopilotAuthFileData, writeActiveCopilotAccount } from "../upstream/copilot/account-store"
import { kiroAccountKey, kiroAuthEntries, readKiroAuthFileData, writeActiveKiroAccount } from "../upstream/kiro/account-store"

export interface AccountRoster {
  /** Account keys in file order. */
  accounts: string[]
  activeAccount?: string
  persistActive: (accountKey: string) => Promise<void>
}

/**
 * The connected accounts for a provider, in the same key space the UI account
 * selector uses, so a rotation is visible there without a runtime restart.
 */
export async function readAccountRoster(mode: ProviderMode, authFile: string): Promise<AccountRoster> {
  if (mode === "kiro") {
    const data = await readKiroAuthFileData(authFile)
    return {
      accounts: kiroAuthEntries(data).map((auth, index) => kiroAccountKey(auth, index)),
      activeAccount: managedActiveAccount(data),
      persistActive: (accountKey) => writeActiveKiroAccount(authFile, data, accountKey),
    }
  }

  if (mode === "copilot") {
    const data = await readCopilotAuthFileData(authFile)
    return {
      accounts: copilotAuthEntries(data).map((auth, index) => copilotAccountKey(auth, index)),
      activeAccount: managedActiveAccount(data),
      persistActive: (accountKey) => writeActiveCopilotAccount(authFile, data, accountKey),
    }
  }

  const file = await readAuthFileData(authFile)
  const entries = Array.isArray(file.data) ? file.data : [file.data]
  const info = await readAccountInfoFile(authFile)
  return {
    accounts: entries.map((auth, index) => accountInfoKey(auth, index)),
    activeAccount: info?.activeAccount,
    persistActive: (accountKey) => writeActiveAccountInfo(authFile, file.data, accountKey),
  }
}

/** Only the managed (multi-account) auth file shape carries an active account. */
function managedActiveAccount(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const active = (data as { activeAccount?: unknown }).activeAccount
  return typeof active === "string" ? active : undefined
}

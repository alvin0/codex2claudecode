import { parseJwtClaims, selectAuthEntry } from "../auth"
import { accountInfoKey } from "../account-info"
import type { AuthFileContent, AuthFileData } from "../types"

import type { AccountView } from "./types"

export function authDataToAccounts(data: AuthFileData): AccountView[] {
  return (Array.isArray(data) ? data : [data]).map((auth, index) => authToAccount(auth, index))
}

export function selectedAccountIndex(data: AuthFileData, account?: string) {
  if (!account) return 0
  try {
    return selectAuthEntry(data, account).index
  } catch {
    return 0
  }
}

function authToAccount(auth: AuthFileContent, index: number): AccountView {
  const profile = tokenProfile(auth.access)
  const name = auth.name ?? auth.label ?? auth.email ?? profile.email ?? auth.accountId ?? `account-${index + 1}`
  return {
    key: accountInfoKey(auth, index),
    name,
    email: auth.email ?? profile.email,
    accountId: auth.accountId,
    plan: profile.plan,
  }
}

function tokenProfile(access: string) {
  const claims = parseJwtClaims(access) as
    | {
        "https://api.openai.com/profile"?: { email?: string }
        "https://api.openai.com/auth"?: { chatgpt_plan_type?: string }
      }
    | undefined
  return {
    email: claims?.["https://api.openai.com/profile"]?.email,
    plan: claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
  }
}

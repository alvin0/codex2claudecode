import type { RuntimeOptions } from "../../core/types"
import type { AccountView, ProviderMode } from "../types"

export interface ProviderRuntimeContext {
  authFile: string
  accountKey?: string
  authRevision: number
  routingRevision: number
}

export type ProviderAccountData = unknown
export type ProviderConnectDraft = Record<string, string>

export interface ProviderConnectField {
  key: string
  label: string
  secret?: boolean
  optional?: boolean
}

export interface ProviderAccountConnectResult {
  accountKey: string
  data: ProviderAccountData
}

export interface ProviderConnectProgress {
  message?: string
  verificationUri?: string
  userCode?: string
}

export interface ProviderConnectSourceImportContext {
  report?: (message: string) => void
  reportProgress?: (progress: ProviderConnectProgress | undefined) => void
}

export interface ProviderConnectSource {
  label: string
  description: string
  savingMessage: string
  import: (authFile: string, context?: ProviderConnectSourceImportContext) => Promise<ProviderAccountConnectResult>
}

export interface ProviderAccountConnectDefinition {
  title: string
  /** Extra import sources shown before the Manual option. */
  sources: ProviderConnectSource[]
  manualDescription: string
  fields: ProviderConnectField[]
  defaultDraft: () => ProviderConnectDraft
  connectManual: (authFile: string, draft: ProviderConnectDraft) => Promise<ProviderAccountConnectResult>
}

export interface ProviderAccountsDefinition {
  selectorTitle: string
  selectorDescription: string
  loadState: (authFile: string) => Promise<{ data: ProviderAccountData; selected: number }>
  toAccounts: (data: ProviderAccountData) => AccountView[]
  persistActive: (authFile: string, data: ProviderAccountData, accountKey: string) => Promise<void>
  connect: ProviderAccountConnectDefinition
}

export interface UiProviderDefinition {
  mode: ProviderMode
  label: string
  authFile: () => string
  bootstrapOptions: (context: ProviderRuntimeContext) => RuntimeOptions & { providerMode: ProviderMode }
  runtimeSignature: (context: ProviderRuntimeContext) => string
  validate: () => Promise<void>
  validationError: (error: unknown) => string
  accounts?: ProviderAccountsDefinition
}

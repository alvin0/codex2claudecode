import type { JsonObject } from "../../core/types"

export interface CopilotAuthTokenFile {
  type: "copilot"
  githubToken: string
  label?: string
  accountId?: string
  email?: string
  plan?: string
  accountType?: string
  authType?: CopilotAuthType
  sourceAuthFile?: string
  sourceAccountKey?: string
}

export type CopilotAuthFileData = CopilotAuthTokenFile | CopilotAuthTokenFile[] | CopilotManagedAuthFile

export interface CopilotManagedAuthFile {
  activeAccount?: string
  accounts: CopilotAuthTokenFile[]
}

export interface CopilotTokenCacheEntry {
  copilotToken: string
  expiresAt: string
  accountType: string
}

export interface CopilotModelCacheEntry {
  models: string[]
  fetchedAt: string
}

export interface CopilotCacheFile {
  tokens: Record<string, CopilotTokenCacheEntry>
  models: Record<string, CopilotModelCacheEntry>
}

export interface CopilotAccountSnapshot {
  copilotToken: string
  copilotTokenExpiresAt: string
  accountType: string
  authType: CopilotAuthType
  email?: string
  plan?: string
  accountId?: string
}

export interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id?: string
  assigned_date?: string
  can_signup_for_limited?: boolean
  chat_enabled?: boolean
  copilot_plan: string
  organization_login_list?: unknown[]
  organization_list?: unknown[]
  quota_reset_date?: string
  quota_reset_date_utc?: string
  quota_snapshots?: {
    chat?: JsonObject
    completions?: JsonObject
    premium_interactions?: JsonObject
  }
  limited_user_quotas?: {
    chat?: number
    completions?: number
  }
  limited_user_reset_date?: string
  monthly_quotas?: {
    chat?: number
    completions?: number
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

export interface CopilotModel {
  id: string
  name?: string
  model_picker_enabled?: boolean
  vendor?: string
  version?: string
  capabilities?: {
    family?: string
    object?: string
    type?: string
    supports?: {
      streaming?: boolean
      tool_calls?: boolean
      parallel_tool_calls?: boolean
    }
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
    }
  }
}

export interface CopilotModelsResponse {
  data?: CopilotModel[]
  object?: string
}

export type CopilotAuthType = "github_token" | "device_code" | "unknown"

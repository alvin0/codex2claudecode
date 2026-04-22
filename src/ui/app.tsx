import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useMemo, useState } from "react"

import { readAccountInfoFile, refreshActiveAccountInfo, writeAccountInfoFile, writeActiveAccountInfo, type AccountInfo } from "../account-info"
import { readAuthFileData } from "../auth"
import { CodexStandaloneClient } from "../client"
import { connectAccount, connectAccountFromCodexAuth, type ConnectAccountDraft } from "../connect-account"
import { connectKiro, connectKiroFromSsoCache, readKiroAuthData, kiroAuthDataToAccounts, selectedKiroAccountIndex, type KiroConnectDraft, type KiroAccountView, type KiroAuthEntry } from "../connect-kiro"
import type { ProviderName } from "../llm-connect/factory"
import { packageInfo } from "../package-info"
import { resolveAuthFile } from "../paths"
import { clearRequestLogs, MAX_REQUEST_LOG_ENTRIES, readRecentRequestLogs } from "../request-logs"
import { readProviderState, writeProviderState } from "../provider-state"
import { startRuntime } from "../runtime"
import type { AuthFileData, RequestLogEntry } from "../types"
import { authDataToAccounts, selectedAccountIndex } from "./accounts"
import {
  claudeSettingsPathForScope,
  claudeSettingsScopeLabel,
  defaultClaudeEnvironment,
  detectShell,
  CLAUDE_MODEL_ENV_KEYS,
  readClaudeEnvironmentConfig,
  runClaudeEnvironmentSet,
  runClaudeEnvironmentUnset,
  writeClaudeEnvironmentConfig,
  type ClaudeSettingsScope,
  type ClaudeEnvironmentDraft,
} from "./claude-env"
import { filterCommands } from "./commands"
import { writeClipboard } from "./clipboard"
import { AccountInfoPanel } from "./components/account-info-panel"
import { AccountSelector } from "./components/account-selector"
import { ClaudeEnvironmentEditor } from "./components/claude-environment-editor"
import { ClaudeEnvironmentScopeSelector } from "./components/claude-environment-scope-selector"
import { ClaudeEnvironmentUnsetConfirm } from "./components/claude-environment-unset-confirm"
import { CommandInput } from "./components/command-input"
import { CommandOutput } from "./components/command-output"
import { ConnectAccountWizard } from "./components/connect-account-wizard"
import { ConnectKiroWizard, updateKiroConnectDraft } from "./components/connect-kiro-wizard"
import { ConnectKiroSourceSelector, KIRO_CONNECT_SOURCES } from "./components/connect-kiro-source-selector"
import { KiroAccountSelector } from "./components/kiro-account-selector"
import { ConnectSourceSelector } from "./components/connect-source-selector"
import { LimitsPanel } from "./components/limits-panel"
import { ProviderSelector, PROVIDERS } from "./components/provider-selector"
import { formatAllRequestLogs, formatRequestLogDetail, RequestLogsPanel } from "./components/request-logs-panel"
import { WelcomePanel } from "./components/welcome-panel"
import { usageToView, kiroUsageToView, type LimitGroupView } from "./limits"
import type { RuntimeState } from "./types"

export function CodexCodeApp(props: { port?: number; provider?: ProviderName }) {
  const app = useApp()
  const authFile = resolveAuthFile(process.env.CODEX_AUTH_FILE)
  const hostname = process.env.HOST ?? "127.0.0.1"
  const port = props.port ?? Number(process.env.PORT || 8787)
  const [activeProvider, setActiveProvider] = useState<ProviderName>(props.provider ?? (process.env.LLM_PROVIDER as ProviderName) ?? "codex")
  const [providerSelectorIndex, setProviderSelectorIndex] = useState(0)
  const [authData, setAuthData] = useState<AuthFileData | undefined>()
  const [loadError, setLoadError] = useState<string>()
  const [selected, setSelected] = useState(0)
  const [runtime, setRuntime] = useState<RuntimeState>({ status: "starting" })
  const [activeAccountInfo, setActiveAccountInfo] = useState<AccountInfo>()
  const [limitGroups, setLimitGroups] = useState<LimitGroupView[]>([])
  const [limitsLoading, setLimitsLoading] = useState(false)
  const [limitsError, setLimitsError] = useState<string>()
  const [inputValue, setInputValue] = useState("")
  const [inputMessage, setInputMessage] = useState("Type / for commands")
  const [commandIndex, setCommandIndex] = useState(0)
  const [mode, setMode] = useState<
    "home" | "account-selector" | "kiro-account-selector" | "provider-selector" | "logs" | "claude-env-scope" | "claude-env-editor" | "claude-env-confirm" | "claude-env-unset-confirm" | "connect-source" | "connect-account" | "connect-kiro-source" | "connect-kiro"
  >("home")
  const [selectorIndex, setSelectorIndex] = useState(0)
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>([])
  const [logsSelected, setLogsSelected] = useState(0)
  const [logsDetailOpen, setLogsDetailOpen] = useState(false)
  const [logsDetailScroll, setLogsDetailScroll] = useState(0)
  const [logsCopyStatus, setLogsCopyStatus] = useState<{ type: "success" | "error"; message: string }>()
  const [logsClearConfirm, setLogsClearConfirm] = useState(false)
  const [logsFileError, setLogsFileError] = useState<string>()
  const [logsAutoFollow, setLogsAutoFollow] = useState(true)
  const [claudeEnvDraft, setClaudeEnvDraft] = useState<ClaudeEnvironmentDraft>(() => defaultClaudeEnvironment(activeProvider))
  const [claudeEnvIndex, setClaudeEnvIndex] = useState(0)
  const [claudeEnvScopeIndex, setClaudeEnvScopeIndex] = useState(0)
  const [claudeEnvAction, setClaudeEnvAction] = useState<"set" | "unset">("set")
  const [commandOutput, setCommandOutput] = useState<{ title: string; output: string }>()
  const shell = useMemo(() => detectShell(), [])
  const [connectDraft, setConnectDraft] = useState<ConnectAccountDraft>({ accountId: "", accessToken: "", refreshToken: "" })
  const [connectSourceIndex, setConnectSourceIndex] = useState(0)
  const [connectStep, setConnectStep] = useState(0)
  const [connectSaving, setConnectSaving] = useState(false)
  const [kiroConnectDraft, setKiroConnectDraft] = useState<KiroConnectDraft>({ refreshToken: "", region: "us-east-1" })
  const [kiroConnectStep, setKiroConnectStep] = useState(0)
  const [kiroConnectError, setKiroConnectError] = useState<string>()
  const [kiroAuthEntries, setKiroAuthEntries] = useState<KiroAuthEntry[]>([])
  const [kiroSelected, setKiroSelected] = useState(0)
  const [kiroSourceIndex, setKiroSourceIndex] = useState(0)
  const [authRevision, setAuthRevision] = useState(0)
  const pkg = useMemo(() => packageInfo(), [])
  const activePort = runtime.status === "running" ? runtime.server.port : port

  const accounts = useMemo(() => (authData ? authDataToAccounts(authData) : []), [authData])
  const account = accounts[selected]
  const kiroAccounts = useMemo(() => kiroAuthDataToAccounts(kiroAuthEntries), [kiroAuthEntries])
  const kiroAccount = kiroAccounts[kiroSelected]
  const claudeEnvScopes: ClaudeSettingsScope[] = ["user", "project", "local"]
  const claudeEnvScope = claudeEnvScopes[claudeEnvScopeIndex] ?? "user"
  const claudeSettingsFile = claudeSettingsPathForScope(claudeEnvScope)
  const claudeSettingsTarget = claudeSettingsScopeLabel(claudeEnvScope)

  // Load saved provider state on startup (only if no CLI/env override)
  useEffect(() => {
    if (props.provider || process.env.LLM_PROVIDER) return
    let active = true
    void readProviderState().then((state) => {
      if (!active || !state) return
      setActiveProvider(state.provider)
      if (state.kiroAccount) setKiroSelected((prev) => prev) // will be resolved by kiro auth data effect
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!logsCopyStatus) return
    const timer = setTimeout(() => setLogsCopyStatus(undefined), 2000)
    return () => clearTimeout(timer)
  }, [logsCopyStatus])

  useEffect(() => {
    if (activeProvider === "kiro") return // Kiro doesn't use Codex auth files
    let active = true
    Promise.all([readAuthFileData(authFile), readAccountInfoFile(authFile)])
      .then(([file, info]) => {
        if (!active) return
        setAuthData(file.data)
        setSelected(selectedAccountIndex(file.data, process.env.CODEX_AUTH_ACCOUNT ?? info?.activeAccount))
        void writeAccountInfoFile(authFile, file.data, process.env.CODEX_AUTH_ACCOUNT ?? info?.activeAccount).catch(() => {})
      })
      .catch((error) => {
        if (!active) return
        setLoadError(error instanceof Error ? error.message : String(error))
        setRuntime({ status: "error", error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      active = false
    }
  }, [authFile, activeProvider])

  // Load Kiro auth data when provider is kiro
  useEffect(() => {
    if (activeProvider !== "kiro") {
      setKiroAuthEntries([])
      return
    }
    let active = true
    void Promise.all([readKiroAuthData(), readProviderState()]).then(([{ data }, state]) => {
      if (!active) return
      setKiroAuthEntries(data)
      const savedAccount = state?.kiroAccount
      const idx = savedAccount ? data.findIndex((e, i) => (e.profileArn ?? e.clientIdHash ?? e.name ?? `kiro-${i + 1}`) === savedAccount || e.name === savedAccount) : -1
      setKiroSelected(idx >= 0 ? idx : Math.min(kiroSelected, Math.max(0, data.length - 1)))
    }).catch(() => {
      if (active) setKiroAuthEntries([])
    })
    return () => { active = false }
  }, [activeProvider, authRevision])

  useEffect(() => {
    // Codex requires a loaded account; Kiro does not.
    if (activeProvider === "codex" && (!account || loadError)) return
    if (activeProvider === "codex" && loadError) return
    let active = true
    let server: ReturnType<typeof Bun.serve> | undefined
    setRequestLogs([])
    setRuntime({ status: "starting" })
    startRuntime({
      authFile,
      authAccount: activeProvider === "codex" ? account?.key : undefined,
      kiroAccount: activeProvider === "kiro" ? kiroAccount?.key : undefined,
      hostname,
      port,
      provider: activeProvider,
      logBody: process.env.LOG_BODY !== "0",
      quiet: true,
      onRequestLogStart: (entry) => {
        setRequestLogs((logs) => {
          const updated = upsertRequestLog(logs, entry)
          // Auto-follow: always scroll to the newest entry
          setLogsAutoFollow((follow) => {
            if (follow) setLogsSelected(Math.max(0, updated.length - 1))
            return follow
          })
          return updated
        })
      },
      onRequestLog: (entry) => {
        setRequestLogs((logs) => {
          const updated = upsertRequestLog(logs, entry)
          setLogsAutoFollow((follow) => {
            if (follow) setLogsSelected(Math.max(0, updated.length - 1))
            return follow
          })
          return updated
        })
      },
    })
      .then((nextServer) => {
        server = nextServer
        if (!active) {
          nextServer.stop(true)
          return
        }
        setRuntime({ status: "running", server: nextServer, startedAt: Date.now() })
      })
      .catch((error) => {
        if (!active) return
        setRuntime({ status: "error", error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      active = false
      server?.stop(true)
    }
  }, [account?.key, authFile, authRevision, hostname, loadError, port, activeProvider, kiroSelected])

  useEffect(() => {
    if (mode !== "logs") return
    let active = true

    async function loadLogs() {
      try {
        const logs = await readRecentRequestLogs(authFile)
        if (!active) return
        setLogsFileError(undefined)
        setRequestLogs((currentLogs) => {
          const merged = mergeRequestLogs(logs, currentLogs)
          setLogsAutoFollow((follow) => {
            if (follow) {
              setLogsSelected(Math.max(0, merged.length - 1))
            } else {
              setLogsSelected((prev) => Math.max(0, Math.min(prev, merged.length - 1)))
            }
            return follow
          })
          return merged
        })
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setLogsFileError(`Failed to read log file: ${message}`)
      }
    }

    void loadLogs()
    // Poll every 2 s so new requests that arrive while the panel is open are
    // reflected without requiring the user to close and reopen the panel.
    const timer = setInterval(() => void loadLogs(), 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [authFile, mode, authRevision, selected])

  useEffect(() => {
    if (activeProvider !== "codex" || !account || loadError) return
    let active = true
    async function refresh() {
      try {
        setLimitsLoading(true)
        setLimitsError(undefined)
        const info = await refreshActiveAccountInfo(authFile, account.key)
        const client = await CodexStandaloneClient.fromAuthFile(authFile, { authAccount: account.key })
        const response = await client.usage()
        if (!response.ok) throw new Error(`usage request failed with ${response.status}`)
        const usage = usageToView(await response.json())
        if (active) {
          setActiveAccountInfo({ ...info, ...usage.accountInfo, updatedAt: usage.accountInfo?.updatedAt ?? info.updatedAt })
          setLimitGroups(usage.limitGroups)
          setLimitsLoading(false)
        }
      } catch (error) {
        if (active) {
          setLimitsLoading(false)
          setLimitsError(error instanceof Error ? error.message : String(error))
          setInputMessage(`Account refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [account?.key, authFile, authRevision, loadError, activeProvider])

  // Fetch Kiro usage limits when provider is kiro
  useEffect(() => {
    if (activeProvider !== "kiro") return
    const entry = kiroAuthEntries[kiroSelected]
    if (!entry) return
    if (runtime.status !== "running") return
    let active = true
    async function refresh() {
      try {
        setLimitsLoading(true)
        setLimitsError(undefined)
        const response = await fetch(`http://${hostname}:${runtime.server.port}/usage`)
        if (!response.ok) throw new Error(`usage request failed with ${response.status}`)
        const data = await response.json()
        if (!active) return
        const usage = kiroUsageToView(data)
        setActiveAccountInfo({
          name: entry.name,
          ...usage.accountInfo,
          updatedAt: usage.accountInfo?.updatedAt ?? new Date().toISOString(),
        })
        setLimitGroups(usage.limitGroups)
        setLimitsLoading(false)
      } catch (error) {
        if (!active) return
        setLimitsLoading(false)
        setLimitsError(error instanceof Error ? error.message : String(error))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [kiroSelected, kiroAuthEntries, authRevision, activeProvider, runtime.status])

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (runtime.status === "running") runtime.server.stop(true)
      app.exit()
      return
    }
    if (mode === "logs") {
      if (logsClearConfirm) {
        if (input.toLowerCase() === "y") {
          void clearRequestLogs(authFile)
            .then(() => {
              setRequestLogs([])
              setLogsSelected(0)
              setLogsDetailOpen(false)
              setLogsDetailScroll(0)
              setLogsCopyStatus(undefined)
              setLogsClearConfirm(false)
              setLogsFileError(undefined)
              setInputMessage("Cleared request logs")
            })
            .catch((error) => {
              const message = `Clear request logs failed: ${error instanceof Error ? error.message : String(error)}`
              setLogsCopyStatus({ type: "error", message })
              setLogsClearConfirm(false)
              setInputMessage(message)
            })
          return
        }
        if (key.escape || input.toLowerCase() === "n") {
          setLogsClearConfirm(false)
          setInputMessage("Clear request logs cancelled")
          return
        }
        return
      }
      if (logsDetailOpen && input.toLowerCase() === "c") {
        const log = requestLogs[logsSelected]
        if (!log) return
        void writeClipboard(formatRequestLogDetail(log))
          .then(() => {
            setLogsCopyStatus({ type: "success", message: `Copied request ${log.id} to clipboard` })
            setInputMessage(`Copied request ${log.id} to clipboard`)
          })
          .catch((error) => {
            const message = `Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`
            setLogsCopyStatus({ type: "error", message })
            setInputMessage(message)
          })
        return
      }
      if (input.toLowerCase() === "l") {
        void writeClipboard(formatAllRequestLogs(requestLogs))
          .then(() => {
            setLogsCopyStatus({ type: "success", message: `Copied ${requestLogs.length} log(s) to clipboard` })
            setInputMessage(`Copied ${requestLogs.length} log(s) to clipboard`)
          })
          .catch((error) => {
            const message = `Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`
            setLogsCopyStatus({ type: "error", message })
            setInputMessage(message)
        })
        return
      }
      if (input.toLowerCase() === "x") {
        setLogsDetailOpen(false)
        setLogsDetailScroll(0)
        setLogsCopyStatus(undefined)
        setLogsClearConfirm(true)
        setInputMessage("Confirm clear request logs")
        return
      }
      if (input.toLowerCase() === "f") {
        setLogsAutoFollow((value) => {
          const next = !value
          if (next) {
            // Jump to the latest entry when enabling follow
            setLogsSelected(Math.max(0, requestLogs.length - 1))
            setInputMessage("Auto-follow ON — tracking latest request")
          } else {
            setInputMessage("Auto-follow OFF — manual navigation")
          }
          return next
        })
        return
      }
    }
    if (mode === "home" && input === "q" && !inputValue) {
      if (runtime.status === "running") runtime.server.stop(true)
      app.exit()
      return
    }
    if (key.escape) {
      if (mode === "connect-source" || mode === "connect-account") {
        setMode("home")
        setConnectDraft({ accountId: "", accessToken: "", refreshToken: "" })
        setConnectSourceIndex(0)
        setConnectStep(0)
        setInputMessage("Connect account cancelled")
        return
      }
      if (mode === "connect-kiro") {
        setMode("home")
        setKiroConnectDraft({ refreshToken: "", region: "us-east-1" })
        setKiroConnectStep(0)
        setKiroConnectError(undefined)
        setInputMessage("Kiro connect cancelled")
        return
      }
      if (mode === "connect-kiro-source") {
        setMode("home")
        setKiroSourceIndex(0)
        setInputMessage("Kiro connect cancelled")
        return
      }
      if (mode === "kiro-account-selector") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage("Kiro account switch cancelled")
        return
      }
      if (commandOutput) {
        setCommandOutput(undefined)
        setInputMessage("Type / for commands")
        return
      }
      if (mode === "claude-env-scope" || mode === "claude-env-editor" || mode === "claude-env-confirm" || mode === "claude-env-unset-confirm") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage(mode === "claude-env-unset-confirm" ? "Claude environment unset cancelled" : "Claude environment edit cancelled")
        return
      }
      if (mode === "logs") {
        if (logsClearConfirm) {
          setLogsClearConfirm(false)
          setInputMessage("Clear request logs cancelled")
          return
        }
        if (logsDetailOpen) {
          setLogsDetailOpen(false)
          setLogsDetailScroll(0)
          setLogsCopyStatus(undefined)
          setInputMessage("Closed request detail")
          return
        }
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setLogsCopyStatus(undefined)
        setLogsClearConfirm(false)
        setInputMessage("Closed request logs")
        return
      }
      if (mode === "account-selector") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage("Account switch cancelled")
        return
      }
      if (mode === "provider-selector") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage("Provider switch cancelled")
        return
      }
      setInputValue("")
      setCommandIndex(0)
      setInputMessage("Type / for commands")
      return
    }
    if (key.return) {
      if (mode === "connect-source") {
        if (connectSourceIndex === 0) {
          setConnectSaving(true)
          void connectAccountFromCodexAuth(authFile)
            .then((result) => {
              applyConnectedAccount(result.data, result.accountId)
              setMode("home")
              setInputMessage(`Connected account ${result.accountId} from ~/.codex/auth.json`)
            })
            .catch((error) => setInputMessage(`Connect failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setConnectSaving(false))
          return
        }
        setConnectDraft({ accountId: "", accessToken: "", refreshToken: "" })
        setConnectStep(0)
        setMode("connect-account")
        return
      }
      if (mode === "connect-account") {
        if (connectStep < 2) {
          setConnectStep((step) => step + 1)
          return
        }
        setConnectSaving(true)
        void connectAccount(authFile, connectDraft)
          .then((result) => {
            applyConnectedAccount(result.data, result.accountId)
            setMode("home")
            setConnectDraft({ accountId: "", accessToken: "", refreshToken: "" })
            setConnectStep(0)
            setInputMessage(`Connected account ${result.accountId}`)
          })
          .catch((error) => setInputMessage(`Connect failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => setConnectSaving(false))
        return
      }
      if (mode === "connect-kiro-source") {
        if (kiroSourceIndex === 0) {
          // Sync from AWS SSO cache
          setConnectSaving(true)
          void connectKiroFromSsoCache()
            .then((result) => {
              setMode("home")
              setKiroSourceIndex(0)
              setAuthRevision((v) => v + 1)
              setInputMessage(`Kiro synced: ${result.name} (${result.authType}, ${result.region})`)
            })
            .catch((error) => setInputMessage(`Kiro sync failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setConnectSaving(false))
          return
        }
        // Manual
        setKiroConnectDraft({ refreshToken: "", region: "us-east-1" })
        setKiroConnectStep(0)
        setKiroConnectError(undefined)
        setMode("connect-kiro")
        return
      }
      if (mode === "kiro-account-selector") {
        setKiroSelected(selectorIndex)
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setAuthRevision((v) => v + 1)
        const chosenName = kiroAccounts[selectorIndex]?.name ?? "kiro account"
        setInputMessage(`Switched to ${chosenName}`)
        void writeProviderState({ provider: "kiro", kiroAccount: kiroAccounts[selectorIndex]?.key })
        return
      }
      if (mode === "connect-kiro") {
        if (kiroConnectStep < 1) {
          setKiroConnectStep((step) => step + 1)
          return
        }
        setConnectSaving(true)
        setKiroConnectError(undefined)
        void connectKiro(kiroConnectDraft)
          .then((result) => {
            setMode("home")
            setKiroConnectDraft({ refreshToken: "", region: "us-east-1" })
            setKiroConnectStep(0)
            setAuthRevision((v) => v + 1)
            setInputMessage(`Kiro connected (${result.authType}, ${result.region})`)
          })
          .catch((error) => {
            setKiroConnectError(error instanceof Error ? error.message : String(error))
            setInputMessage(`Kiro connect failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          .finally(() => setConnectSaving(false))
        return
      }
      if (mode === "claude-env-scope") {
        setMode(claudeEnvAction === "set" ? "claude-env-editor" : "claude-env-unset-confirm")
        return
      }
      if (mode === "claude-env-confirm") {
        setMode("home")
        setInputMessage("Claude settings updated")
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft, activeProvider).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, activePort), shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutput({ title: `Set Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutput({ title: "Set Claude environment failed", output: error instanceof Error ? error.message : String(error) }))
        return
      }
      if (mode === "claude-env-unset-confirm") {
        setMode("home")
        setInputMessage("Claude settings env entries removed")
        void runClaudeEnvironmentUnset(claudeEnvDraft, shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutput({ title: `Unset Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutput({ title: "Unset Claude environment echo failed", output: error instanceof Error ? error.message : String(error) }))
        return
      }
      if (mode === "claude-env-editor") {
        setMode("claude-env-confirm")
        return
      }
      if (mode === "account-selector") {
        setSelected(selectorIndex)
        if (authData) void writeActiveAccountInfo(authFile, authData, accounts[selectorIndex]?.key ?? "").catch(() => {})
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage(`Switched to ${accounts[selectorIndex]?.name ?? "account"}`)
        return
      }
      if (mode === "provider-selector") {
        const chosen = PROVIDERS[providerSelectorIndex]
        if (chosen && chosen.name !== activeProvider) {
          setActiveProvider(chosen.name)
          // Clear provider-specific state
          if (chosen.name === "kiro") {
            setActiveAccountInfo(undefined)
            setLimitGroups([])
            setLimitsError(undefined)
            setLoadError(undefined)
          }
          setAuthRevision((value) => value + 1)
          setInputMessage(`Switched provider to ${chosen.label}`)
          void writeProviderState({ provider: chosen.name })
        } else {
          setInputMessage("Provider unchanged")
        }
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        return
      }
      const commands = filterCommands(inputValue, activeProvider)
      const command = commands[commandIndex] ?? commands[0]
      if (mode === "logs") {
        if (requestLogs.length) {
          setLogsDetailOpen((value) => {
            const next = !value
            setLogsDetailScroll(0)
            setInputMessage(next ? `Showing request ${requestLogs[logsSelected]?.id ?? ""}` : "Closed request detail")
            return next
          })
        }
        return
      }
      if (inputValue === "q" || command?.name === "/quit") {
        if (runtime.status === "running") runtime.server.stop(true)
        app.exit()
        return
      }
      if (inputValue.startsWith("/") && command) {
        if (command.name === "/account") {
          if (activeProvider === "kiro") {
            setSelectorIndex(kiroSelected)
            setMode("kiro-account-selector")
          } else {
            setSelectorIndex(selected)
            setMode("account-selector")
          }
          return
        }
        if (command.name === "/provider") {
          setProviderSelectorIndex(PROVIDERS.findIndex((p) => p.name === activeProvider))
          setMode("provider-selector")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/logs") {
          setLogsDetailOpen(false)
          setLogsDetailScroll(0)
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsAutoFollow(true)
          setLogsSelected(Math.max(0, requestLogs.length - 1))
          setMode("logs")
          setInputValue("")
          setCommandIndex(0)
          setInputMessage("Showing request logs")
          return
        }
        if (command.name === "/connect") {
          if (activeProvider === "kiro") {
            setKiroSourceIndex(0)
            setMode("connect-kiro-source")
          } else {
            setConnectSourceIndex(0)
            setConnectStep(0)
            setMode("connect-source")
          }
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/set-claude-env") {
          void readClaudeEnvironmentConfig(authFile, activeProvider)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment(activeProvider)))
          setClaudeEnvIndex(0)
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("set")
          setMode("claude-env-scope")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/unset-claude-env") {
          void readClaudeEnvironmentConfig(authFile, activeProvider)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment(activeProvider)))
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("unset")
          setMode("claude-env-scope")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/limits") {
          // Trigger a manual refresh of limits data
          setLimitsLoading(true)
          setLimitsError(undefined)
          setAuthRevision((v) => v + 1)
          setInputValue("")
          setCommandIndex(0)
          setInputMessage("Refreshing limits...")
          return
        }
        setInputMessage(`${command.name} selected · implementation pending`)
        setInputValue("")
        setCommandIndex(0)
      }
      return
    }
    if (key.backspace || key.delete) {
      if (mode === "connect-account") {
        setConnectDraft((draft) => updateConnectDraft(draft, connectStep, (value) => value.slice(0, -1)))
        return
      }
      if (mode === "connect-kiro") {
        setKiroConnectDraft((draft) => updateKiroConnectDraft(draft, kiroConnectStep, (value) => value.slice(0, -1)))
        return
      }
      if (mode === "claude-env-editor") {
        setClaudeEnvDraft((draft) => updateClaudeEnvDraft(draft, claudeEnvIndex, (value) => value.slice(0, -1)))
        return
      }
      setInputValue((value) => value.slice(0, -1))
      setCommandIndex(0)
      return
    }
    if (mode === "account-selector") {
      if (key.upArrow && accounts.length) setSelectorIndex((value) => (value - 1 + accounts.length) % accounts.length)
      if (key.downArrow && accounts.length) setSelectorIndex((value) => (value + 1) % accounts.length)
      return
    }
    if (mode === "provider-selector") {
      if (key.upArrow) setProviderSelectorIndex((value) => (value - 1 + PROVIDERS.length) % PROVIDERS.length)
      if (key.downArrow) setProviderSelectorIndex((value) => (value + 1) % PROVIDERS.length)
      return
    }
    if (mode === "connect-source") {
      if (key.upArrow) setConnectSourceIndex((value) => (value - 1 + 2) % 2)
      if (key.downArrow) setConnectSourceIndex((value) => (value + 1) % 2)
      return
    }
    if (mode === "connect-kiro-source") {
      if (key.upArrow) setKiroSourceIndex((value) => (value - 1 + KIRO_CONNECT_SOURCES.length) % KIRO_CONNECT_SOURCES.length)
      if (key.downArrow) setKiroSourceIndex((value) => (value + 1) % KIRO_CONNECT_SOURCES.length)
      return
    }
    if (mode === "kiro-account-selector") {
      if (key.upArrow && kiroAccounts.length) setSelectorIndex((value) => (value - 1 + kiroAccounts.length) % kiroAccounts.length)
      if (key.downArrow && kiroAccounts.length) setSelectorIndex((value) => (value + 1) % kiroAccounts.length)
      return
    }
    if (mode === "logs") {
      if (logsDetailOpen) {
        if (key.upArrow) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll((value) => Math.max(0, value - 1))
        }
        if (key.downArrow) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll((value) => value + 1)
        }
        return
      }
      if (key.upArrow) {
        setLogsAutoFollow(false)
        setLogsDetailOpen(false)
        setLogsDetailScroll(0)
        setLogsCopyStatus(undefined)
        setLogsClearConfirm(false)
        setLogsSelected((value) => Math.max(0, value - 1))
      }
      if (key.downArrow) {
        setLogsAutoFollow(false)
        setLogsDetailOpen(false)
        setLogsDetailScroll(0)
        setLogsCopyStatus(undefined)
        setLogsClearConfirm(false)
        setLogsSelected((value) => Math.min(Math.max(0, requestLogs.length - 1), value + 1))
      }
      return
    }
    if (mode === "claude-env-scope") {
      if (key.upArrow) setClaudeEnvScopeIndex((value) => (value - 1 + claudeEnvScopes.length) % claudeEnvScopes.length)
      if (key.downArrow) setClaudeEnvScopeIndex((value) => (value + 1) % claudeEnvScopes.length)
      return
    }
    if (mode === "claude-env-confirm") {
      if (input === "y") {
        setMode("home")
        setInputMessage("Claude settings updated")
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft, activeProvider).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, activePort), shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutput({ title: `Set Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutput({ title: "Set Claude environment failed", output: error instanceof Error ? error.message : String(error) }))
      }
      if (input === "n") {
        setMode("home")
        setInputMessage("Claude environment edit cancelled")
      }
      return
    }
    if (mode === "claude-env-unset-confirm") {
      if (input === "y") {
        setMode("home")
        setInputMessage("Claude settings env entries removed")
        void runClaudeEnvironmentUnset(claudeEnvDraft, shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutput({ title: `Unset Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutput({ title: "Unset Claude environment echo failed", output: error instanceof Error ? error.message : String(error) }))
      }
      if (input === "n") {
        setMode("home")
        setInputMessage("Claude environment unset cancelled")
      }
      return
    }
    if (mode === "claude-env-editor") {
      if (key.upArrow) setClaudeEnvIndex((value) => (value - 1 + CLAUDE_MODEL_ENV_KEYS.length) % CLAUDE_MODEL_ENV_KEYS.length)
      else if (key.downArrow) setClaudeEnvIndex((value) => (value + 1) % CLAUDE_MODEL_ENV_KEYS.length)
      else if (input && !key.leftArrow && !key.rightArrow) setClaudeEnvDraft((draft) => updateClaudeEnvDraft(draft, claudeEnvIndex, (value) => `${value}${input}`))
      return
    }
    if (mode === "connect-account") {
      if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setConnectDraft((draft) => updateConnectDraft(draft, connectStep, (value) => `${value}${input}`))
      }
      return
    }
    if (mode === "connect-kiro") {
      if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setKiroConnectDraft((draft) => updateKiroConnectDraft(draft, kiroConnectStep, (value) => `${value}${input}`))
      }
      return
    }
    if (inputValue.startsWith("/") && key.upArrow) {
      const commands = filterCommands(inputValue, activeProvider)
      if (commands.length) setCommandIndex((value) => (value - 1 + commands.length) % commands.length)
      return
    }
    if (inputValue.startsWith("/") && key.downArrow) {
      const commands = filterCommands(inputValue, activeProvider)
      if (commands.length) setCommandIndex((value) => (value + 1) % commands.length)
      return
    }
    if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setInputValue((value) => `${value}${input}`)
      setCommandIndex(0)
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginLeft={1}>
        <Text color="#d97757">─── </Text>
        <Text color="#aab3cf">v{pkg.version} - Author: {pkg.author} </Text>
        <Text color="#d97757">────────────────────────────────────────</Text>
      </Box>
      <Box borderStyle="round" borderColor="#d97757" minHeight={18}>
        <WelcomePanel hostname={hostname} port={activePort} provider={activeProvider} />
        <Box width={1} borderStyle="single" borderColor="#7f4f45" />
        <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
          <AccountInfoPanel account={account} info={activeAccountInfo} provider={activeProvider} kiroAccount={kiroAccount} />
          <LimitsPanel limitGroups={limitGroups} loading={limitsLoading} error={limitsError} />
        </Box>
      </Box>
      {mode === "account-selector" && <AccountSelector accounts={accounts} selected={selectorIndex} />}
      {mode === "kiro-account-selector" && <KiroAccountSelector accounts={kiroAccounts} selected={selectorIndex} />}
      {mode === "provider-selector" && <ProviderSelector selected={providerSelectorIndex} current={activeProvider} />}
      {mode === "connect-source" && <ConnectSourceSelector selected={connectSourceIndex} saving={connectSaving} />}
      {mode === "connect-kiro-source" && <ConnectKiroSourceSelector selected={kiroSourceIndex} saving={connectSaving} />}
      {mode === "logs" && (
        <>
          <CommandInput value={inputValue} message={inputMessage} selected={commandIndex} provider={activeProvider} />
          <RequestLogsPanel
            logs={requestLogs}
            selected={logsSelected}
            autoFollow={logsAutoFollow}
            detailOpen={logsDetailOpen}
            detailScroll={logsDetailScroll}
            copyStatus={logsCopyStatus}
            clearConfirm={logsClearConfirm}
            fileError={logsFileError}
          />
        </>
      )}
      {mode === "claude-env-scope" ? (
        <ClaudeEnvironmentScopeSelector selected={claudeEnvScopeIndex} action={claudeEnvAction} />
      ) : (mode === "claude-env-editor" || mode === "claude-env-confirm") ? (
        <ClaudeEnvironmentEditor draft={claudeEnvDraft} selected={claudeEnvIndex} baseUrl={baseUrl(hostname, activePort)} confirm={mode === "claude-env-confirm"} shell={shell.kind === "unsupported" ? "posix" : shell.kind} settingsTarget={claudeSettingsTarget} />
      ) : mode === "claude-env-unset-confirm" ? (
        <ClaudeEnvironmentUnsetConfirm draft={claudeEnvDraft} shell={shell.kind === "unsupported" ? "posix" : shell.kind} settingsTarget={claudeSettingsTarget} />
      ) : mode === "connect-account" ? (
        <ConnectAccountWizard draft={connectDraft} step={connectStep} saving={connectSaving} />
      ) : mode === "connect-kiro" ? (
        <ConnectKiroWizard draft={kiroConnectDraft} step={kiroConnectStep} saving={connectSaving} error={kiroConnectError} />
      ) : (
        mode === "home" && <CommandInput value={inputValue} message={inputMessage} selected={commandIndex} provider={activeProvider} />
      )}
      {commandOutput && <CommandOutput title={commandOutput.title} output={commandOutput.output} />}
    </Box>
  )

  function applyConnectedAccount(data: AuthFileData, accountId: string) {
    setLoadError(undefined)
    setAuthData(data)
    setSelected(selectedAccountIndex(data, accountId))
    setActiveAccountInfo(undefined)
    setLimitGroups([])
    setLimitsError(undefined)
    setLimitsLoading(true)
    setAuthRevision((value) => value + 1)
  }
}

function updateConnectDraft(draft: ConnectAccountDraft, step: number, update: (value: string) => string): ConnectAccountDraft {
  const keys = ["accountId", "accessToken", "refreshToken"] as const
  const key = keys[step]
  return {
    ...draft,
    [key]: update(draft[key]),
  }
}

function updateClaudeEnvDraft(draft: ClaudeEnvironmentDraft, index: number, update: (value: string) => string): ClaudeEnvironmentDraft {
  const key = CLAUDE_MODEL_ENV_KEYS[index]
  return {
    ...draft,
    [key]: update(draft[key]),
  }
}

function baseUrl(hostname: string, port: number) {
  return `http://${hostname}:${port}`
}

function mergeRequestLogs(storedLogs: RequestLogEntry[], currentLogs: RequestLogEntry[]) {
  // Start from stored logs (source of truth on disk), then overlay any
  // in-memory entries that are not yet persisted (pending or complete but
  // not yet flushed due to a race between write and the polling read).
  let merged = [...storedLogs]
  for (const log of currentLogs) {
    if (merged.some((storedLog) => storedLog.id === log.id)) continue
    merged = upsertRequestLog(merged, log)
  }
  return merged
}

function upsertRequestLog(logs: RequestLogEntry[], entry: RequestLogEntry) {
  const next = logs.filter((log) => log.id !== entry.id)
  next.push(entry)
  next.sort((left, right) => left.at.localeCompare(right.at))
  return next.slice(-MAX_REQUEST_LOG_ENTRIES)
}

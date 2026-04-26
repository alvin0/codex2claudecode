import { Box, Text, useApp, useInput, useStdout } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { packageInfo } from "../app/package-info"
import { clearRequestLogs, MAX_REQUEST_LOG_ENTRIES, readRecentRequestLogs, readRequestLogDetail } from "../core/request-logs"
import type { RequestLogEntry, RequestLogMode } from "../core/types"
import {
  claudeSettingsPathForScope,
  claudeSettingsScopeLabel,
  defaultClaudeEnvironment,
  detectShell,
  CLAUDE_MODEL_ENV_KEYS,
  ALL_EDITABLE_KEYS,
  readClaudeEnvironmentConfig,
  readClaudeSettingsEnvAsDraft,
  recommendedClaudeEnvironment,
  runClaudeEnvironmentSet,
  runClaudeEnvironmentUnset,
  writeClaudeEnvironmentConfig,
  type ClaudeSettingsScope,
  type ClaudeEnvironmentDraft,
} from "./claude-env"
import { getCommands } from "./commands"
import { writeClipboard } from "./clipboard"
import { AccountSelector } from "./components/account-selector"
import { ClaudeEnvironmentEditor } from "./components/claude-environment-editor"
import { ClaudeEnvironmentPresetSelector, PRESET_OPTIONS } from "./components/claude-environment-preset-selector"
import { ClaudeEnvironmentScopeSelector } from "./components/claude-environment-scope-selector"
import { ClaudeEnvironmentUnsetConfirm } from "./components/claude-environment-unset-confirm"
import { CommandInput } from "./components/command-input"
import { CommandOutput } from "./components/command-output"
import { CodexFastModeSelector } from "./components/codex-fast-mode"
import { ConnectAccountWizard } from "./components/connect-account-wizard"
import { ConnectSourceSelector } from "./components/connect-source-selector"
import { ProviderDashboard } from "./components/provider-dashboard"
import {
  formatAllRequestLogs,
  formatRequestLogDetail,
  RequestLogsPanel,
  REQUEST_LOG_DETAIL_FAST_SCROLL_STEP,
  REQUEST_LOG_DETAIL_SCROLL_STEP,
  requestLogDetailMaxScroll,
} from "./components/request-logs-panel"
import { SwitchProviderConfirm } from "./components/switch-provider-confirm"
import { nextProviderDefinition, providerDefinition } from "./providers/registry"
import type { ProviderAccountData, ProviderConnectDraft, ProviderConnectField } from "./providers/types"
import { useCodexFastMode } from "./providers/use-codex-fast-mode"
import { useProviderLimits } from "./providers/use-provider-limits"
import { useProviderRuntime } from "./providers/use-provider-runtime"
import type { ProviderMode } from "./types"

export function CodexCodeApp(props: { port?: number }) {
  const app = useApp()
  const { stdout } = useStdout()
  const hostname = process.env.HOST ?? "127.0.0.1"
  const port = props.port ?? Number(process.env.PORT || 8787)
  const [accountData, setAccountData] = useState<ProviderAccountData>()
  const [loadError, setLoadError] = useState<string>()
  const [selected, setSelected] = useState(0)
  const [inputMessage, setInputMessage] = useState("↑↓ select · enter confirm")
  const [commandIndex, setCommandIndex] = useState(0)
  const [mode, setMode] = useState<
    | "home"
    | "account-selector"
    | "logs"
    | "codex-fast-mode"
    | "claude-env-scope"
    | "claude-env-preset"
    | "claude-env-editor"
    | "claude-env-confirm"
    | "claude-env-unset-confirm"
    | "connect-source"
    | "connect-account"
    | "switch-provider"
  >("home")
  const [selectorIndex, setSelectorIndex] = useState(0)
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>([])
  const [requestLogDetails, setRequestLogDetails] = useState<Record<string, RequestLogEntry>>({})
  const [logsSelected, setLogsSelected] = useState(0)
  const [logsDetailOpen, setLogsDetailOpen] = useState(false)
  const [logsDetailScroll, setLogsDetailScroll] = useState(0)
  const [logsCopyStatus, setLogsCopyStatus] = useState<{ type: "success" | "error"; message: string }>()
  const [logsClearConfirm, setLogsClearConfirm] = useState(false)
  const [logsFileError, setLogsFileError] = useState<string>()
  const [logsAutoFollow, setLogsAutoFollow] = useState(true)
  const [logsCaptureMode, setLogsCaptureMode] = useState<Exclude<RequestLogMode, "off">>(() => initialLogsCaptureMode())
  const requestLogModeRef = useRef<RequestLogMode>("off")
  const [claudeEnvDraft, setClaudeEnvDraft] = useState<ClaudeEnvironmentDraft>(() => defaultClaudeEnvironment())
  const [claudeEnvIndex, setClaudeEnvIndex] = useState(0)
  const [claudeEnvScopeIndex, setClaudeEnvScopeIndex] = useState(0)
  const [claudeEnvPresetIndex, setClaudeEnvPresetIndex] = useState(0)
  const [claudeEnvAction, setClaudeEnvAction] = useState<"set" | "unset">("set")
  const [commandOutput, setCommandOutput] = useState<{ title: string; output: string }>()
  const commandOutputRevision = useRef(0)
  const shell = useMemo(() => detectShell(), [])
  const [connectDraft, setConnectDraft] = useState<ProviderConnectDraft>({})
  const [connectSourceIndex, setConnectSourceIndex] = useState(0)
  const [connectStep, setConnectStep] = useState(0)
  const [connectSaving, setConnectSaving] = useState(false)
  const [authRevision, setAuthRevision] = useState(0)
  const [accountKey, setAccountKey] = useState<string>()
  const resetRuntimeLogs = useCallback(() => {
    setRequestLogs([])
    setRequestLogDetails({})
  }, [])
  const clearCommandOutput = useCallback(() => {
    commandOutputRevision.current += 1
    setCommandOutput(undefined)
  }, [])
  const beginCommandOutput = useCallback(() => {
    commandOutputRevision.current += 1
    setCommandOutput(undefined)
    return commandOutputRevision.current
  }, [])
  const setCommandOutputForRevision = useCallback((revision: number, output: { title: string; output: string }) => {
    if (commandOutputRevision.current === revision) setCommandOutput(output)
  }, [])
  const appendRuntimeLog = useCallback((entry: RequestLogEntry) => {
    setRequestLogs((logs) => {
      const updated = upsertRequestLog(logs, entry)
      setLogsAutoFollow((follow) => {
        if (follow) setLogsSelected(Math.max(0, updated.length - 1))
        return follow
      })
      return updated
    })
  }, [])
  const resolveRequestLogMode = useCallback(() => requestLogModeRef.current, [])
  const providerRuntime = useProviderRuntime({
    hostname,
    port,
    accountKey,
    authRevision,
    loadError,
    onMessage: setInputMessage,
    requestLogMode: resolveRequestLogMode,
    onRequestLogsReset: resetRuntimeLogs,
    onRequestLogStart: appendRuntimeLog,
    onRequestLog: appendRuntimeLog,
  })
  const {
    authFile,
    providerReady,
    providerMode,
    providerInfo,
    runtime,
    setProviderInfo,
    setRuntimeError,
    switchingProvider,
    switchProvider,
    upstream,
  } = providerRuntime
  const provider = useMemo(() => providerDefinition(providerMode), [providerMode])
  const accountCapability = provider.accounts
  const connectCapability = accountCapability?.connect
  const connectFields = connectCapability?.fields ?? []
  const accounts = useMemo(() => (accountData && accountCapability ? accountCapability.toAccounts(accountData) : []), [accountCapability, accountData])
  const account = accounts[selected]
  const codexFastMode = useCodexFastMode({ authFile, providerMode, providerReady, onMessage: setInputMessage })
  const updateKiroInfo = useCallback((patch: { subscriptionTier?: string; email?: string }) => {
    setProviderInfo((prev) => prev.mode === "kiro" ? { ...prev, ...patch } : prev)
  }, [setProviderInfo])
  const { activeAccountInfo, limitGroups, limitsLoading, limitsError, resetLimits } = useProviderLimits({
    authFile,
    authRevision,
    accountKey,
    loadError,
    providerMode,
    providerReady,
    runtimeStatus: runtime.status,
    upstream,
    onKiroInfo: updateKiroInfo,
    onMessage: setInputMessage,
  })
  const resetForProviderSwitch = useCallback((_targetMode: ProviderMode) => {
    resetRuntimeLogs()
    resetLimits()
    clearCommandOutput()
    setLoadError(undefined)
    setAccountData(undefined)
    setAccountKey(undefined)
    setSelected(0)
    setAuthRevision((value) => value + 1)
  }, [clearCommandOutput, resetLimits, resetRuntimeLogs])
  const pkg = useMemo(() => packageInfo(), [])
  const activePort = runtime.status === "running" ? runtime.server.port ?? port : port
  const terminalColumns = stdout.columns ?? 120
  const contentWidth = Math.max(40, terminalColumns - 2)
  const dashboardCompact = contentWidth < 106
  const dashboardInnerWidth = Math.max(32, contentWidth - 4)
  const commands = useMemo(() => getCommands(providerMode), [providerMode])
  const switchTarget = useMemo(() => nextProviderDefinition(providerMode), [providerMode])
  const headerText = providerMode === "kiro" ? `v${pkg.version} · Kiro - Author: ${pkg.author}` : `v${pkg.version} - Author: ${pkg.author}`
  const headerTextWidth = Math.max(12, Math.min(headerText.length, contentWidth - 10))
  const visibleRequestLogs = useMemo(
    () => requestLogs.map((log) => requestLogDetails[log.id] ?? log),
    [requestLogDetails, requestLogs],
  )

  const claudeEnvScopes: ClaudeSettingsScope[] = ["user", "project", "local"]
  const claudeEnvScope = claudeEnvScopes[claudeEnvScopeIndex] ?? "user"
  const claudeSettingsFile = claudeSettingsPathForScope(claudeEnvScope)
  const claudeSettingsTarget = claudeSettingsScopeLabel(claudeEnvScope)

  useEffect(() => {
    requestLogModeRef.current = mode === "logs" ? logsCaptureMode : "off"
  }, [logsCaptureMode, mode])

  useEffect(() => {
    setCommandIndex((value) => Math.min(value, Math.max(0, commands.length - 1)))
  }, [commands.length])

  useEffect(() => {
    if (!logsCopyStatus) return
    const timer = setTimeout(() => setLogsCopyStatus(undefined), 2000)
    return () => clearTimeout(timer)
  }, [logsCopyStatus])

  useEffect(() => {
    if (!providerReady) return
    if (!accountCapability) {
      setAccountData(undefined)
      setAccountKey(undefined)
      setSelected(0)
      setLoadError(undefined)
      return
    }
    let active = true
    accountCapability.loadState(authFile)
      .then((state) => {
        if (!active) return
        const loadedAccounts = accountCapability.toAccounts(state.data)
        const nextSelected = Math.min(state.selected, Math.max(0, loadedAccounts.length - 1))
        setLoadError(undefined)
        setAccountData(state.data)
        setSelected(nextSelected)
        setAccountKey(loadedAccounts[nextSelected]?.key)
      })
      .catch((error) => {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setAccountData(undefined)
        setAccountKey(undefined)
        setLoadError(message)
        setRuntimeError(message)
      })
    return () => {
      active = false
    }
  }, [accountCapability, authFile, authRevision, providerReady, setRuntimeError])

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
    if (mode !== "logs" || !logsDetailOpen) return
    const log = requestLogs[logsSelected]
    if (!log || requestLogDetails[log.id]) return
    let active = true
    void readRequestLogDetail(authFile, log)
      .then((detail) => {
        if (!active) return
        setRequestLogDetails((details) => ({ ...details, [detail.id]: detail }))
      })
      .catch((error) => {
        if (!active) return
        setLogsFileError(`Failed to read request detail: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      active = false
    }
  }, [authFile, logsDetailOpen, logsSelected, mode, requestLogDetails, requestLogs])

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (runtime.status === "running") runtime.server.stop(true)
      app.exit()
      return
    }
    if (switchingProvider) return
    if (mode === "logs") {
      if (logsClearConfirm) {
        if (input.toLowerCase() === "y") {
          void clearRequestLogs(authFile)
            .then(() => {
              setRequestLogs([])
              setRequestLogDetails({})
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
        void readRequestLogDetail(authFile, log)
          .then((detail) => {
            setRequestLogDetails((details) => ({ ...details, [detail.id]: detail }))
            return writeClipboard(formatRequestLogDetail(detail))
          })
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
        void Promise.all(requestLogs.map((log) => readRequestLogDetail(authFile, log)))
          .then((logs) => {
            setRequestLogDetails((details) => ({
              ...details,
              ...Object.fromEntries(logs.map((log) => [log.id, log])),
            }))
            return writeClipboard(formatAllRequestLogs(logs))
          })
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
      if (input.toLowerCase() === "d") {
        setLogsCaptureMode((value) => {
          const next = value === "sync" ? "async" : "sync"
          requestLogModeRef.current = next
          setInputMessage(next === "sync" ? "Request logs SYNC — writes complete before responses finish" : "Request logs ASYNC — writes happen in the background")
          return next
        })
        return
      }
    }
    if (mode === "home" && input === "q") {
      if (runtime.status === "running") runtime.server.stop(true)
      app.exit()
      return
    }
    if (key.escape) {
      if (mode === "switch-provider") {
        setMode("home")
        setCommandIndex(0)
        setInputMessage("Provider switch cancelled")
        return
      }
      if (mode === "connect-source" || mode === "connect-account") {
        setMode("home")
        setConnectDraft(connectCapability?.defaultDraft() ?? {})
        setConnectSourceIndex(0)
        setConnectStep(0)
        setInputMessage("Connect account cancelled")
        return
      }
      if (commandOutput) {
        clearCommandOutput()
        setInputMessage("Type / for commands")
        return
      }
      if (mode === "claude-env-scope" || mode === "claude-env-preset" || mode === "claude-env-editor" || mode === "claude-env-confirm" || mode === "claude-env-unset-confirm") {
        setMode("home")
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
        requestLogModeRef.current = "off"
        setCommandIndex(0)
        setLogsCopyStatus(undefined)
        setLogsClearConfirm(false)
        setInputMessage("Closed request logs")
        return
      }
      if (mode === "codex-fast-mode") {
        setMode("home")
        setCommandIndex(0)
        codexFastMode.resetSelection()
        setInputMessage("Codex fast mode unchanged")
        return
      }
      if (mode === "account-selector") {
        setMode("home")
        setCommandIndex(0)
        setInputMessage("Account switch cancelled")
        return
      }
      setCommandIndex(0)
      setInputMessage("↑↓ select · enter confirm")
      return
    }
    if (key.return) {
      if (mode === "switch-provider") {
        setMode("home")
        void switchProvider({ onBeforeApply: resetForProviderSwitch })
        return
      }
      if (mode === "connect-source") {
        if (!connectCapability) {
          setMode("home")
          setInputMessage("Connect is not available for this provider")
          return
        }
        if (connectSourceIndex === 0) {
          setConnectSaving(true)
          void connectCapability.importFromSource(authFile)
            .then((result) => {
              applyConnectedAccount(result.data, result.accountKey)
              setMode("home")
              setInputMessage(`Connected account ${result.accountKey}`)
            })
            .catch((error) => setInputMessage(`Connect failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => setConnectSaving(false))
          return
        }
        setConnectDraft(connectCapability.defaultDraft())
        setConnectStep(0)
        setMode("connect-account")
        return
      }
      if (mode === "connect-account") {
        if (!connectCapability) {
          setMode("home")
          setInputMessage("Connect is not available for this provider")
          return
        }
        if (connectStep < connectFields.length - 1) {
          setConnectStep((step) => step + 1)
          return
        }
        setConnectSaving(true)
        void connectCapability.connectManual(authFile, connectDraft)
          .then((result) => {
            applyConnectedAccount(result.data, result.accountKey)
            setMode("home")
            setConnectDraft(connectCapability.defaultDraft())
            setConnectStep(0)
            setInputMessage(`Connected account ${result.accountKey}`)
          })
          .catch((error) => setInputMessage(`Connect failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => setConnectSaving(false))
        return
      }
      if (mode === "claude-env-scope") {
        if (claudeEnvAction === "set") {
          setClaudeEnvPresetIndex(0)
          setMode("claude-env-preset")
        } else {
          setMode("claude-env-unset-confirm")
        }
        return
      }
      if (mode === "claude-env-preset") {
        const preset = PRESET_OPTIONS[claudeEnvPresetIndex]
        if (preset?.key === "recommend") {
          setClaudeEnvDraft(recommendedClaudeEnvironment(providerMode))
          setClaudeEnvIndex(0)
          setMode("claude-env-editor")
          setInputMessage("Loaded recommended settings")
        } else if (preset?.key === "latest") {
          void readClaudeSettingsEnvAsDraft(claudeSettingsFile, providerMode)
            .then((draft) => {
              setMode((current) => {
                if (current !== "claude-env-preset") return current
                setClaudeEnvDraft(draft)
                setClaudeEnvIndex(0)
                setInputMessage("Loaded latest settings from " + claudeSettingsTarget)
                return "claude-env-editor"
              })
            })
            .catch(() => {
              setMode((current) => {
                if (current !== "claude-env-preset") return current
                setClaudeEnvIndex(0)
                setInputMessage("Could not read settings file, using current draft")
                return "claude-env-editor"
              })
            })
        } else {
          setClaudeEnvIndex(0)
          setMode("claude-env-editor")
        }
        return
      }
      if (mode === "claude-env-confirm") {
        setMode("home")
        setInputMessage("Claude settings updated")
        const outputRevision = beginCommandOutput()
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft, providerMode).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, activePort), shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutputForRevision(outputRevision, { title: `Set Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutputForRevision(outputRevision, { title: "Set Claude environment failed", output: error instanceof Error ? error.message : String(error) }))
        return
      }
      if (mode === "claude-env-unset-confirm") {
        setMode("home")
        setInputMessage("Claude settings env entries removed")
        const outputRevision = beginCommandOutput()
        void runClaudeEnvironmentUnset(claudeEnvDraft, shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutputForRevision(outputRevision, { title: `Unset Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutputForRevision(outputRevision, { title: "Unset Claude environment echo failed", output: error instanceof Error ? error.message : String(error) }))
        return
      }
      if (mode === "claude-env-editor") {
        setMode("claude-env-confirm")
        return
      }
      if (mode === "codex-fast-mode") {
        codexFastMode.saveSelection()
        setMode("home")
        setCommandIndex(0)
        return
      }
      if (mode === "account-selector") {
        const nextAccount = accounts[selectorIndex]
        if (!nextAccount) {
          setMode("home")
          setCommandIndex(0)
          setInputMessage("No account selected")
          return
        }
        setSelected(selectorIndex)
        setAccountKey(nextAccount.key)
        if (accountCapability && accountData) void accountCapability.persistActive(authFile, accountData, nextAccount.key).catch(() => {})
        setMode("home")
        setCommandIndex(0)
        setInputMessage(`Switched to ${nextAccount.name}`)
        return
      }
      const command = commands[commandIndex]
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
      if (command?.name === "/quit") {
        if (runtime.status === "running") runtime.server.stop(true)
        app.exit()
        return
      }
      if (command) {
        clearCommandOutput()
        if (command.name === "/switch-provider") {
          if (runtime.status === "starting" || switchingProvider) {
            setInputMessage("Provider switch already in progress")
            return
          }
          setMode("switch-provider")
          setCommandIndex(0)
          return
        }
        if (command.name === "/account") {
          if (!accountCapability) {
            setInputMessage("Account switching is not available for this provider")
            return
          }
          setSelectorIndex(selected)
          setMode("account-selector")
          return
        }
        if (command.name === "/logs") {
          requestLogModeRef.current = logsCaptureMode
          setLogsDetailOpen(false)
          setLogsDetailScroll(0)
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsAutoFollow(true)
          setLogsSelected(Math.max(0, requestLogs.length - 1))
          setMode("logs")
          setCommandIndex(0)
          setInputMessage("Showing request logs")
          return
        }
        if (command.name === "/codex-fast-mode") {
          codexFastMode.resetSelection()
          setMode("codex-fast-mode")
          setCommandIndex(0)
          setInputMessage("Select Codex fast mode")
          return
        }
        if (command.name === "/connect") {
          if (!connectCapability) {
            setInputMessage("Connect is not available for this provider")
            return
          }
          setConnectDraft(connectCapability.defaultDraft())
          setConnectSourceIndex(0)
          setConnectStep(0)
          setMode("connect-source")
          setCommandIndex(0)
          return
        }
        if (command.name === "/set-claude-env") {
          void readClaudeEnvironmentConfig(authFile, providerMode)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment(providerMode)))
          setClaudeEnvIndex(0)
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("set")
          setMode("claude-env-scope")
          setCommandIndex(0)
          return
        }
        if (command.name === "/unset-claude-env") {
          void readClaudeEnvironmentConfig(authFile, providerMode)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment(providerMode)))
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("unset")
          setMode("claude-env-scope")
          setCommandIndex(0)
          return
        }
        setInputMessage(`${command.name} selected · implementation pending`)
        setCommandIndex(0)
      }
      return
    }
    if (key.backspace || key.delete) {
      if (mode === "connect-account") {
        setConnectDraft((draft) => updateConnectDraft(draft, connectFields, connectStep, (value) => value.slice(0, -1)))
        return
      }
      if (mode === "claude-env-editor") {
        setClaudeEnvDraft((draft) => updateClaudeEnvDraft(draft, claudeEnvIndex, (value) => value.slice(0, -1)))
        return
      }
      return
    }
    if (mode === "account-selector") {
      if (key.upArrow && accounts.length) setSelectorIndex((value) => (value - 1 + accounts.length) % accounts.length)
      if (key.downArrow && accounts.length) setSelectorIndex((value) => (value + 1) % accounts.length)
      return
    }
    if (mode === "codex-fast-mode") {
      if (key.upArrow || key.downArrow) codexFastMode.setSelected((value) => (value + 1) % 2)
      return
    }
    if (mode === "connect-source") {
      if (key.upArrow) setConnectSourceIndex((value) => (value - 1 + 2) % 2)
      if (key.downArrow) setConnectSourceIndex((value) => (value + 1) % 2)
      return
    }
    if (mode === "logs") {
      if (logsDetailOpen) {
        const detailLog = visibleRequestLogs[logsSelected]
        const maxDetailScroll = detailLog ? requestLogDetailMaxScroll(detailLog, stdout.columns) : 0
        const scrollStep = key.pageUp || key.pageDown || key.meta ? REQUEST_LOG_DETAIL_FAST_SCROLL_STEP : REQUEST_LOG_DETAIL_SCROLL_STEP
        if (key.home) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll(0)
        }
        if (key.end) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll(maxDetailScroll)
        }
        if (key.upArrow || key.pageUp) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll((value) => Math.max(0, Math.min(value, maxDetailScroll) - scrollStep))
        }
        if (key.downArrow || key.pageDown) {
          setLogsCopyStatus(undefined)
          setLogsClearConfirm(false)
          setLogsDetailScroll((value) => Math.min(maxDetailScroll, value + scrollStep))
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
    if (mode === "claude-env-preset") {
      if (key.upArrow) setClaudeEnvPresetIndex((value) => (value - 1 + PRESET_OPTIONS.length) % PRESET_OPTIONS.length)
      if (key.downArrow) setClaudeEnvPresetIndex((value) => (value + 1) % PRESET_OPTIONS.length)
      return
    }
    if (mode === "claude-env-confirm") {
      if (input === "y") {
        setMode("home")
        setInputMessage("Claude settings updated")
        const outputRevision = beginCommandOutput()
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft, providerMode).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, activePort), shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutputForRevision(outputRevision, { title: `Set Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutputForRevision(outputRevision, { title: "Set Claude environment failed", output: error instanceof Error ? error.message : String(error) }))
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
        const outputRevision = beginCommandOutput()
        void runClaudeEnvironmentUnset(claudeEnvDraft, shell, { authFile, settingsFile: claudeSettingsFile })
          .then((output) => setCommandOutputForRevision(outputRevision, { title: `Unset Claude environment - ${claudeSettingsTarget}`, output }))
          .catch((error) => setCommandOutputForRevision(outputRevision, { title: "Unset Claude environment echo failed", output: error instanceof Error ? error.message : String(error) }))
      }
      if (input === "n") {
        setMode("home")
        setInputMessage("Claude environment unset cancelled")
      }
      return
    }
    if (mode === "claude-env-editor") {
      if (key.upArrow) setClaudeEnvIndex((value) => (value - 1 + ALL_EDITABLE_KEYS.length) % ALL_EDITABLE_KEYS.length)
      else if (key.downArrow) setClaudeEnvIndex((value) => (value + 1) % ALL_EDITABLE_KEYS.length)
      else if (input && !key.leftArrow && !key.rightArrow) setClaudeEnvDraft((draft) => updateClaudeEnvDraft(draft, claudeEnvIndex, (value) => `${value}${input}`))
      return
    }
    if (mode === "connect-account") {
      if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setConnectDraft((draft) => updateConnectDraft(draft, connectFields, connectStep, (value) => `${value}${input}`))
      }
      return
    }
    if (mode === "home") {
      if (key.upArrow) {
        clearCommandOutput()
        setCommandIndex((value) => (value - 1 + commands.length) % commands.length)
        return
      }
      if (key.downArrow) {
        clearCommandOutput()
        setCommandIndex((value) => (value + 1) % commands.length)
        return
      }
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginLeft={1}>
        <Text color="#d97757">─── </Text>
        <Box width={headerTextWidth}>
          <Text color="#aab3cf" wrap="truncate-end">{headerText}</Text>
        </Box>
        <Text color="#d97757"> ───</Text>
      </Box>
      <ProviderDashboard
        hostname={hostname}
        port={activePort}
        contentWidth={contentWidth}
        compact={dashboardCompact}
        innerWidth={dashboardInnerWidth}
        providerMode={providerMode}
        providerInfo={providerInfo}
        account={account}
        activeAccountInfo={activeAccountInfo}
        codexFastMode={codexFastMode.enabled}
        limitGroups={limitGroups}
        limitsLoading={limitsLoading}
        limitsError={limitsError}
      />
      {mode === "home" && <CommandInput selected={commandIndex} message={inputMessage} commands={commands} />}
      {mode === "account-selector" && accountCapability && <AccountSelector accounts={accounts} selected={selectorIndex} title={accountCapability.selectorTitle} description={accountCapability.selectorDescription} />}
      {mode === "codex-fast-mode" && providerMode === "codex" && <CodexFastModeSelector selected={codexFastMode.selected} current={codexFastMode.enabled} />}
      {mode === "connect-source" && connectCapability && <ConnectSourceSelector connect={connectCapability} selected={connectSourceIndex} saving={connectSaving} />}
      {mode === "connect-account" && connectCapability && <ConnectAccountWizard title={connectCapability.title} description={connectCapability.manualDescription} draft={connectDraft} fields={connectFields} step={connectStep} saving={connectSaving} />}
      {mode === "switch-provider" && <SwitchProviderConfirm currentLabel={providerInfo.label} targetLabel={switchTarget.label} />}
      {mode === "logs" && (
        <RequestLogsPanel
          logs={visibleRequestLogs}
          selected={logsSelected}
          autoFollow={logsAutoFollow}
          detailOpen={logsDetailOpen}
          detailScroll={logsDetailScroll}
          copyStatus={logsCopyStatus}
          clearConfirm={logsClearConfirm}
          fileError={logsFileError}
          requestLogMode={logsCaptureMode}
        />
      )}
      {mode === "claude-env-scope" && <ClaudeEnvironmentScopeSelector selected={claudeEnvScopeIndex} action={claudeEnvAction} />}
      {mode === "claude-env-preset" && <ClaudeEnvironmentPresetSelector selected={claudeEnvPresetIndex} settingsTarget={claudeSettingsTarget} />}
      {(mode === "claude-env-editor" || mode === "claude-env-confirm") && (
        <ClaudeEnvironmentEditor draft={claudeEnvDraft} selected={claudeEnvIndex} baseUrl={baseUrl(hostname, activePort)} confirm={mode === "claude-env-confirm"} shell={shell.kind === "unsupported" ? "posix" : shell.kind} settingsTarget={claudeSettingsTarget} />
      )}
      {mode === "claude-env-unset-confirm" && <ClaudeEnvironmentUnsetConfirm draft={claudeEnvDraft} shell={shell.kind === "unsupported" ? "posix" : shell.kind} settingsTarget={claudeSettingsTarget} />}
      {commandOutput && <CommandOutput title={commandOutput.title} output={commandOutput.output} />}
    </Box>
  )

  function applyConnectedAccount(data: ProviderAccountData, nextAccountKey: string) {
    const nextAccounts = accountCapability?.toAccounts(data) ?? []
    const nextSelected = Math.max(0, nextAccounts.findIndex((item) => item.key === nextAccountKey))
    setLoadError(undefined)
    setAccountData(data)
    setSelected(nextSelected)
    setAccountKey(nextAccounts[nextSelected]?.key)
    resetLimits({ loading: true })
    setAuthRevision((value) => value + 1)
  }
}

function updateConnectDraft(draft: ProviderConnectDraft, fields: ProviderConnectField[], step: number, update: (value: string) => string): ProviderConnectDraft {
  const key = fields[step]?.key
  if (!key) return draft
  return {
    ...draft,
    [key]: update(draft[key] ?? ""),
  }
}

function updateClaudeEnvDraft(draft: ClaudeEnvironmentDraft, index: number, update: (value: string) => string): ClaudeEnvironmentDraft {
  const key = ALL_EDITABLE_KEYS[index]
  if (!key) return draft
  // Model keys are top-level on the draft
  if ((CLAUDE_MODEL_ENV_KEYS as readonly string[]).includes(key)) {
    return {
      ...draft,
      [key]: update(draft[key as keyof ClaudeEnvironmentDraft] as string),
    }
  }
  // Extra editable keys live in draft.extraEnv
  return {
    ...draft,
    extraEnv: {
      ...draft.extraEnv,
      [key]: update(draft.extraEnv[key] ?? ""),
    },
  }
}

function baseUrl(hostname: string, port: number) {
  return `http://${hostname}:${port}`
}

function initialLogsCaptureMode(): Exclude<RequestLogMode, "off"> {
  const mode = process.env.REQUEST_LOG_MODE?.trim().toLowerCase()
  return mode === "sync" || mode === "live" || mode === "immediate" || mode === "1" ? "sync" : "async"
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

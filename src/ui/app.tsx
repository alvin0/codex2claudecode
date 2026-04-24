import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useMemo, useState } from "react"

import { readAccountInfoFile, refreshActiveAccountInfo, writeAccountInfoFile, writeActiveAccountInfo, type AccountInfo } from "../upstream/codex/account-info"
import { readAuthFileData } from "../upstream/codex/auth"
import { CodexStandaloneClient } from "../upstream/codex/client"
import { connectAccount, connectAccountFromCodexAuth, type ConnectAccountDraft } from "../upstream/codex/connect-account"
import { packageInfo } from "../app/package-info"
import { resolveAuthFile } from "../core/paths"
import { clearRequestLogs, MAX_REQUEST_LOG_ENTRIES, readRecentRequestLogs, readRequestLogDetail } from "../core/request-logs"
import { startRuntime } from "../app/runtime"
import type { RequestLogEntry } from "../core/types"
import type { AuthFileData } from "../upstream/codex/types"
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
import { ConnectSourceSelector } from "./components/connect-source-selector"
import { LimitsPanel } from "./components/limits-panel"
import { formatAllRequestLogs, formatRequestLogDetail, RequestLogsPanel } from "./components/request-logs-panel"
import { WelcomePanel } from "./components/welcome-panel"
import { usageToView, type LimitGroupView } from "./limits"
import type { RuntimeState } from "./types"

export function CodexCodeApp(props: { port?: number }) {
  const app = useApp()
  const authFile = resolveAuthFile(process.env.CODEX_AUTH_FILE)
  const hostname = process.env.HOST ?? "127.0.0.1"
  const port = props.port ?? Number(process.env.PORT || 8787)
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
    "home" | "account-selector" | "logs" | "claude-env-scope" | "claude-env-editor" | "claude-env-confirm" | "claude-env-unset-confirm" | "connect-source" | "connect-account"
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
  const [claudeEnvDraft, setClaudeEnvDraft] = useState<ClaudeEnvironmentDraft>(() => defaultClaudeEnvironment())
  const [claudeEnvIndex, setClaudeEnvIndex] = useState(0)
  const [claudeEnvScopeIndex, setClaudeEnvScopeIndex] = useState(0)
  const [claudeEnvAction, setClaudeEnvAction] = useState<"set" | "unset">("set")
  const [commandOutput, setCommandOutput] = useState<{ title: string; output: string }>()
  const shell = useMemo(() => detectShell(), [])
  const [connectDraft, setConnectDraft] = useState<ConnectAccountDraft>({ accountId: "", accessToken: "", refreshToken: "" })
  const [connectSourceIndex, setConnectSourceIndex] = useState(0)
  const [connectStep, setConnectStep] = useState(0)
  const [connectSaving, setConnectSaving] = useState(false)
  const [authRevision, setAuthRevision] = useState(0)
  const pkg = useMemo(() => packageInfo(), [])
  const activePort = runtime.status === "running" ? runtime.server.port : port
  const visibleRequestLogs = useMemo(
    () => requestLogs.map((log) => requestLogDetails[log.id] ?? log),
    [requestLogDetails, requestLogs],
  )

  const accounts = useMemo(() => (authData ? authDataToAccounts(authData) : []), [authData])
  const account = accounts[selected]
  const claudeEnvScopes: ClaudeSettingsScope[] = ["user", "project", "local"]
  const claudeEnvScope = claudeEnvScopes[claudeEnvScopeIndex] ?? "user"
  const claudeSettingsFile = claudeSettingsPathForScope(claudeEnvScope)
  const claudeSettingsTarget = claudeSettingsScopeLabel(claudeEnvScope)

  useEffect(() => {
    if (!logsCopyStatus) return
    const timer = setTimeout(() => setLogsCopyStatus(undefined), 2000)
    return () => clearTimeout(timer)
  }, [logsCopyStatus])

  useEffect(() => {
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
  }, [authFile])

  useEffect(() => {
    if (!account || loadError) return
    let active = true
    let server: ReturnType<typeof Bun.serve> | undefined
    setRequestLogs([])
    setRequestLogDetails({})
    setRuntime({ status: "starting" })
    startRuntime({
      authFile,
      authAccount: account.key,
      hostname,
      port,
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
  }, [account?.key, authFile, authRevision, hostname, loadError, port])

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

  useEffect(() => {
    if (!account || loadError) return
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
  }, [account?.key, authFile, authRevision, loadError])

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
      if (mode === "claude-env-scope") {
        setMode(claudeEnvAction === "set" ? "claude-env-editor" : "claude-env-unset-confirm")
        return
      }
      if (mode === "claude-env-confirm") {
        setMode("home")
        setInputMessage("Claude settings updated")
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft).catch((error) =>
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
      const commands = filterCommands(inputValue)
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
          setSelectorIndex(selected)
          setMode("account-selector")
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
          setConnectSourceIndex(0)
          setConnectStep(0)
          setMode("connect-source")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/set-claude-env") {
          void readClaudeEnvironmentConfig(authFile)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment()))
          setClaudeEnvIndex(0)
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("set")
          setMode("claude-env-scope")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/unset-claude-env") {
          void readClaudeEnvironmentConfig(authFile)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment()))
          setClaudeEnvScopeIndex(0)
          setClaudeEnvAction("unset")
          setMode("claude-env-scope")
          setInputValue("")
          setCommandIndex(0)
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
    if (mode === "connect-source") {
      if (key.upArrow) setConnectSourceIndex((value) => (value - 1 + 2) % 2)
      if (key.downArrow) setConnectSourceIndex((value) => (value + 1) % 2)
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
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft).catch((error) =>
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
    if (inputValue.startsWith("/") && key.upArrow) {
      const commands = filterCommands(inputValue)
      if (commands.length) setCommandIndex((value) => (value - 1 + commands.length) % commands.length)
      return
    }
    if (inputValue.startsWith("/") && key.downArrow) {
      const commands = filterCommands(inputValue)
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
        <WelcomePanel hostname={hostname} port={activePort} />
        <Box width={1} borderStyle="single" borderColor="#7f4f45" />
        <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
          <AccountInfoPanel account={account} info={activeAccountInfo} />
          <LimitsPanel limitGroups={limitGroups} loading={limitsLoading} error={limitsError} />
        </Box>
      </Box>
      {mode === "account-selector" && <AccountSelector accounts={accounts} selected={selectorIndex} />}
      {mode === "connect-source" && <ConnectSourceSelector selected={connectSourceIndex} saving={connectSaving} />}
      {mode === "logs" && (
        <>
          <CommandInput value={inputValue} message={inputMessage} selected={commandIndex} />
          <RequestLogsPanel
            logs={visibleRequestLogs}
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
      ) : (
        mode === "home" && <CommandInput value={inputValue} message={inputMessage} selected={commandIndex} />
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

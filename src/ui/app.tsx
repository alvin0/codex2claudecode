import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useMemo, useState } from "react"

import { readAccountInfoFile, refreshActiveAccountInfo, writeAccountInfoFile, writeActiveAccountInfo, type AccountInfo } from "../account-info"
import { readAuthFileData } from "../auth"
import { CodexStandaloneClient } from "../client"
import { connectAccount, connectAccountFromCodexAuth, type ConnectAccountDraft } from "../connect-account"
import { packageInfo } from "../package-info"
import { resolveAuthFile } from "../paths"
import { startRuntime } from "../runtime"
import type { AuthFileData, RequestLogEntry } from "../types"
import { authDataToAccounts, selectedAccountIndex } from "./accounts"
import {
  applyClaudeEnvironment,
  defaultClaudeEnvironment,
  detectShell,
  CLAUDE_MODEL_ENV_KEYS,
  readClaudeEnvironmentConfig,
  runClaudeEnvironmentSet,
  runClaudeEnvironmentUnset,
  unsetClaudeEnvironment,
  writeClaudeEnvironmentConfig,
  type ClaudeEnvironmentDraft,
} from "./claude-env"
import { filterCommands } from "./commands"
import { AccountInfoPanel } from "./components/account-info-panel"
import { AccountSelector } from "./components/account-selector"
import { ClaudeEnvironmentEditor } from "./components/claude-environment-editor"
import { ClaudeEnvironmentUnsetConfirm } from "./components/claude-environment-unset-confirm"
import { CommandInput } from "./components/command-input"
import { CommandOutput } from "./components/command-output"
import { ConnectAccountWizard } from "./components/connect-account-wizard"
import { ConnectSourceSelector } from "./components/connect-source-selector"
import { LimitsPanel } from "./components/limits-panel"
import { RequestLogsPanel } from "./components/request-logs-panel"
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
    "home" | "account-selector" | "logs" | "claude-env-editor" | "claude-env-confirm" | "claude-env-unset-confirm" | "connect-source" | "connect-account"
  >("home")
  const [selectorIndex, setSelectorIndex] = useState(0)
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>([])
  const [logsSelected, setLogsSelected] = useState(0)
  const [claudeEnvDraft, setClaudeEnvDraft] = useState<ClaudeEnvironmentDraft>(() => defaultClaudeEnvironment())
  const [claudeEnvIndex, setClaudeEnvIndex] = useState(0)
  const [commandOutput, setCommandOutput] = useState<{ title: string; output: string }>()
  const shell = useMemo(() => detectShell(), [])
  const [connectDraft, setConnectDraft] = useState<ConnectAccountDraft>({ accountId: "", accessToken: "", refreshToken: "" })
  const [connectSourceIndex, setConnectSourceIndex] = useState(0)
  const [connectStep, setConnectStep] = useState(0)
  const [connectSaving, setConnectSaving] = useState(false)
  const [authRevision, setAuthRevision] = useState(0)
  const pkg = useMemo(() => packageInfo(), [])

  const accounts = useMemo(() => (authData ? authDataToAccounts(authData) : []), [authData])
  const account = accounts[selected]

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
    setRuntime({ status: "starting" })
    startRuntime({
      authFile,
      authAccount: account.key,
      hostname,
      port,
      logBody: process.env.LOG_BODY !== "0",
      quiet: true,
      onRequestLog: (entry) => {
        setRequestLogs((logs) => [...logs.slice(-199), entry])
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
      if (mode === "claude-env-editor" || mode === "claude-env-confirm" || mode === "claude-env-unset-confirm") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
        setInputMessage(mode === "claude-env-unset-confirm" ? "Claude environment unset cancelled" : "Claude environment edit cancelled")
        return
      }
      if (mode === "logs") {
        setMode("home")
        setInputValue("")
        setCommandIndex(0)
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
      if (mode === "claude-env-confirm") {
        applyClaudeEnvironment(claudeEnvDraft, baseUrl(hostname, port))
        setMode("home")
        setInputMessage("Claude environment applied to current process")
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, port), shell, { authFile })
          .then((output) => setCommandOutput({ title: "Set Claude environment - env | grep ANTHROPIC", output }))
          .catch((error) => setCommandOutput({ title: "Set Claude environment failed", output: error instanceof Error ? error.message : String(error) }))
        return
      }
      if (mode === "claude-env-unset-confirm") {
        unsetClaudeEnvironment()
        setMode("home")
        setInputMessage("Claude environment unset")
        void runClaudeEnvironmentUnset(shell, { authFile })
          .then((output) => setCommandOutput({ title: "Unset Claude environment - env | grep ANTHROPIC", output }))
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
          if (shell.kind === "unsupported") {
            setInputMessage(shell.reason)
            setInputValue("")
            setCommandIndex(0)
            return
          }
          void readClaudeEnvironmentConfig(authFile)
            .then((draft) => setClaudeEnvDraft(draft))
            .catch(() => setClaudeEnvDraft(defaultClaudeEnvironment()))
          setClaudeEnvIndex(0)
          setMode("claude-env-editor")
          setInputValue("")
          setCommandIndex(0)
          return
        }
        if (command.name === "/unset-claude-env") {
          if (shell.kind === "unsupported") {
            setInputMessage(shell.reason)
            setInputValue("")
            setCommandIndex(0)
            return
          }
          setMode("claude-env-unset-confirm")
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
      if (key.upArrow) setLogsSelected((value) => Math.max(0, value - 1))
      if (key.downArrow) setLogsSelected((value) => Math.min(Math.max(0, requestLogs.length - 1), value + 1))
      return
    }
    if (mode === "claude-env-confirm") {
      if (input === "y") {
        applyClaudeEnvironment(claudeEnvDraft, baseUrl(hostname, port))
        setMode("home")
        setInputMessage("Claude environment applied to current process")
        void writeClaudeEnvironmentConfig(authFile, claudeEnvDraft).catch((error) =>
          setInputMessage(`Claude environment saved failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        void runClaudeEnvironmentSet(claudeEnvDraft, baseUrl(hostname, port), shell, { authFile })
          .then((output) => setCommandOutput({ title: "Set Claude environment - env | grep ANTHROPIC", output }))
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
        unsetClaudeEnvironment()
        setMode("home")
        setInputMessage("Claude environment unset")
        void runClaudeEnvironmentUnset(shell, { authFile })
          .then((output) => setCommandOutput({ title: "Unset Claude environment - env | grep ANTHROPIC", output }))
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
        <WelcomePanel hostname={hostname} port={port} />
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
          <RequestLogsPanel logs={requestLogs} selected={logsSelected} />
        </>
      )}
      {(mode === "claude-env-editor" || mode === "claude-env-confirm") ? (
        <ClaudeEnvironmentEditor draft={claudeEnvDraft} selected={claudeEnvIndex} baseUrl={baseUrl(hostname, port)} confirm={mode === "claude-env-confirm"} shell={shell.kind === "unsupported" ? "posix" : shell.kind} />
      ) : mode === "claude-env-unset-confirm" ? (
        <ClaudeEnvironmentUnsetConfirm shell={shell.kind === "unsupported" ? "posix" : shell.kind} />
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

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"

import { bootstrapRuntime } from "../../app/bootstrap"
import { writeProviderConfig } from "../../app/provider-config"
import { startRuntimeWithBootstrap } from "../../app/runtime"
import type { Upstream_Provider } from "../../core/interfaces"
import type { RequestLogEntry } from "../../core/types"
import { buildProviderInfo } from "../provider-info"
import type { ProviderInfo, ProviderMode, RuntimeState } from "../types"
import { fallbackProviderInfo, nextProviderDefinition, providerDefinition, resolveInitialProviderMode } from "./registry"

interface UseProviderRuntimeOptions {
  hostname: string
  port: number
  accountKey?: string
  authRevision: number
  loadError?: string
  onMessage: (message: string) => void
  onRequestLogsReset: () => void
  onRequestLogStart: (entry: RequestLogEntry) => void
  onRequestLog: (entry: RequestLogEntry) => void
}

interface SwitchProviderOptions {
  onBeforeApply?: (targetMode: ProviderMode, targetLabel: string) => void
}

export function useProviderRuntime(options: UseProviderRuntimeOptions) {
  const {
    hostname,
    port,
    accountKey,
    authRevision,
    loadError,
    onMessage,
    onRequestLogsReset,
    onRequestLogStart,
    onRequestLog,
  } = options
  const [providerReady, setProviderReady] = useState(false)
  const [providerMode, setProviderMode] = useState<ProviderMode>("codex")
  const [providerInfo, setProviderInfo] = useState<ProviderInfo>(() => fallbackProviderInfo("codex"))
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const [authFile, setAuthFile] = useState(() => providerDefinition("codex").authFile())
  const [runtime, setRuntime] = useState<RuntimeState>({ status: "starting" })
  const [upstream, setUpstream] = useState<Upstream_Provider>()
  const pendingProviderSwitch = useRef<{ previousMode: ProviderMode; targetMode: ProviderMode; targetLabel: string } | undefined>(undefined)
  const skipNextRuntimeStart = useRef(false)
  const lastRuntimeSignature = useRef<string | undefined>(undefined)

  useEffect(() => {
    let active = true
    void (async () => {
      const mode = await resolveInitialProviderMode()
      if (!active) return
      const provider = providerDefinition(mode)
      setAuthFile(provider.authFile())
      setProviderMode(mode)
      setProviderInfo(fallbackProviderInfo(mode))
      setProviderReady(true)
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!providerReady) return
    if (skipNextRuntimeStart.current) {
      skipNextRuntimeStart.current = false
      return
    }
    if (loadError) return
    if (providerMode === "codex" && !accountKey) return

    const provider = providerDefinition(providerMode)
    const context = { authFile, accountKey, authRevision }
    const runtimeSignature = provider.runtimeSignature(context)
    if (!pendingProviderSwitch.current && runtime.status === "running" && lastRuntimeSignature.current === runtimeSignature) return

    let active = true
    let server: ReturnType<typeof Bun.serve> | undefined
    onRequestLogsReset()
    setUpstream(undefined)
    setRuntime({ status: "starting" })

    async function startProviderRuntime() {
      let bootstrapSucceeded = false
      try {
        const bootstrapped = await bootstrapRuntime(provider.bootstrapOptions(context))
        bootstrapSucceeded = true

        const pendingSwitch = pendingProviderSwitch.current
        if (pendingSwitch?.targetMode === providerMode) void writeProviderConfig(providerMode)

        const nextServer = await startRuntimeWithBootstrap(
          {
            authFile: bootstrapped.authFile,
            authAccount: bootstrapped.authAccount,
            hostname,
            port,
            logBody: process.env.LOG_BODY !== "0",
            quiet: true,
            onRequestLogStart,
            onRequestLog,
          },
          async () => bootstrapped,
        )
        server = nextServer
        if (!active) {
          nextServer.stop(true)
          return
        }

        lastRuntimeSignature.current = runtimeSignature
        setAuthFile(bootstrapped.authFile)
        setProviderInfo(buildProviderInfo(providerMode, bootstrapped.upstream, bootstrapped.authFile))
        setUpstream(bootstrapped.upstream)
        setRuntime({ status: "running", server: nextServer, startedAt: Date.now() })
        if (pendingSwitch?.targetMode === providerMode) {
          pendingProviderSwitch.current = undefined
          setSwitchingProvider(false)
          onMessage(`Switched to ${pendingSwitch.targetLabel}`)
        }
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        const pendingSwitch = pendingProviderSwitch.current
        setUpstream(undefined)
        if (pendingSwitch?.targetMode === providerMode) {
          pendingProviderSwitch.current = undefined
          setSwitchingProvider(false)
          onMessage(`Switch to ${pendingSwitch.targetLabel} failed: ${message}`)
          if (!bootstrapSucceeded) {
            skipNextRuntimeStart.current = true
            setProviderMode(pendingSwitch.previousMode)
            setProviderInfo(fallbackProviderInfo(pendingSwitch.previousMode))
          }
        }
        setRuntime({ status: "error", error: message })
      }
    }

    void startProviderRuntime()
    return () => {
      active = false
      server?.stop(true)
    }
  }, [
    authFile,
    accountKey,
    authRevision,
    hostname,
    loadError,
    onMessage,
    onRequestLog,
    onRequestLogStart,
    onRequestLogsReset,
    port,
    providerMode,
    providerReady,
  ])

  const runningServer = runtime.status === "running" ? runtime.server : undefined
  const switchProvider = useCallback(async (switchOptions: SwitchProviderOptions = {}) => {
    const target = nextProviderDefinition(providerMode)

    setSwitchingProvider(true)
    onMessage(`Validating ${target.label} credentials...`)

    try {
      await target.validate()
    } catch (error) {
      onMessage(target.validationError(error))
      setSwitchingProvider(false)
      return
    }

    pendingProviderSwitch.current = { previousMode: providerMode, targetMode: target.mode, targetLabel: target.label }
    setRuntime({ status: "starting" })
    setUpstream(undefined)
    switchOptions.onBeforeApply?.(target.mode, target.label)
    onMessage(`Switching to ${target.label}...`)

    if (runningServer) {
      try {
        runningServer.stop(true)
      } catch {
        // Best-effort stop; the runtime effect cleanup will also run.
      }
    }

    setAuthFile(target.authFile())
    setProviderMode(target.mode)
  }, [onMessage, providerMode, runningServer])

  const setRuntimeError = useCallback((error: string) => {
    setRuntime({ status: "error", error })
  }, [])

  return {
    authFile,
    providerReady,
    providerMode,
    providerInfo,
    runtime,
    setProviderInfo: setProviderInfo as Dispatch<SetStateAction<ProviderInfo>>,
    setRuntimeError,
    switchingProvider,
    switchProvider,
    upstream,
  }
}

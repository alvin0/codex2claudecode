import { useCallback, useEffect, useState } from "react"

import type { AccountInfo } from "../../upstream/codex/account-info"
import type { Upstream_Provider } from "../../core/interfaces"
import type { LimitGroupView } from "../limits"
import type { ProviderMode, RuntimeState } from "../types"
import { refreshCodexLimits } from "./codex"
import { refreshKiroLimits } from "./kiro"

const LIMITS_REFRESH_INTERVAL_MS = 5 * 60_000

interface UseProviderLimitsOptions {
  authFile: string
  authRevision: number
  accountKey?: string
  loadError?: string
  providerMode: ProviderMode
  providerReady: boolean
  runtimeStatus: RuntimeState["status"]
  upstream?: Upstream_Provider
  onKiroInfo: (patch: { subscriptionTier?: string; email?: string }) => void
  onMessage: (message: string) => void
}

interface LimitsState {
  activeAccountInfo?: AccountInfo
  limitGroups: LimitGroupView[]
  limitsLoading: boolean
  limitsError?: string
}

export function useProviderLimits(options: UseProviderLimitsOptions) {
  const {
    authFile,
    accountKey,
    authRevision,
    loadError,
    providerMode,
    providerReady,
    runtimeStatus,
    upstream,
    onKiroInfo,
    onMessage,
  } = options
  const [limitsState, setLimitsState] = useState<LimitsState>({
    limitGroups: [],
    limitsLoading: false,
  })

  const resetLimits = useCallback((resetOptions: { loading?: boolean } = {}) => {
    setLimitsState({ limitGroups: [], limitsLoading: Boolean(resetOptions.loading) })
  }, [])

  useEffect(() => {
    if (!providerReady) return

    if (providerMode === "kiro") {
      if (runtimeStatus !== "running" || !upstream) {
        resetLimits()
        return
      }
      const kiroUpstream = upstream

      let active = true
      async function refreshKiro() {
        try {
          setLimitsState((state) => ({ ...state, limitsLoading: true, limitsError: undefined }))
          const snapshot = await refreshKiroLimits(kiroUpstream)
          if (!active) return
          if (!snapshot) {
            resetLimits()
            return
          }
          setLimitsState({ limitGroups: snapshot.limitGroups, limitsLoading: false })
          if (snapshot.tier || snapshot.email) {
            onKiroInfo({
              ...(snapshot.tier ? { subscriptionTier: snapshot.tier } : {}),
              ...(snapshot.email ? { email: snapshot.email } : {}),
            })
          }
        } catch (error) {
          if (!active) return
          setLimitsState({ limitGroups: [], limitsLoading: false, limitsError: error instanceof Error ? error.message : "Network error" })
        }
      }

      void refreshKiro()
      const timer = setInterval(() => void refreshKiro(), LIMITS_REFRESH_INTERVAL_MS)
      return () => {
        active = false
        clearInterval(timer)
      }
    }

    if (providerMode !== "codex") {
      resetLimits()
      return
    }
    if (!accountKey || loadError) {
      resetLimits()
      return
    }
    const activeAccountKey = accountKey

    let active = true
    async function refreshCodex() {
      try {
        setLimitsState((state) => ({ ...state, limitsLoading: true, limitsError: undefined }))
        const snapshot = await refreshCodexLimits(authFile, activeAccountKey)
        if (!active) return
        setLimitsState({ activeAccountInfo: snapshot.accountInfo, limitGroups: snapshot.limitGroups, limitsLoading: false })
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setLimitsState((state) => ({ ...state, limitsLoading: false, limitsError: message }))
        onMessage(`Account refresh failed: ${message}`)
      }
    }

    void refreshCodex()
    const timer = setInterval(() => void refreshCodex(), LIMITS_REFRESH_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [
    accountKey,
    authFile,
    authRevision,
    loadError,
    onKiroInfo,
    onMessage,
    providerMode,
    providerReady,
    runtimeStatus,
    upstream,
    resetLimits,
  ])

  return {
    activeAccountInfo: limitsState.activeAccountInfo,
    limitGroups: limitsState.limitGroups,
    limitsLoading: limitsState.limitsLoading,
    limitsError: limitsState.limitsError,
    resetLimits,
  }
}

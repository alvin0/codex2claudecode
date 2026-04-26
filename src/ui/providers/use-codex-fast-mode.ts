import { useCallback, useEffect, useState } from "react"

import { readCodexFastModeConfig, writeCodexFastModeConfig } from "../../upstream/codex/fast-mode"
import type { ProviderMode } from "../types"

interface UseCodexFastModeOptions {
  authFile: string
  providerMode: ProviderMode
  providerReady: boolean
  onMessage: (message: string) => void
}

export function useCodexFastMode(options: UseCodexFastModeOptions) {
  const { authFile, providerMode, providerReady, onMessage } = options
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState(1)

  useEffect(() => {
    if (!providerReady) return
    if (providerMode !== "codex") {
      setEnabled(false)
      setSelected(1)
      return
    }

    let active = true
    void readCodexFastModeConfig(authFile)
      .then((config) => {
        if (!active) return
        setEnabled(config.enabled)
        setSelected(config.enabled ? 0 : 1)
      })
      .catch(() => {
        if (!active) return
        setEnabled(false)
        setSelected(1)
      })
    return () => {
      active = false
    }
  }, [authFile, providerMode, providerReady])

  const resetSelection = useCallback(() => {
    setSelected(enabled ? 0 : 1)
  }, [enabled])

  const saveSelection = useCallback(() => {
    const nextEnabled = selected === 0
    setEnabled(nextEnabled)
    onMessage(`Codex fast mode ${nextEnabled ? "ON" : "OFF"}`)
    void writeCodexFastModeConfig(authFile, { enabled: nextEnabled }).catch((error) =>
      onMessage(`Codex fast mode save failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }, [authFile, onMessage, selected])

  return {
    enabled,
    selected,
    setSelected,
    resetSelection,
    saveSelection,
  }
}

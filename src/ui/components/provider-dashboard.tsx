import React from "react"
import { Box, Text } from "ink"

import type { AccountInfo } from "../../upstream/codex/account-info"
import type { LimitGroupView } from "../limits"
import type { AccountView, ProviderInfo, ProviderMode } from "../types"
import { AccountInfoPanel } from "./account-info-panel"
import { CodexFastModeStatus } from "./codex-fast-mode"
import { LimitsPanel } from "./limits-panel"
import { WelcomePanel } from "./welcome-panel"

export function ProviderDashboard(props: {
  hostname: string
  port: number
  contentWidth: number
  compact: boolean
  innerWidth: number
  providerMode: ProviderMode
  providerInfo: ProviderInfo
  account?: AccountView
  activeAccountInfo?: AccountInfo
  codexFastMode: boolean
  limitGroups: LimitGroupView[]
  limitsLoading: boolean
  limitsError?: string
  apiPassword?: string
}) {
  const leftWidth = props.compact ? props.innerWidth : 42
  const detailsWidth = props.compact ? props.innerWidth : Math.min(58, Math.max(42, props.contentWidth - 48))

  return (
    <Box
      borderStyle="round"
      borderColor="#d97757"
      minHeight={props.compact ? undefined : 13}
      width={props.compact ? props.contentWidth : undefined}
      alignSelf={props.compact ? undefined : "flex-start"}
      flexDirection={props.compact ? "column" : "row"}
    >
      <WelcomePanel hostname={props.hostname} port={props.port} compact={props.compact} width={leftWidth} providerMode={props.providerMode} apiPassword={props.apiPassword} />
      {props.compact ? (
        <Text color="#7f4f45">{"─".repeat(props.innerWidth)}</Text>
      ) : (
        <Box width={1} borderStyle="single" borderColor="#7f4f45" />
      )}
      <Box flexDirection="column" paddingX={props.compact ? 1 : 2} marginTop={props.compact ? 1 : 0} width={detailsWidth}>
        <AccountInfoPanel account={props.account} info={props.activeAccountInfo} providerMode={props.providerMode} kiroInfo={props.providerInfo.mode === "kiro" ? props.providerInfo : undefined} />
        {props.providerMode === "codex" && <CodexFastModeStatus enabled={props.codexFastMode} />}
        <LimitsPanel limitGroups={props.limitGroups} loading={props.limitsLoading} error={props.limitsError} compact={props.compact} width={detailsWidth} providerMode={props.providerMode} />
      </Box>
    </Box>
  )
}

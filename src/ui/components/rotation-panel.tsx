import { Box, Text } from "ink"

import type { RotationAccountView, RotationView } from "../rotation"

const STATUS_COLOR: Record<RotationAccountView["status"], string> = {
  active: "#98c379",
  ready: "#aab3cf",
  resting: "#e5c07b",
}

/** Why it is resting and how much quota it has left, whichever of the two is known. */
function accountDetail(account: RotationAccountView) {
  return [account.detail, account.quota].filter(Boolean).join(" · ")
}

/**
 * Replaces the single-account info and limits panels while rotation is on: with a
 * pool in play, the active account alone no longer describes the runtime.
 */
export function RotationAccountsPanel(props: { view: RotationView; width?: number; loading?: boolean }) {
  const keyWidth = Math.min(28, Math.max(12, ...props.view.accounts.map((account) => account.key.length)))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="#a58a86">Rotation </Text>
        <Text bold color="#d97757">ON</Text>
        <Text color="gray"> · {props.view.accounts.length} accounts · {props.view.restingCount} resting</Text>
      </Box>

      {props.view.accounts.map((account) => (
        <Box key={account.key} flexDirection="column">
          <Box>
            <Box width={2}>
              <Text color={account.status === "active" ? "#d97757" : "gray"}>{account.status === "active" ? "›" : " "}</Text>
            </Box>
            <Box width={keyWidth + 1}>
              <Text color={account.status === "resting" ? "gray" : "#c0caf5"} wrap="truncate-end">{account.key}</Text>
            </Box>
            <Text color={STATUS_COLOR[account.status]}>{account.status}</Text>
          </Box>
          {accountDetail(account) && (
            <Box marginLeft={2}>
              <Text color="gray" wrap="truncate-end">{accountDetail(account)}</Text>
            </Box>
          )}
        </Box>
      ))}

      {props.loading && props.view.accounts.every((account) => !account.quota) && (
        <Text color="gray">Loading quota…</Text>
      )}
    </Box>
  )
}

/** One-line dashboard status shown whenever the pool is not being listed in full. */
export function RotationStatus(props: { view?: RotationView }) {
  if (!props.view) return null

  const accounts = props.view.accounts.length
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text bold color="#a58a86">Rotation: </Text>
        <Text bold color={props.view.enabled ? "#d97757" : "gray"}>{props.view.enabled ? "ON" : "OFF"}</Text>
        <Text color="gray"> · {accounts} account{accounts === 1 ? "" : "s"}</Text>
      </Box>
      {props.view.enabled && !props.view.rotatable && (
        <Text color="#e5c07b" wrap="truncate-end">Idle until a second account is connected</Text>
      )}
    </Box>
  )
}

export function RotationSelector(props: { selected: number; view?: RotationView; loading?: boolean }) {
  const options = [
    { label: "on", description: "Retry on the next account when one fails" },
    { label: "off", description: "Fail the request on the active account" },
  ]

  return (
    <Box borderStyle="round" borderColor="#7f4f45" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="#d97757">Account rotation</Text>

      {props.view ? (
        <Text color="gray">Current: {props.view.enabled ? "on" : "off"} · active {props.view.activeAccount}</Text>
      ) : (
        <Text color="#e5c07b">No account is connected yet. Add one with /connect.</Text>
      )}
      {props.view && !props.view.rotatable && (
        <Text color="#e5c07b">Only one account connected — rotation stays idle until you add another.</Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {options.map((option, index) => (
          <Box key={option.label}>
            <Box width={3}>
              <Text color={props.selected === index ? "#d97757" : "gray"}>{props.selected === index ? ">" : " "}</Text>
            </Box>
            <Box width={8}>
              <Text bold={props.selected === index}>{option.label}</Text>
            </Box>
            <Text color="#aab3cf">{option.description}</Text>
          </Box>
        ))}
      </Box>

      {props.view && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#7aa2f7">{"── Accounts ──"}</Text>
          {props.view.accounts.map((account) => (
            <Box key={account.key}>
              <Box width={30}>
                <Text color={account.status === "resting" ? "gray" : "#c0caf5"} wrap="truncate-end">  {account.key}</Text>
              </Box>
              <Box width={10}>
                <Text color={STATUS_COLOR[account.status]}>{account.status}</Text>
              </Box>
              <Text color="gray" wrap="truncate-end">{accountDetail(account) || (props.loading ? "loading…" : "")}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑/↓ move · Enter apply · Esc cancel</Text>
      </Box>
    </Box>
  )
}

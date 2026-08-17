import type { Canonical_Request } from "../core/canonical"
import type { ProviderModelDescriptor, UpstreamResult, Upstream_Provider } from "../core/interfaces"
import type { ProviderMode } from "../core/provider-state"
import {
  cooldownUntil,
  isCoolingDown,
  parseQuotaAvailable,
  parseQuotaResetAt,
  QUOTA_PROBE_INTERVAL_MS,
  rotationReason,
  type AccountCooldown,
  type AccountCooldownMap,
  type RotationReason,
} from "../core/rotation"
import type { JsonObject, RequestOptions } from "../core/types"
import { readAccountCooldowns, writeAccountCooldowns } from "./account-cooldowns"
import type { AccountRoster } from "./account-roster"

export interface RotationEvent {
  from: string
  to?: string
  reason: RotationReason
  status: number
  until?: number
  resetSource?: "upstream" | "default"
}

export interface RotatingUpstreamOptions {
  mode: ProviderMode
  roster: AccountRoster
  create: (accountKey: string) => Promise<Upstream_Provider>
  /** Rotation is installed whenever several accounts exist, but only rotates while enabled. */
  enabled?: boolean
  cooldowns?: AccountCooldownMap
  cachePath?: string
  onRotate?: (event: RotationEvent) => void
}

/**
 * Serves requests from the active account and moves to the next connected account
 * when the upstream reports an account-level failure (bad auth, exhausted quota,
 * upstream 5xx). The account that failed rests until its reset time, and the
 * account that succeeds becomes the persisted active one.
 *
 * Only failures that surface before the response body does can be rotated — once a
 * stream has started, its errors belong to the caller.
 */
export interface RotatingUpstreamView {
  enabled: boolean
  accounts: string[]
  activeAccount: string
  accountCooldowns: AccountCooldownMap
  setEnabled: (enabled: boolean) => void
  readAccountUsage: () => Promise<Record<string, unknown>>
}

export function asRotatingUpstream(upstream: unknown): RotatingUpstreamView | undefined {
  return upstream instanceof Rotating_Upstream_Provider ? upstream : undefined
}

export class Rotating_Upstream_Provider implements Upstream_Provider {
  readonly providerKind: Upstream_Provider["providerKind"]

  private readonly options: RotatingUpstreamOptions
  private readonly instances = new Map<string, Promise<Upstream_Provider>>()
  private cooldowns: AccountCooldownMap
  private active: string
  private current: Upstream_Provider
  private rotationEnabled: boolean

  private constructor(options: RotatingUpstreamOptions, active: string, current: Upstream_Provider, cooldowns: AccountCooldownMap) {
    this.options = options
    this.active = active
    this.current = current
    this.cooldowns = cooldowns
    this.rotationEnabled = options.enabled ?? false
    this.providerKind = current.providerKind
    this.instances.set(active, Promise.resolve(current))
  }

  static async create(options: RotatingUpstreamOptions, active: string, current: Upstream_Provider) {
    const cooldowns = options.cooldowns ?? (await readAccountCooldowns(options.mode, options.cachePath))
    return new Rotating_Upstream_Provider(options, active, current, cooldowns)
  }

  get enabled() {
    return this.rotationEnabled
  }

  setEnabled(enabled: boolean) {
    this.rotationEnabled = enabled
  }

  get accounts() {
    return this.options.roster.accounts
  }

  get activeAccount() {
    return this.active
  }

  get accountCooldowns(): AccountCooldownMap {
    return this.cooldowns
  }

  /** Usage payload per account, for showing the whole pool's quota rather than only the active one. */
  async readAccountUsage(): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      this.options.roster.accounts.map(async (account) => [account, await this.readUsage(account)] as const),
    )
    return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined))
  }

  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    if (!this.rotationEnabled) return this.current.proxy(request, options)

    const attempted = new Set<string>()
    let lastError: UpstreamResult | undefined

    for (;;) {
      const account = await this.nextAccount(attempted)
      if (!account) return lastError ?? this.exhaustedError()

      attempted.add(account)
      const upstream = await this.instance(account).catch(() => undefined)
      if (!upstream) continue

      const result = await upstream.proxy(request, options)
      if (result.type !== "canonical_error") {
        await this.accept(account, upstream)
        return result
      }

      const reason = rotationReason(result.status, result.body)
      if (!reason) {
        await this.accept(account, upstream)
        return result
      }

      lastError = result
      await this.penalize(account, reason, result.status, upstream, result.body)
    }
  }

  checkHealth(timeoutMs: number) {
    return this.current.checkHealth(timeoutMs)
  }

  inputTokens(request: Canonical_Request, options?: RequestOptions) {
    if (!this.current.inputTokens) throw new Error("Upstream does not support input token counting")
    return this.current.inputTokens(request, options)
  }

  usage(options?: RequestOptions) {
    if (!this.current.usage) throw new Error("Upstream does not support usage")
    return this.current.usage(options)
  }

  environments(options?: RequestOptions) {
    if (!this.current.environments) throw new Error("Upstream does not support environments")
    return this.current.environments(options)
  }

  modelsRaw(options?: RequestOptions) {
    if (!this.current.modelsRaw) throw new Error("Upstream does not support raw model listing")
    return this.current.modelsRaw(options)
  }

  listModelDescriptors(): Promise<Array<string | ProviderModelDescriptor>> {
    if (!this.current.listModelDescriptors) return Promise.resolve([])
    return this.current.listModelDescriptors()
  }

  embeddingsRaw(body: JsonObject, options?: RequestOptions) {
    if (!this.current.embeddingsRaw) throw new Error("Upstream does not support embeddings")
    return this.current.embeddingsRaw(body, options)
  }

  /** Active account first, then the rest, skipping accounts that are still resting. */
  private async nextAccount(attempted: Set<string>) {
    const candidates = [this.active, ...this.options.roster.accounts].filter(
      (account, index, all) => account && all.indexOf(account) === index && !attempted.has(account),
    )
    if (candidates.length === 0) return undefined

    const now = Date.now()
    for (const account of candidates) {
      if (!isCoolingDown(this.cooldowns[account], now)) return account
      if (await this.quotaRecovered(account, now)) return account
    }

    // Everything is resting: take whichever wakes up first rather than hard-failing.
    return candidates.sort((left, right) => (this.cooldowns[left]?.until ?? 0) - (this.cooldowns[right]?.until ?? 0))[0]
  }

  /**
   * Providers sometimes refill quota ahead of the reset they reported, so a resting
   * account is re-probed on an interval instead of being trusted blindly.
   */
  private async quotaRecovered(account: string, now: number) {
    const cooldown = this.cooldowns[account]
    if (!cooldown || cooldown.reason !== "quota") return false
    if (now - (cooldown.lastProbeAt ?? cooldown.since) < QUOTA_PROBE_INTERVAL_MS) return false

    await this.patchCooldown(account, { lastProbeAt: now })

    const usage = await this.readUsage(account)
    if (usage === undefined || parseQuotaAvailable(usage) !== true) return false

    await this.clearCooldown(account)
    return true
  }

  private async accept(account: string, upstream: Upstream_Provider) {
    if (this.cooldowns[account]) await this.clearCooldown(account)
    if (account === this.active) return

    this.active = account
    this.current = upstream
    await this.options.roster.persistActive(account).catch(() => undefined)
  }

  private async penalize(account: string, reason: RotationReason, status: number, upstream: Upstream_Provider, detail?: string) {
    const now = Date.now()
    const resetAt = reason === "quota" ? parseQuotaResetAt(await this.readUsage(account, upstream), now) : undefined
    const { until, resetSource } = cooldownUntil(reason, now, resetAt)

    const cooldown: AccountCooldown = {
      account,
      reason,
      status,
      since: now,
      until,
      resetSource,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    }

    await this.saveCooldowns({ ...this.cooldowns, [account]: cooldown })
    this.options.onRotate?.({ from: account, reason, status, until, resetSource })
  }

  private async readUsage(account: string, upstream?: Upstream_Provider) {
    const provider = upstream ?? (await this.instance(account).catch(() => undefined))
    if (!provider?.usage) return undefined
    try {
      const response = await provider.usage()
      if (!response.ok) return undefined
      return (await response.json()) as unknown
    } catch {
      return undefined
    }
  }

  private instance(account: string) {
    const existing = this.instances.get(account)
    if (existing) return existing
    const created = this.options.create(account)
    this.instances.set(account, created)
    created.catch(() => this.instances.delete(account))
    return created
  }

  private async patchCooldown(account: string, patch: Partial<AccountCooldown>) {
    const cooldown = this.cooldowns[account]
    if (!cooldown) return
    await this.saveCooldowns({ ...this.cooldowns, [account]: { ...cooldown, ...patch } })
  }

  private async clearCooldown(account: string) {
    const { [account]: _removed, ...rest } = this.cooldowns
    await this.saveCooldowns(rest)
  }

  private async saveCooldowns(cooldowns: AccountCooldownMap) {
    this.cooldowns = cooldowns
    await writeAccountCooldowns(this.options.mode, cooldowns, this.options.cachePath).catch(() => undefined)
  }

  private exhaustedError(): UpstreamResult {
    return {
      type: "canonical_error",
      status: 503,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ error: { message: `All ${this.options.mode} accounts are unavailable`, type: "account_rotation_exhausted" } }),
    }
  }
}

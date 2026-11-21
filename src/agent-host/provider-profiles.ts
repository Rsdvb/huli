// Huli: the agents' API provider profiles main sends with the keys, held only in memory. A session
// started with one gets its address, models and key; clients see the profiles without their keys.

import type { ProviderBalance } from '@shared/agent-host'
import { isAgentId, type AgentId } from '@shared/agents'
import {
  balanceVendor,
  isProfileId,
  isProviderPresetId,
  keyEnd,
  MAX_PROFILES,
  profileProblem,
  takesProfiles,
  type AgentProfiles,
  type ProfileBalance,
  type ProfileBalanceVendor,
  type StoredProfile,
} from '@shared/provider-profiles'
import { readDeepSeekKeyBalance } from './vendor-usage/deepseek'
import { readMoonshotBalance } from './vendor-usage/moonshot'
import type { SignInPlace } from './vendor-usage/stored-sign-in'

/** How often a look at the balances reads them again, at most, unless the user asks. */
const BALANCE_MS = 60_000

/** How a balance read reaches the vendors, for tests. */
export interface BalanceReach {
  now(): number
  fetch?: typeof globalThis.fetch
}

/** Reads a key's balance from the vendor, through its documented endpoint only. */
function readVendor(
  vendor: ProfileBalanceVendor,
  key: string,
  place: SignInPlace,
): Promise<ProviderBalance[]> {
  if (vendor === 'deepseek') return readDeepSeekKeyBalance(place, key)
  return readMoonshotBalance(place, key, vendor === 'moonshot-cn' ? 'cn' : 'intl')
}

interface Held {
  items: StoredProfile[]
  defaultId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A profile as main sent it, checked again; null for one that is not whole. */
function profileOf(raw: unknown): StoredProfile | null {
  if (!isRecord(raw) || !isProfileId(raw.id) || !isProviderPresetId(raw.preset)) return null
  const { name, baseUrl, model, fastModel, key } = raw
  if (typeof name !== 'string' || typeof baseUrl !== 'string' || typeof key !== 'string') {
    return null
  }
  const profile: StoredProfile = {
    id: raw.id,
    name,
    preset: raw.preset,
    baseUrl,
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(typeof fastModel === 'string' && fastModel ? { fastModel } : {}),
    key,
  }
  return profileProblem(profile) === null ? profile : null
}

export class ProviderProfiles {
  private held = new Map<AgentId, Held>()
  /** The vendors' last answers, by agent and profile; dropped when the profile changes. */
  private balances = new Map<AgentId, Map<string, ProfileBalance>>()
  private reads = new Map<AgentId, Promise<boolean>>()
  private readAt = new Map<AgentId, number>()

  constructor(private readonly reach: BalanceReach = { now: Date.now }) {}

  /**
   * Takes main's profiles in place of those before, dropping any that is not whole; answers the
   * agents whose profiles changed, with the profiles edited or removed. Undefined, from a parent
   * older than profiles, keeps none.
   */
  set(raw: unknown): { agentId: AgentId; profileIds: string[] }[] {
    const next = new Map<AgentId, Held>()
    if (isRecord(raw)) {
      for (const [agentId, entry] of Object.entries(raw)) {
        if (!isAgentId(agentId) || !takesProfiles(agentId) || !isRecord(entry)) continue
        if (!Array.isArray(entry.items)) continue
        const items: StoredProfile[] = []
        for (const item of entry.items.slice(0, MAX_PROFILES)) {
          const profile = profileOf(item)
          if (profile && !items.some((each) => each.id === profile.id)) items.push(profile)
        }
        if (items.length === 0) continue
        const defaultId =
          typeof entry.defaultId === 'string' && items.some((each) => each.id === entry.defaultId)
            ? entry.defaultId
            : null
        next.set(agentId, { items, defaultId })
      }
    }
    const changed = [...new Set([...this.held.keys(), ...next.keys()])].filter(
      (agentId) => JSON.stringify(this.held.get(agentId)) !== JSON.stringify(next.get(agentId)),
    )
    for (const agentId of changed) {
      const kept = this.balances.get(agentId)
      if (!kept) continue
      const before = this.held.get(agentId)?.items ?? []
      const after = next.get(agentId)?.items ?? []
      for (const profileId of [...kept.keys()]) {
        const was = before.find((each) => each.id === profileId)
        const now = after.find((each) => each.id === profileId)
        if (!now || !was || was.key !== now.key || balanceVendor(now) === null) {
          kept.delete(profileId)
        }
      }
      // A changed key is read again at the next look.
      this.readAt.delete(agentId)
    }
    const before = this.held
    this.held = next
    return changed.map((agentId) => {
      const now = next.get(agentId)?.items ?? []
      const profileIds = (before.get(agentId)?.items ?? [])
        .filter((was) => {
          const kept = now.find((each) => each.id === was.id)
          return !kept || JSON.stringify(kept) !== JSON.stringify(was)
        })
        .map((was) => was.id)
      return { agentId, profileIds }
    })
  }

  /** What the vendors last told of the agent's profiles' balances. */
  balancesOf(agentId: AgentId): ProfileBalance[] {
    const kept = this.balances.get(agentId)
    const items = this.held.get(agentId)?.items ?? []
    return items.flatMap((profile) => {
      const balance = kept?.get(profile.id)
      return balance ? [balance] : []
    })
  }

  /**
   * Asks the vendors of the agent's profiles that have a balance API, at most once a minute
   * unless `force`; resolves to whether anything it tells changed. A failed read keeps the
   * balance read before and says why; the message never holds the key.
   */
  readBalances(agentId: AgentId, force: boolean): Promise<boolean> {
    const running = this.reads.get(agentId)
    if (running) return running
    const items = (this.held.get(agentId)?.items ?? []).flatMap((profile) => {
      const vendor = balanceVendor(profile)
      return vendor ? [{ profile, vendor }] : []
    })
    if (items.length === 0) return Promise.resolve(false)
    const at = this.readAt.get(agentId)
    if (!force && at !== undefined && this.reach.now() - at < BALANCE_MS) {
      return Promise.resolve(false)
    }
    this.readAt.set(agentId, this.reach.now())
    const read = Promise.all(
      items.map(async ({ profile, vendor }) => {
        const place: SignInPlace = {
          env: {},
          home: '',
          platform: process.platform as SignInPlace['platform'],
          now: this.reach.now(),
          ...(this.reach.fetch ? { fetch: this.reach.fetch } : {}),
        }
        const before = this.balances.get(agentId)?.get(profile.id)
        let next: ProfileBalance
        try {
          const balances = await readVendor(vendor, profile.key, place)
          next = { profileId: profile.id, balances, observedAt: place.now, error: null }
        } catch (error) {
          next = {
            profileId: profile.id,
            balances: before?.balances ?? [],
            observedAt: before?.observedAt ?? place.now,
            error: (error as Error).message,
          }
        }
        // A profile removed or given another key while it was read keeps nothing of the read.
        if (this.get(agentId, profile.id)?.key !== profile.key) return false
        const kept = this.balances.get(agentId) ?? new Map<string, ProfileBalance>()
        this.balances.set(agentId, kept)
        const changed = JSON.stringify(before) !== JSON.stringify(next)
        kept.set(profile.id, next)
        return changed
      }),
    )
      .then((changes) => changes.some(Boolean))
      .finally(() => this.reads.delete(agentId))
    this.reads.set(agentId, read)
    return read
  }

  /** What a client sees of the agent's profiles; null for an agent whose sessions take none. */
  view(agentId: AgentId): AgentProfiles | null {
    if (!takesProfiles(agentId)) return null
    const held = this.held.get(agentId)
    return {
      items: (held?.items ?? []).map((profile) => ({
        id: profile.id,
        name: profile.name,
        preset: profile.preset,
        baseUrl: profile.baseUrl,
        model: profile.model ?? null,
        fastModel: profile.fastModel ?? null,
        keyEnd: keyEnd(profile.key),
      })),
      defaultId: held?.defaultId ?? null,
    }
  }

  get(agentId: AgentId, profileId: string): StoredProfile | null {
    return this.held.get(agentId)?.items.find((profile) => profile.id === profileId) ?? null
  }

  /** The profile the agent's new sessions start with; null for its own sign-in. */
  defaultOf(agentId: AgentId): string | null {
    return this.held.get(agentId)?.defaultId ?? null
  }

  /** Every profile with its agent, for reading the vendors' balances. */
  all(): { agentId: AgentId; profile: StoredProfile }[] {
    return [...this.held].flatMap(([agentId, held]) =>
      held.items.map((profile) => ({ agentId, profile })),
    )
  }
}

// DeepSeek Harness's sign-in and balance as the agent host reads them itself, without starting
// dsh: the route its home's files sign in on, watched for a sign-in made in dsh's own page or a
// terminal, and the balance DeepSeek holds for that route. The token and the key are read for
// DeepSeek's own requests alone (vendor-usage/deepseek.ts); only a short hash of each stays in
// memory, to tell a new sign-in from the one already read.

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AgentAccount, ProviderBalance } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { Env } from '../find-command'
import { currentLocale, t } from '../i18n'
import type { ProviderUsage } from '../opencode/provider-usage'
import {
  DEEPSEEK_ACCOUNT_VERSION,
  readDeepSeekAccount,
  readDeepSeekKeyBalance,
  type DeepSeekProfile,
} from '../vendor-usage/deepseek'
import { UsageReadError, type SignInPlace } from '../vendor-usage/stored-sign-in'
import { watchCredentials } from './credentials-watch'
import { readAccountGrant, readApiKey, readProvider, type Provider } from './credentials'
import { isDeepSeekRoute } from './options'
import { readRoutes, type Routes } from './routes'

/** How the agent runs its models: one of DeepSeek's routes, another provider's, or none. */
export type DshRoute = Provider | 'gateway' | 'none'

/** The account line of a route, naming the DeepSeek account by its contact once one was read. */
export function routeAccount(route: DshRoute, profile: DeepSeekProfile | null): AgentAccount {
  switch (route) {
    case 'deepseek-account':
      return {
        kind: 'external',
        label:
          !profile?.contact && profile?.name
            ? t('dsh.account.named', { name: profile.name })
            : t('dsh.account.account'),
        email: profile?.contact ?? null,
      }
    case 'deepseek-official':
      return { kind: 'api_key', label: t('dsh.account.apiKey'), email: null }
    case 'gateway':
      return { kind: 'gateway', label: t('dsh.account.gateway'), email: null }
    case 'none':
      return { kind: 'none', label: '', email: null }
  }
}

/**
 * The route a running agent reports from what its connection read: its DeepSeek sign-in, else
 * another provider's route, whose key is the user's to set in dsh; else none once dsh's own list
 * was read. DeepSeek's own routes are listed signed in or not, so they tell nothing of a sign-in.
 * Null while that is not known yet.
 */
export function reportedRoute(read: {
  signedIn: Provider | null
  listed: readonly { provider: string }[]
  routes: Pick<Routes, 'groups'>
  settled: boolean
}): DshRoute | null {
  if (read.signedIn) return read.signedIn
  const routed =
    read.routes.groups.length > 0 || read.listed.some((model) => !isDeepSeekRoute(model.provider))
  return routed ? 'gateway' : read.settled ? 'none' : null
}

function homeKey(home: string): string {
  const resolved = path.resolve(home)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** A credential's short hash, which tells one sign-in from another and holds nothing of it. */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/**
 * The account profile last read for each home, with the sign-in it belongs to, so the agent's
 * own report of its account names it too.
 */
const PROFILES = new Map<string, { signIn: string; profile: DeepSeekProfile }>()

/** The profile read for the home's current account sign-in; null before one was read. */
export function knownProfile(home: string): DeepSeekProfile | null {
  return PROFILES.get(homeKey(home))?.profile ?? null
}

/**
 * When the balance is read from DeepSeek: `files` only for a sign-in that changed since the files
 * were last read, `due` also once the last read is `dueMs` old, `forced` once it is 10 s old.
 */
export type DshReadReason = 'files' | 'due' | 'forced'

const FORCED_MS = 10_000

export interface DshReadInput {
  /** The agent's environment, with its home as `DSH_HOME`. */
  env: Env
  home: string
  /** The dsh version the agent runs, which the account requests name as dsh's own do. */
  version: string | null
  reason: DshReadReason
  /** What the agent shows now, which a failed read keeps. */
  account: AgentAccount | null
  balance: ProviderUsage | null
}

export interface DshRead {
  /** What the account line says now; null to leave it to what the agent reports. */
  account: AgentAccount | null
  /** The balance to show; absent when it was not read this time, so the one shown stays. */
  balance?: ProviderUsage | null
}

interface AgentState {
  /** The sign-in the files held at the last read; undefined before the first. */
  seen?: string | null
  /** The sign-in the balance was last read for, and when. */
  readFor: string | null
  readAt: number
  watched: string | null
  unwatch: (() => void) | null
}

export interface DshAccountsDeps {
  log(level: 'info' | 'warn', message: string): void
  /** The gap between two reads of the balance that nobody asked for. */
  dueMs: number
  platform: Platform
  now?(): number
  fetch?: typeof globalThis.fetch
  /** How long after a change of the credential file a read follows. */
  watchDelayMs?: number
}

/** The sign-in and balance of each DeepSeek Harness agent, and the watch on its home. */
export class DshAccounts {
  private readonly agents = new Map<string, AgentState>()

  constructor(private readonly deps: DshAccountsDeps) {}

  private state(agentId: string): AgentState {
    let state = this.agents.get(agentId)
    if (!state) {
      state = { readFor: null, readAt: 0, watched: null, unwatch: null }
      this.agents.set(agentId, state)
    }
    return state
  }

  /** Watches the agent's home, `changed` running after its credential file changes. */
  watch(agentId: string, home: string, changed: () => void): void {
    const state = this.state(agentId)
    const key = homeKey(home)
    if (state.watched === key) return
    state.unwatch?.()
    state.watched = key
    state.unwatch = watchCredentials(home, changed, {
      delayMs: this.deps.watchDelayMs ?? 300,
      log: (message) => this.deps.log('warn', message),
    })
  }

  forget(agentId: string): void {
    this.agents.get(agentId)?.unwatch?.()
    this.agents.delete(agentId)
  }

  close(): void {
    for (const agentId of [...this.agents.keys()]) this.forget(agentId)
  }

  /**
   * Reads the route the home's files sign in on, and DeepSeek's balance for it when `reason`
   * says one is due. A failed read keeps the balance last read for the same sign-in.
   */
  async read(agentId: string, input: DshReadInput): Promise<DshRead> {
    const state = this.state(agentId)
    const now = this.deps.now?.() ?? Date.now()
    const provider = await readProvider(input.env)
    const signIn =
      provider === 'deepseek-account'
        ? await readAccountGrant(input.env)
        : provider === 'deepseek-official'
          ? await readApiKey(input.env)
          : null
    const id =
      provider === null
        ? null
        : signIn === null
          ? `${provider}:unreadable`
          : `${provider}:${fingerprint(typeof signIn === 'string' ? signIn : signIn.token)}`
    const changed = state.seen !== undefined && state.seen !== id
    state.seen = id
    const home = homeKey(input.home)
    const kept = PROFILES.get(home)
    if (kept && kept.signIn !== id) PROFILES.delete(home)
    const profile = kept?.signIn === id ? kept.profile : null

    if (provider === null) {
      state.readFor = null
      const routes = await readRoutes(input.home)
      // Without a DeepSeek credential or another provider's route, dsh has nothing to run on, as
      // when it dropped a grant DeepSeek refused. A route only dsh's own list showed the agent
      // reported itself, and stays.
      const account =
        routes.groups.length > 0
          ? routeAccount('gateway', null)
          : input.account?.kind === 'gateway'
            ? null
            : routeAccount('none', null)
      return { account, balance: null }
    }

    const fresh = state.readFor === id
    const age = now - state.readAt
    const due =
      input.reason === 'files'
        ? changed
        : !fresh || age >= (input.reason === 'forced' ? FORCED_MS : this.deps.dueMs)
    const account = (named: DeepSeekProfile | null): AgentAccount => routeAccount(provider, named)
    // A key only a project's `.env` names is dsh's to read there; none is sent from here.
    if (signIn === null) return { account: account(null), balance: null }
    if (!due) return { account: account(profile) }

    const place: SignInPlace = {
      env: input.env,
      home: input.home,
      platform: this.deps.platform,
      now,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    }
    let balance: ProviderUsage
    let named = profile
    try {
      let balances: ProviderBalance[]
      if (typeof signIn === 'string') {
        balances = await readDeepSeekKeyBalance(place, signIn)
      } else {
        const read = await readDeepSeekAccount(place, signIn, {
          profile: profile === null,
          version: input.version ?? DEEPSEEK_ACCOUNT_VERSION,
          locale: currentLocale(),
        })
        balances = read.balances
        if (read.profile) {
          named = read.profile
          PROFILES.set(home, { signIn: id!, profile: read.profile })
        }
      }
      balance = { state: 'ready', limits: [], balances, observedAt: now, error: null }
    } catch (error) {
      const refused = error instanceof UsageReadError && error.status === 401
      // Only the read's own errors name what failed; they never hold what was sent or answered.
      this.deps.log(
        'warn',
        error instanceof UsageReadError
          ? `DeepSeek's balance was not read: ${error.message}`
          : "DeepSeek's balance was not read",
      )
      // A balance an earlier run kept stands for the same route until a read replaces it.
      const kept =
        input.balance?.stale === true && input.account?.kind === account(null).kind
          ? input.balance
          : null
      const last = fresh && input.balance ? input.balance : kept
      balance = {
        state: 'error',
        limits: [],
        balances: last?.balances ?? [],
        observedAt: last?.observedAt ?? 0,
        ...(last?.stale ? { stale: true as const } : {}),
        error: t(
          !refused
            ? 'dsh.balance.failed'
            : typeof signIn === 'string'
              ? 'dsh.balance.refusedKey'
              : 'dsh.balance.refused',
        ),
      }
    }
    state.readFor = id
    state.readAt = now
    return { account: account(named), balance }
  }
}

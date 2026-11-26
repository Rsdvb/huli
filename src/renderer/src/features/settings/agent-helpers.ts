// What the Agent and Harness sections of Settings both use that is not a component: who makes each
// harness, a button's request state, and reading an agent's account, usage and version.

import { useCallback, useEffect, useState } from 'react'
import type {
  AgentAuthMethod,
  AgentOptions,
  AgentStatus,
  PlanLimit,
  SessionSummary,
} from '@shared/agent-host'
import { isStartMode } from '@shared/agents'
import { limitHolds } from '@shared/plan-limits'
import type { AgentId, HarnessId } from '@shared/thread'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { limitPercent, type LimitView } from '@renderer/lib/plan-limit'
import { isInstalled, type AgentsStoreHook } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'

export const VENDORS: Partial<Record<HarnessId, string>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'SST',
  pi: 'Earendil',
  omp: 'Oh My Pi',
  hermes: 'Nous Research',
  kiro: 'Amazon',
  fx: 'Vercel Labs',
  muse: 'Meta',
  codewhale: 'Codewhale',
  deepseek: 'DeepSeek',
  doubao: 'ByteDance',
}

/** A button's request: run it, whether it runs, its error, and putting that error away. */
export function useAction(): [
  (run: () => Promise<unknown>) => void,
  boolean,
  string | null,
  () => void,
] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    run()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
  const clear = useCallback(() => setError(null), [])
  return [act, busy, error, clear]
}

/**
 * Huli: a sign-in method that asks for an API key in a terminal, as `codex login --with-api-key`
 * does, for an agent whose key the page can set instead; the terminal would show the key.
 */
export function asksForKey(status: AgentStatus, method: AgentAuthMethod): boolean {
  return status.apiKey !== null && method.type === 'terminal' && method.id === 'api-key'
}

export function limitsReadable(status: AgentStatus): boolean {
  return status.capabilities.reports && isInstalled(status) && status.signIn !== 'required'
}

/**
 * A folder of this computer a sign-in terminal can open in without a project: the selected one,
 * else a project, else the newest scratch folder of a session started with No project.
 */
export function signInFolder(input: {
  selected: string | null
  projects: readonly { path: string }[]
  sessions: Readonly<Record<string, SessionSummary>>
}): string | null {
  const local = (path: string | null | undefined): path is string =>
    !!path && hostOfPath(path) === null
  if (local(input.selected)) return input.selected
  const project = input.projects.find((p) => local(p.path))
  if (project) return project.path
  const scratch = Object.values(input.sessions)
    .filter((session) => session.scratch && local(session.projectPath))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return scratch?.projectPath ?? null
}

/**
 * Reads what an agent's row and page show: its account and plan limits, starting an agent that
 * reports them, and its details. True while the account and limits are being read.
 */
export function useAgentReads(status: AgentStatus, options?: { force?: boolean }): boolean {
  const { request, useAgentsStore } = useHostScope()
  const [reading, setReading] = useState(true)
  const force = options?.force === true
  useEffect(() => {
    let current = true
    request('agents.refreshAccount', { agentId: status.id, ...(force ? { force: true } : {}) })
      .catch((e: unknown) =>
        console.warn(`Could not read the account and plan limits: ${errorMessage(e)}`),
      )
      .finally(() => {
        if (current) setReading(false)
      })
    return () => {
      current = false
    }
  }, [status.id, request, force])
  // Again on each state or task change, so an adapter installed or updated shows its CLI version.
  const task = status.task?.state ?? null
  useEffect(() => {
    useAgentsStore
      .getState()
      .loadDetails(status.id)
      .catch((e: unknown) => console.warn(`Could not read the agent details: ${errorMessage(e)}`))
  }, [status.id, status.state, task, status.configDir?.runs, useAgentsStore])
  return reading
}

/** Huli: how soon a window coming back asks the agent's sign-in again. */
const SIGN_IN_AGAIN_MS = 2_000

/**
 * Huli: has the host learn what an agent signs in with and whether it is signed in while its page
 * shows, starting it when this run has not, and asks again each time the window comes back while
 * it is not signed in, such as from a browser or a terminal where it signed in. True while the
 * page's first read runs. An older host that lacks the read leaves the page as it was.
 */
export function useSignInRead(status: AgentStatus): boolean {
  const { request } = useHostScope()
  // One that needs an install first is read once it is installed.
  const startable =
    isInstalled(status) &&
    status.state !== 'installing' &&
    status.package?.installed !== false &&
    status.disabled !== true
  const reads = startable ? status.id : null
  const [read, setRead] = useState<AgentId | null>(null)
  useEffect(() => {
    if (reads === null) return
    let current = true
    request('agents.readSignIn', { agentId: reads })
      .catch((e: unknown) => console.warn(`Could not read the sign-in: ${errorMessage(e)}`))
      .finally(() => {
        if (current) setRead(reads)
      })
    return () => {
      current = false
    }
  }, [reads, request])
  const signedIn = status.signIn === 'signed-in'
  useEffect(() => {
    if (signedIn || !startable) return
    let last = 0
    const again = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < SIGN_IN_AGAIN_MS) return
      last = Date.now()
      request('agents.readSignIn', { agentId: status.id }).catch(() => {})
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [status.id, request, signedIn, startable])
  return reads !== null && read !== reads
}

/**
 * The windows whose reset has not passed, and those without one read within their period; an
 * older reading of them no longer holds.
 */
export function currentLimits(limits: PlanLimit[], now: number): PlanLimit[] {
  return limits.filter((l) => limitHolds(l, now))
}

export function percent(limit: PlanLimit, view: LimitView): string {
  const shown = limitPercent(limit, view)
  return shown === null ? '—' : `${shown}%`
}

/**
 * Quietly re-checks harness detection on the given store so external CLI upgrades are picked up
 * without flickering loading indicators or surfacing transient errors.
 */
export function checkHarnessQuietly(agents: AgentsStoreHook, harnessId?: HarnessId): Promise<void> {
  return agents
    .getState()
    .check(harnessId)
    .catch((e: unknown) => {
      console.warn(`Could not check ${harnessId ?? 'harnesses'}: ${errorMessage(e)}`)
    })
}

/**
 * Triggers a background harness check whenever Settings > Harnesses or a specific harness page
 * opens or switches host/harness.
 */
export function useHarnessCheck(harnessId?: HarnessId): void {
  const { useAgentsStore } = useHostScope()
  useEffect(() => {
    void checkHarnessQuietly(useAgentsStore, harnessId)
  }, [harnessId, useAgentsStore])
}

/** The harness's own version: the user's CLI it runs, or the program's, never Kettu's package. */
export function harnessVersion(status: AgentStatus): string | null {
  return status.cli ? (status.cli.installed?.version ?? null) : status.version
}

/** Whether the agent's harness has another agent, which is when "Default" tells them apart. */
export function useHasOtherAgents(status: AgentStatus | null): boolean {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(
    (s) =>
      !!status &&
      s.order.some((id) => id !== status.id && s.byId[id]?.harnessId === status.harnessId),
  )
}

/** The choice that has an agent's new sessions start in the mode the agent has by itself. */
export const FOLLOW_AGENT = '__follow'

export interface StartModeChoice {
  value: string
  name: string
  /** False for the stored mode when the agent no longer lists it. */
  offered: boolean
}

export interface StartModeView {
  /** `unused`: the agent's modes are not known yet; `failed`: reading them failed. */
  state: 'loading' | 'unused' | 'failed' | 'ready'
  /** The modes after the "follow" choice, the stored one among them. */
  choices: StartModeChoice[]
  /** The stored mode, or `FOLLOW_AGENT`. */
  value: string
}

/**
 * What the start mode row shows for an agent: the modes it lists in its cached options, which only
 * an agent that has been used has, and the one stored in the settings, kept in the list when the
 * agent no longer offers it so it can be seen and changed.
 */
export function startModeView(input: {
  agentId: AgentId
  entry: AgentOptions | undefined
  /** Whether the host's cached options were read, so a row stops waiting for them. */
  loaded: boolean
  failed: boolean
  stored: string | undefined
}): StartModeView {
  const { agentId, entry, loaded, failed, stored } = input
  const kept = isStartMode(agentId, stored) ? stored : null
  const value = kept ?? FOLLOW_AGENT
  const stay = (state: StartModeView['state']): StartModeView => ({
    state,
    choices: kept === null ? [] : [{ value: kept, name: kept, offered: true }],
    value,
  })
  if (!loaded) return stay('loading')
  const option = entry?.config.find(
    (o) => o.category === 'mode' && o.type === 'select' && !!o.choices?.length,
  )
  // A provisional entry has the model's options alone, so no mode counts as unused.
  if (!option) return stay(failed && !entry ? 'failed' : 'unused')
  const choices = (option.choices ?? []).map((choice): StartModeChoice => ({
    value: choice.value,
    name: choice.name,
    offered: true,
  }))
  if (kept !== null && !choices.some((choice) => choice.value === kept)) {
    choices.push({ value: kept, name: kept, offered: false })
  }
  return { state: 'ready', choices, value }
}

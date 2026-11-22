// Huli: Settings › 总管模式's data: the scope the page edits, the roster it shows and how a change
// is saved, the suggested roster and the choices its selects offer.
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import {
  DEFAULT_MANAGER_SETTINGS,
  workerId,
  type ManagerLimits,
  type ManagerSettings,
  type ProjectManagerSettings,
  type RosterWorker,
} from '@shared/manager'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'

export const GLOBAL = '__global__'
export const NONE = '__none__'

/** Which roster the page edits: the settings', or a project's. */
export const useScope = create<{ path: string | null }>(() => ({ path: null }))

export const CONCURRENT = [1, 2, 3, 4, 5, 6]
export const TURNS = [10, 20, 30, 50, 100, 200]
export const ROUNDS = [1, 2, 3, 5]
export const BUDGETS = [0, 500_000, 1_000_000, 2_000_000, 5_000_000, 20_000_000]

export function newId(): string {
  return workerId(crypto.getRandomValues(new Uint8Array(4)))
}

/** The roster suggested from the agents on this computer: who writes, reviews, plans, does odd jobs. */
export function suggestedRoster(
  agents: readonly AgentStatus[],
  t: (key: string) => string,
): Pick<ManagerSettings, 'workers' | 'reviewerId' | 'suggestion'> {
  const find = (harness: string) => agents.find((a) => a.id === harness)
  const workers: RosterWorker[] = []
  const add = (agentId: string, role: RosterWorker['role'], key: string) => {
    workers.push({
      id: newId(),
      name: t(`manager.suggested.${key}.name`),
      role,
      agentId: agentId as RosterWorker['agentId'],
      model: null,
      effort: null,
      profileId: null,
      mode: null,
      worktree: false,
      persona: t(`manager.suggested.${key}.persona`),
    })
  }
  const codex = find('codex')
  const claude = find('claude-code')
  const deepseek = find('deepseek')
  if (codex) add(codex.id, 'implement', 'writer')
  if (claude) add(claude.id, 'review', 'reviewer')
  if (claude) add(claude.id, 'plan', 'planner')
  if (deepseek) add(deepseek.id, 'other', 'helper')
  if (!codex && claude) add(claude.id, 'implement', 'writer')
  if (workers.length === 0 && agents[0]) add(agents[0].id, 'implement', 'writer')
  const reviewer = workers.find((w) => w.role === 'review') ?? null
  const glm = claude?.profiles?.items.find((p) => p.preset === 'zhipu' || p.preset === 'zai')
  return {
    workers,
    reviewerId: reviewer?.id ?? null,
    suggestion: claude ? { agentId: claude.id, model: null, profileId: glm?.id ?? null } : null,
  }
}

export function useAgents(): AgentStatus[] {
  return useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (agent) => isInstalled(agent) && !agent.hidden && !agent.disabled,
      ),
    ),
  )
}

/** The settings the page shows and how a change is saved, for the chosen scope. */
export function useEdited(): {
  value: ManagerSettings
  /** A project scope that keeps the settings' roster. */
  inherits: boolean
  project: string | null
  save: (next: ManagerSettings) => void
} {
  const path = useScope((s) => s.path)
  const global = useSettingsStore((s) => s.settings.manager ?? DEFAULT_MANAGER_SETTINGS)
  const own = useProjectsStore((s) =>
    path ? (s.projects.find((p) => p.path === path)?.manager ?? null) : null,
  )
  const value: ManagerSettings = own
    ? {
        ...global,
        workers: own.workers,
        reviewerId: own.reviewerId,
        autoReview: own.autoReview ?? global.autoReview,
        approvals: own.approvals ?? global.approvals,
        limits: own.limits ?? global.limits,
      }
    : global
  const save = (next: ManagerSettings) => {
    if (path === null) {
      void useSettingsStore
        .getState()
        .update({ manager: next })
        .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
      return
    }
    void saveProject(path, {
      workers: next.workers,
      reviewerId: next.reviewerId,
      autoReview: next.autoReview,
      approvals: next.approvals,
      limits: next.limits,
    })
  }
  return { value, inherits: path !== null && !own, project: path, save }
}

export async function saveProject(
  path: string,
  manager: ProjectManagerSettings | null,
): Promise<void> {
  try {
    await host('projects.setManager', { path, manager })
    await useProjectsStore.getState().refresh()
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
  }
}

export function withCurrent(list: readonly number[], current: number): number[] {
  return list.includes(current) ? [...list] : [...list, current].sort((a, b) => a - b)
}

export function saveLimits(
  edited: ReturnType<typeof useEdited>,
  changes: Partial<ManagerLimits>,
): void {
  edited.save({ ...edited.value, limits: { ...edited.value.limits, ...changes } })
}

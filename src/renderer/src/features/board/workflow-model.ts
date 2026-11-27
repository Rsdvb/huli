import type { TFunction } from 'i18next'
import type { WorkflowAgentView, WorkflowPhaseView, WorkflowView } from '@shared/thread'

/** One phase of a workflow as the board groups its agents; `phase` is null for those outside. */
export interface PhaseGroup {
  phase: WorkflowPhaseView | null
  agents: WorkflowAgentView[]
  done: number
  failed: number
  /** Agents that work or wait for their turn. */
  open: number
}

export const agentEnded = (agent: Pick<WorkflowAgentView, 'state'>): boolean =>
  agent.state === 'done' || agent.state === 'failed' || agent.state === 'stopped'

function group(phase: WorkflowPhaseView | null, agents: WorkflowAgentView[]): PhaseGroup {
  let done = 0
  let failed = 0
  let open = 0
  for (const agent of agents) {
    if (agent.state === 'done') done++
    else if (agent.state === 'failed') failed++
    else if (!agentEnded(agent)) open++
  }
  return { phase, agents, done, failed, open }
}

/**
 * The workflow's agents by phase, in the run's order, a phase it declared but has not reached
 * among them with none; agents outside every phase come last.
 */
export function phaseGroups(view: WorkflowView): PhaseGroup[] {
  const byPhase = new Map<number, WorkflowAgentView[]>()
  const loose: WorkflowAgentView[] = []
  const known = new Set(view.phases.map((phase) => phase.index))
  for (const agent of view.agents) {
    if (agent.phase === null || !known.has(agent.phase)) {
      loose.push(agent)
      continue
    }
    const list = byPhase.get(agent.phase)
    if (list) list.push(agent)
    else byPhase.set(agent.phase, [agent])
  }
  const groups = view.phases.map((phase) => group(phase, byPhase.get(phase.index) ?? []))
  if (loose.length > 0) groups.push(group(null, loose))
  return groups
}

/** How many agents work or wait, and how many failed. */
export function agentCounts(view: WorkflowView): { open: number; failed: number; total: number } {
  let open = 0
  let failed = 0
  for (const agent of view.agents) {
    if (agent.state === 'failed') failed++
    else if (!agentEnded(agent)) open++
  }
  return { open, failed, total: view.agents.length }
}

/**
 * The workflow's line under its name: the phases at work now as "Review 3/6", else the last one
 * reached, and how many agents failed; null before any agent was reported.
 */
export function workflowLine(t: TFunction<'board'>, view: WorkflowView): string | null {
  const groups = phaseGroups(view).filter((item) => item.agents.length > 0)
  if (groups.length === 0) return null
  const active = groups.filter((item) => item.open > 0)
  const shown = active.length > 0 ? active : groups.slice(-1)
  const parts = shown.map((item) =>
    item.phase === null && view.phases.length === 0
      ? t('workflow.doneCount', { done: item.done, total: item.agents.length })
      : t('workflow.phaseCount', {
          title: item.phase?.title ?? t('workflow.otherPhase'),
          done: item.done,
          total: item.agents.length,
        }),
  )
  const { failed } = agentCounts(view)
  if (failed > 0) parts.push(t('earlier.failed', { count: failed }))
  return parts.join(' · ')
}

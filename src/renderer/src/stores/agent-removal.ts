// Huli: the steps of an agent's removal from its host as the host runs them, from its
// `agents.removalProgress` events, by host and agent, for the dialog that started the run.

import { create } from 'zustand'
import type { AgentRemovalProgress } from '@shared/agent-removal'
import type { AgentId } from '@shared/thread'

export interface StepState {
  state: AgentRemovalProgress['state']
  error?: string
}

interface RemovalProgressState {
  runs: Record<string, Record<string, StepState>>
}

const useRemovalProgress = create<RemovalProgressState>(() => ({ runs: {} }))

function runKey(hostId: string | null, agentId: AgentId): string {
  return `${hostId ?? ''}\0${agentId}`
}

const NONE: Record<string, StepState> = {}

/** Forgets what an earlier run showed, before a new one starts. */
export function clearRemovalProgress(hostId: string | null, agentId: AgentId): void {
  const key = runKey(hostId, agentId)
  useRemovalProgress.setState((state) => {
    if (!(key in state.runs)) return state
    const runs = { ...state.runs }
    delete runs[key]
    return { runs }
  })
}

/** `agents.removalProgress`: a step of a run this window started began or ended. */
export function receiveRemovalProgress(
  hostId: string | null,
  progress: AgentRemovalProgress,
): void {
  const key = runKey(hostId, progress.agentId)
  const step: StepState = {
    state: progress.state,
    ...(progress.error ? { error: progress.error } : {}),
  }
  useRemovalProgress.setState((state) => ({
    runs: { ...state.runs, [key]: { ...state.runs[key], [progress.stepId]: step } },
  }))
}

/** The steps of the agent's run as far as the host has said, by step id. */
export function useRemovalProgressOf(
  hostId: string | null,
  agentId: AgentId,
): Record<string, StepState> {
  return useRemovalProgress((state) => state.runs[runKey(hostId, agentId)] ?? NONE)
}

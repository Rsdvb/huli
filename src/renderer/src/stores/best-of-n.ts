import { create } from 'zustand'
import { GROUP_RUNS_MAX, GROUP_RUNS_MIN } from '@shared/session-groups'
import { isAgentId, type AgentId } from '@shared/thread'
import { readJson, writeJson } from '@renderer/lib/storage'

// Huli: whether New session gives a project's next message to several agents at once, and to
// which agents and models. The runs are remembered in localStorage under `best-of-n-runs`, so the
// next group starts with the same line-up; the choice itself lasts while the window is open.

const KEY = 'best-of-n-runs'

/** One run New session will start: an agent, and its model, or null for the agent's own. */
export interface RunPick {
  agentId: AgentId
  model: string | null
}

function load(): RunPick[] {
  const parsed = readJson<unknown>(KEY, [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .flatMap((item): RunPick[] => {
      if (typeof item !== 'object' || item === null) return []
      const { agentId, model } = item as Record<string, unknown>
      if (typeof agentId !== 'string' || !isAgentId(agentId)) return []
      return [{ agentId, model: typeof model === 'string' ? model : null }]
    })
    .slice(0, GROUP_RUNS_MAX)
}

interface BestOfNStore {
  /** The projects whose next message goes to several agents, by path. */
  on: Record<string, true>
  runs: RunPick[]
}

export const useBestOfN = create<BestOfNStore>(() => ({ on: {}, runs: load() }))

function save(runs: RunPick[]): void {
  useBestOfN.setState({ runs })
  writeJson(KEY, runs)
}

/**
 * Turns best of N on or off for the project. Turned on with fewer than two runs remembered, it
 * starts from the tray's agent twice, so the user picks the second's model or agent.
 */
export function setBestOfN(projectPath: string, on: boolean, agentId: AgentId | null): void {
  useBestOfN.setState((s) => {
    const next = { ...s.on }
    if (on) next[projectPath] = true
    else delete next[projectPath]
    return { on: next }
  })
  if (!on) return
  const { runs } = useBestOfN.getState()
  if (runs.length >= GROUP_RUNS_MIN || !agentId) return
  const filled = [...runs]
  while (filled.length < GROUP_RUNS_MIN) filled.push({ agentId, model: null })
  save(filled)
}

export function setRun(index: number, pick: RunPick): void {
  const runs = [...useBestOfN.getState().runs]
  if (index < 0 || index >= runs.length) return
  runs[index] = pick
  save(runs)
}

export function addRun(pick: RunPick): void {
  const { runs } = useBestOfN.getState()
  if (runs.length >= GROUP_RUNS_MAX) return
  save([...runs, pick])
}

export function removeRun(index: number): void {
  const { runs } = useBestOfN.getState()
  if (runs.length <= GROUP_RUNS_MIN) return
  save(runs.filter((_, i) => i !== index))
}

import { GROUP_RUNS_MAX, GROUP_RUNS_MIN, type GroupRunStart } from '@shared/run-groups'
import type { ConfigOption } from '@shared/thread'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { useBestOfN, type RunPick } from '@renderer/stores/best-of-n'
import { canStart, startValues } from './start-options'

/** An agent's model option among its options. */
export function modelOption(config: readonly ConfigOption[] | undefined): ConfigOption | undefined {
  return config?.find((o) => o.category === 'model' && o.type === 'select')
}

/**
 * The runs as the host starts them, each with the values its agent starts with and the model
 * picked; null with a run whose agent cannot start now, or too few or too many runs.
 */
export function runStarts(hostId: string | null, runs: readonly RunPick[]): GroupRunStart[] | null {
  if (runs.length < GROUP_RUNS_MIN || runs.length > GROUP_RUNS_MAX) return null
  const statuses = agentsOn(useAgentsStore.getState(), hostId).byId
  const options = optionsOn(useAgentOptionsStore.getState(), hostId)
  const starts: GroupRunStart[] = []
  for (const run of runs) {
    const status = statuses[run.agentId]
    if (!status || status.disabled || !canStart(status)) return null
    const entry = options[run.agentId]
    const model = modelOption(entry?.config)
    const picks = run.model && model ? { [model.id]: run.model } : {}
    const values = entry ? startValues(entry, picks, { startMode: true }) : {}
    starts.push({
      agentId: run.agentId,
      ...(Object.keys(values).length > 0 ? { options: values } : {}),
    })
  }
  return starts
}

/** Whether every run's agent can start now, for New session's Send. */
export function useRunsReady(hostId: string | null): boolean {
  const runs = useBestOfN((s) => s.runs)
  return useAgentsStore((s) => {
    if (runs.length < GROUP_RUNS_MIN || runs.length > GROUP_RUNS_MAX) return false
    const { byId } = agentsOn(s, hostId)
    return runs.every((run) => {
      const status = byId[run.agentId]
      return !!status && !status.disabled && canStart(status)
    })
  })
}

import type { SessionSummary } from '@shared/agent-host'
import { configChoiceFor } from '@shared/thread'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'

type OptionsState = ReturnType<typeof useAgentOptionsStore.getState>

/** The name of the model a run's agent ran with, as its options name it; null when unknown. */
export function modelNameOf(state: OptionsState, run: SessionSummary | undefined): string | null {
  if (!run?.model) return null
  const config = optionsOn(state, hostOfSession(run))[run.agentId]?.config
  const model = config?.find((o) => o.category === 'model' && o.type === 'select')
  return (model && configChoiceFor(model, run.model)?.name) ?? run.model
}

export function useModelName(run: SessionSummary | undefined): string | null {
  return useAgentOptionsStore((s) => modelNameOf(s, run))
}

/** A run as the group's dialogs name it: its agent, and its model when known. */
export function runLabel(run: SessionSummary, model: string | null): string {
  const agent = agentName(run.agentId, hostOfSession(run))
  return model ? `${agent} · ${model}` : agent
}

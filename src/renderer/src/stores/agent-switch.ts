import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import type { OptionValues } from '@renderer/stores/agent-options'

/** Another agent picked to take a session over from its next message, until that message goes. */
export interface PendingSwitch {
  agentId: AgentId
  /** The values chosen for it in the menu; the rest come from its remembered values. */
  values: OptionValues
  /** It reads the earlier conversation and summarizes it before carrying on. */
  summarize: boolean
}

interface AgentSwitchStore {
  /** By session id. */
  pending: Record<string, PendingSwitch>
  /** The session whose composer is asked to open its agent menu, as a plan alert's action does. */
  asking: string | null
}

export const useAgentSwitchStore = create<AgentSwitchStore>(() => ({ pending: {}, asking: null }))

/** Opens the session's agent menu in its composer, which clears the ask once it has. */
export function askAgentSwitch(sessionId: string | null): void {
  useAgentSwitchStore.setState({ asking: sessionId })
}

export function setPendingSwitch(sessionId: string, next: PendingSwitch | null): void {
  useAgentSwitchStore.setState((s) => {
    const pending = { ...s.pending }
    if (next) pending[sessionId] = next
    else delete pending[sessionId]
    return { pending }
  })
}

export function updatePendingSwitch(sessionId: string, changes: Partial<PendingSwitch>): void {
  const current = useAgentSwitchStore.getState().pending[sessionId]
  if (current) setPendingSwitch(sessionId, { ...current, ...changes })
}

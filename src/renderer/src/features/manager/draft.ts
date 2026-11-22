// Huli: New session's manager-mode choice, which its next start takes and then lets go, so the
// session after it starts as an ordinary one again.

import { create } from 'zustand'
import { canManage, type ManagerApprovals, type ManagerChoices } from '@shared/manager'
import type { AgentId } from '@shared/thread'
import { useSettingsStore } from '@renderer/stores/settings'

interface ManagerDraft {
  on: boolean
  /** Null until chosen here: the settings' default. */
  autoReview: boolean | null
  approvals: ManagerApprovals | null
}

export const useManagerDraft = create<ManagerDraft>()(() => ({
  on: false,
  autoReview: null,
  approvals: null,
}))

/** The choices New session starts a manager with, for an agent that can be one; null for none. */
export function managerStart(agentId: AgentId, parentId: string | null): ManagerChoices | null {
  const draft = useManagerDraft.getState()
  if (!draft.on || parentId !== null || !canManage(agentId)) return null
  const settings = useSettingsStore.getState().settings.manager
  return {
    autoReview: draft.autoReview ?? settings?.autoReview ?? true,
    approvals: draft.approvals ?? settings?.approvals ?? 'user',
  }
}

/** After a start: the next New session is an ordinary one. */
export function clearManagerDraft(): void {
  useManagerDraft.setState({ on: false, autoReview: null, approvals: null })
}

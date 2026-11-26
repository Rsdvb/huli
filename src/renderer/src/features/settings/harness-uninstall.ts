// Huli: uninstalling a harness from Settings. The confirmation closes at once and the harness's
// rows say 正在卸载… until its agents are gone and it reads as uninstalled, or say why it failed;
// the state lives in the host's agents store, so the list and the harness's page agree.

import type { AgentStatus } from '@shared/agent-host'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { without } from '@renderer/stores/agents'
import type { HostScope } from '@renderer/stores/host-scope'

type Scope = Pick<HostScope, 'api' | 'request' | 'useAgentsStore' | 'useSettingsStore'>

/**
 * Asks the host to uninstall the harness, then takes its agents out and marks it uninstalled. A
 * second call while one runs does nothing; the host joins a second request of its own as well.
 */
export async function uninstallHarness(
  scope: Scope,
  status: AgentStatus,
  removeProgram: boolean,
): Promise<void> {
  const { api, request, useAgentsStore, useSettingsStore } = scope
  const harness = status.harnessId
  if (useAgentsStore.getState().uninstalling[harness]) return
  useAgentsStore.setState((state) => ({
    uninstalling: { ...state.uninstalling, [harness]: true },
    uninstallErrors: without(state.uninstallErrors, harness),
  }))
  try {
    const result = await request('agents.uninstall', { agentId: harness, removeProgram })
    const agents = useAgentsStore.getState()
    const ids = agents.order.filter(
      (id) => agents.byId[id]?.harnessId === harness && agents.byId[id]?.registered !== false,
    )
    for (const id of ids) await api.settings.removeAgent(id, false)
    await useSettingsStore.getState().update({
      agents: { [harness]: { uninstalled: true, enabled: false } },
    })
    if (result.error) toast(result.error, undefined, { tone: 'warning' })
  } catch (e) {
    const message = errorMessage(e)
    useAgentsStore.setState((state) => ({
      uninstallErrors: { ...state.uninstallErrors, [harness]: message },
    }))
  } finally {
    useAgentsStore.setState((state) => ({ uninstalling: without(state.uninstalling, harness) }))
  }
}

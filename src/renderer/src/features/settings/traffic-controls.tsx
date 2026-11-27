// Huli: the controls of Settings › Agents › 省流量 (traffic-rows.tsx lays them out).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { takesAutoCompact, trafficPreset } from '@shared/auto-compact'
import type { AgentStatus } from '@shared/agent-host'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { usableAgents } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, SetButton, SettingSwitch } from './controls'

/** The agents whose harness has a 省流量 value. */
function useSaverAgents(): AgentStatus[] {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (agent) => takesAutoCompact(agent.id) && trafficPreset(agent.harnessId) !== null,
      ),
    ),
  )
}

export function CompactPreset() {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const agents = useSaverAgents()
  const [busy, setBusy] = useState<'default' | 'traffic' | null>(null)
  const apply = async (choice: 'default' | 'traffic'): Promise<void> => {
    setBusy(choice)
    const failed: string[] = []
    // One after another: Codex's are written through its app-server, which one call starts.
    for (const agent of agents) {
      try {
        await request('agents.setCompactChoice', { agentId: agent.id, choice })
      } catch (error) {
        failed.push(
          t('agents.traffic.compact.failed', { agent: agent.name, error: errorMessage(error) }),
        )
      }
    }
    setBusy(null)
    const done = agents.length - failed.length
    if (done > 0) {
      toast(
        t(
          choice === 'traffic'
            ? 'agents.traffic.compact.done'
            : 'agents.traffic.compact.doneDefault',
          { count: done },
        ),
      )
    }
    if (failed.length > 0) toast(failed.join('\n'))
  }
  if (agents.length === 0) {
    return <span className="k-fact">{t('agents.traffic.compact.none')}</span>
  }
  return (
    <span className="flex items-center gap-2">
      <SetButton
        variant="ghost"
        loading={busy === 'default'}
        disabled={busy !== null}
        onClick={() => void apply('default')}
      >
        {t('agents.traffic.compact.default')}
      </SetButton>
      <SetButton
        variant="primary"
        loading={busy === 'traffic'}
        disabled={busy !== null}
        onClick={() => void apply('traffic')}
      >
        {t('agents.traffic.compact.traffic')}
      </SetButton>
    </span>
  )
}

export function HandoffOffer({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.thread.handoffOffer)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ thread: { handoffOffer: v } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

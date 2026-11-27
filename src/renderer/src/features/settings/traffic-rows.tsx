// Huli: Settings › Agents › 省流量: every agent's auto-compact at once, set to the harness's
// default or to 省流量, and the offer of a handoff once a turn ends with a large context.

import { useTranslation } from 'react-i18next'
import { compactLabel, compactSpec, trafficPreset } from '@shared/auto-compact'
import { useHostScope } from '@renderer/stores/host-scope'
import type { GroupDef, RowDef } from './model'
import { CompactPreset, HandoffOffer } from './traffic-controls'

/** What the description names: each preset in its harness's unit. */
function presetLabel(harness: 'claude-code' | 'codex'): string {
  const spec = compactSpec(harness)
  const value = trafficPreset(harness)
  return spec && value !== null ? compactLabel(spec.unit, value) : ''
}

/** The group under the agent list. */
export function useTrafficRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const group: GroupDef = { id: 'traffic', label: t('agents.traffic.group') }
  return [
    {
      id: 'compact-preset',
      setting: 'agents.compact-preset',
      params: { claude: presetLabel('claude-code'), codex: presetLabel('codex') },
      group,
      render: () => <CompactPreset />,
    },
    // The offer shows in this computer's windows, whose settings hold it.
    ...(hostId === null
      ? [
          {
            id: 'handoff-offer',
            setting: 'agents.handoff-offer',
            group,
            render: () => <HandoffOffer label={t('agents.traffic.handoff.name')} />,
          } satisfies RowDef,
        ]
      : []),
  ]
}

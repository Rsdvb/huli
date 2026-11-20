// Huli: Settings > General's row for the import from the agents. Nothing is listed until its
// dialog opens. Huli's own; see tools/huli/README.md.

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from '@renderer/features/settings/model'
import { AgentHistoryButton } from './agent-history-entry'

export function useAgentHistoryRow(): RowDef {
  const { t } = useTranslation('agentHistory')
  const group: GroupDef = { id: 'agent-history', label: t('row.group') }
  return {
    id: 'agent-history',
    setting: 'general.agent-history',
    group,
    render: () => <AgentHistoryButton />,
  }
}

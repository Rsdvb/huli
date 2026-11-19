// Huli: Settings > General's row for the import from the agents. Nothing is listed until its
// dialog opens. Huli's own; see tools/huli/README.md.

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from '@renderer/features/settings/model'
import { i18n } from '@renderer/lib/i18n'
import { AgentHistoryButton } from './agent-history-entry'

export function useAgentHistoryRow(): RowDef {
  const { t } = useTranslation('agentHistory')
  const en = i18n.getFixedT('en', 'agentHistory')
  const group: GroupDef = { id: 'agent-history', label: t('row.group') }
  return {
    id: 'agent-history',
    name: t('row.name'),
    english: en('row.name'),
    description: t('row.description'),
    keywords: t('row.keywords'),
    group,
    render: () => <AgentHistoryButton />,
  }
}

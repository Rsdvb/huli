// Huli: Settings › Agents › Approvals, which requests the host allows once by itself.

import { useTranslation } from 'react-i18next'
import { AutoApproveChoice } from './auto-approve-rows'
import type { GroupDef, RowDef } from './model'

export function useAutoApproveRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const group: GroupDef = { id: 'approvals', label: t('agents.autoApprove.group') }
  return [
    {
      id: 'auto-approve',
      setting: 'agents.auto-approve',
      group,
      render: () => <AutoApproveChoice />,
    },
  ]
}

// Huli: Settings › Agents › Sandbox: the default tier with its network and folded details, and
// the switch that lets a sandboxed session's project edits through.

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from './model'
import { SandboxAutoApprove, SandboxDefault } from './sandbox-rows'

export function useSandboxRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const group: GroupDef = { id: 'sandbox', label: t('agents.sandbox.group') }
  return [
    {
      id: 'sandbox',
      setting: 'agents.sandbox',
      group,
      layout: 'block',
      render: (text) => <SandboxDefault text={text} />,
    },
    {
      // Drawn under the default's choice, which it belongs to.
      id: 'sandbox-network',
      setting: 'agents.sandbox-network',
      group,
      searchOnly: true,
      render: () => null,
    },
    {
      id: 'sandbox-auto-approve',
      setting: 'agents.sandbox-auto-approve',
      group,
      render: () => <SandboxAutoApprove />,
    },
  ]
}

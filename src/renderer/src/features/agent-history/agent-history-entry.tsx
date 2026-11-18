// Huli: the button of Settings > General's row for the import from the agents, which opens its
// dialog. Huli's own; see tools/huli/README.md.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SetButton } from '@renderer/features/settings/controls'
import { AgentHistoryDialog } from './agent-history-dialog'

export function AgentHistoryButton() {
  const { t } = useTranslation('agentHistory')
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetButton onClick={() => setOpen(true)}>{t('row.choose')}</SetButton>
      {open && <AgentHistoryDialog open={open} onOpenChange={setOpen} />}
    </>
  )
}

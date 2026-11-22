// Huli: the choice of which requests the host allows once by itself, and the confirmation the
// edits level asks before it is chosen, here or in a project's menu.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTO_APPROVE_LEVELS, type AutoApprove } from '@shared/risk'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

export function AutoApproveChoice() {
  const { t } = useTranslation('settings')
  // A host older than the setting sends none, which answers nothing by itself.
  const value = useHostScope().useSettingsStore((s) => s.settings.permissions?.autoApprove ?? 'off')
  const [apply, error] = useApply()
  const [confirming, setConfirming] = useState(false)
  const choose = (level: AutoApprove): void => {
    if (level === 'edits') setConfirming(true)
    else apply({ permissions: { autoApprove: level } })
  }
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('agents.autoApprove.name')}
        value={value}
        options={AUTO_APPROVE_LEVELS.map((level) => ({
          value: level,
          label: t(`agents.autoApprove.level.${level}`),
        }))}
        onChange={choose}
      />
      <EditsConfirm
        open={confirming}
        onAnswer={(confirmed) => {
          setConfirming(false)
          if (confirmed) apply({ permissions: { autoApprove: 'edits' } })
        }}
      />
    </>
  )
}

/** Asks before edits inside the project are allowed without asking too. */
export function EditsConfirm({
  open,
  onAnswer,
}: {
  open: boolean
  onAnswer: (confirmed: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onAnswer(false)}>
      <AlertDialogContent className="sm:max-w-[420px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('agents.autoApprove.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('agents.autoApprove.confirm.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onAnswer(true)}>
            {t('agents.autoApprove.confirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

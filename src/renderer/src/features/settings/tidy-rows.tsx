// Huli: Settings > General's rules for settling sessions by themselves (会话整理): whether idle
// sessions settle, after how many days, and whether a merged pull request settles one.

import { useTranslation } from 'react-i18next'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { SETTLE_DAYS, type TidySettings } from '@shared/session-tidy'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SettingSelect, SettingSwitch } from './controls'
import { useApply } from './use-apply'

function useTidy(): TidySettings {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.tidy) ?? DEFAULT_SETTINGS.tidy
}

export function AutoSettle({ label }: { label: string }) {
  const { autoSettle } = useTidy()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={autoSettle}
        onChange={(next) => apply({ tidy: { autoSettle: next } })}
      />
    </>
  )
}

export function SettleDaysChoice({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { idleDays, autoSettle } = useTidy()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={String(idleDays)}
        disabled={!autoSettle}
        options={SETTLE_DAYS.map((days) => ({
          value: String(days),
          label: t('general.settleDays.after', { count: days }),
        }))}
        onChange={(next) => {
          const days = SETTLE_DAYS.find((value) => String(value) === next)
          if (days !== undefined) apply({ tidy: { idleDays: days } })
        }}
      />
    </>
  )
}

export function SettleMerged({ label }: { label: string }) {
  const { merged, autoSettle } = useTidy()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={merged}
        disabled={!autoSettle}
        onChange={(next) => apply({ tidy: { merged: next } })}
      />
    </>
  )
}

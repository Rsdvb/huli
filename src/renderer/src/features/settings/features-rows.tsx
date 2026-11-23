// Huli: the controls of Settings > Features; the page is in features-section.tsx.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { featureOn, type FeatureId } from '@shared/features'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettings, openSettingsRow } from '@renderer/stores/view'
import { ControlError, Pill, SetButton, SettingSwitch } from './controls'

export function FeatureSwitch({
  id,
  label,
  held,
}: {
  id: FeatureId
  label: string
  held: boolean
}) {
  const on = useSettingsStore((s) => featureOn(s.settings.features, id))
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={on}
        disabled={held && on}
        onChange={(next) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ features: { [id]: next } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

/** Huli: administrator use is chosen on computer use's page; this row says how it stands. */
export function ComputerElevatedLink() {
  const { t } = useTranslation('settings')
  const mode = useSettingsStore((s) => s.settings.computerUse.elevated)
  return (
    <span className="flex items-center gap-2">
      <Pill tone={mode === 'always' ? 'warning' : 'neutral'}>
        {t(`computer.elevated.mode.${mode}`)}
      </Pill>
      <SetButton variant="ghost" onClick={() => openSettingsRow('computer-use', null, 'elevated')}>
        {t('features.computerElevated.open')}
      </SetButton>
    </span>
  )
}

/** Computer use keeps its own switch on its own page; this row says where and how it is. */
export function ComputerUseLink() {
  const { t } = useTranslation('settings')
  const on = useSettingsStore((s) => s.settings.computerUse.enabled)
  return (
    <span className="flex items-center gap-2">
      <Pill tone={on ? 'success' : 'neutral'}>
        {on ? t('features.computerUse.on') : t('features.computerUse.off')}
      </Pill>
      <SetButton variant="ghost" onClick={() => openSettings('computer-use')}>
        {t('features.computerUse.open')}
      </SetButton>
    </span>
  )
}

import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetButton, SettingSelect, SettingSwitch } from './controls'
import { useIslandState } from './island-state'
import { useApply } from './use-apply'

/** The notch island's switch, with Try again once it stopped after crashing. */
export function IslandSwitch({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const checked = useHostScope().useSettingsStore((s) => s.settings.notifications.island)
  const state = useIslandState()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      {checked && state.state === 'failed' && state.reason === 'crashed' && (
        <SetButton size="sm" onClick={() => void window.kettu.island.retry()}>
          {t('notifications.island.retry')}
        </SetButton>
      )}
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ notifications: { island: v } })}
      />
    </>
  )
}

type SidesChoice = 'auto' | 'notch' | 'off'

/**
 * Huli: what the island shows beside the notch, or the island turned off, as one menu: its
 * wings take only the room the menu bar leaves, or none.
 */
export function IslandSidesSelect({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const on = useHostScope().useSettingsStore((s) => s.settings.notifications.island)
  const sides = useHostScope().useSettingsStore((s) => s.settings.notifications.islandSides)
  const [apply, error] = useApply()
  const options: { value: SidesChoice; label: string }[] = [
    { value: 'auto', label: t('notifications.islandSides.auto') },
    { value: 'notch', label: t('notifications.islandSides.notch') },
    { value: 'off', label: t('notifications.islandSides.off') },
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={on ? sides : 'off'}
        options={options}
        onChange={(v) =>
          apply({
            notifications: v === 'off' ? { island: false } : { island: true, islandSides: v },
          })
        }
        className="k-select--wide"
      />
    </>
  )
}

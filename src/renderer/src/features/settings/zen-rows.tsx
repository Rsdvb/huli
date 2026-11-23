// Huli: Settings > General's default of how much of a turn's work a session shows (简洁视图).

import { useTranslation } from 'react-i18next'
import { TOOL_CALL_VIEWS } from '@shared/zen-view'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

export function ToolCallsChoice({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const value =
    useSettingsStore((s) => s.settings.thread.toolCalls) ?? DEFAULT_SETTINGS.thread.toolCalls
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={value}
        options={TOOL_CALL_VIEWS.map((view) => ({
          value: view,
          label: t(`general.toolCalls.${view}`),
        }))}
        onChange={(next) => {
          const view = TOOL_CALL_VIEWS.find((each) => each === next)
          if (view) apply({ thread: { toolCalls: view } })
        }}
      />
    </>
  )
}

// Huli: Settings > General's choices for keeping an eye on sessions: going on by itself after a
// plan limit resets, and what it sends then.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { RESUME_TEXT_CHARS, type SupervisorSettings } from '@shared/supervisor'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetInput, SettingSwitch } from './controls'
import { useApply } from './use-apply'

function useSupervisor(): SupervisorSettings {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.supervisor) ?? DEFAULT_SETTINGS.supervisor
}

export function ResumeAfterLimit({ label }: { label: string }) {
  const { resumeAfterLimit } = useSupervisor()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={resumeAfterLimit}
        onChange={(next) => apply({ supervisor: { resumeAfterLimit: next } })}
      />
    </>
  )
}

/** What a session sends to go on; saved as the field loses focus or Enter is pressed. */
export function ResumeText({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { resumeText, resumeAfterLimit } = useSupervisor()
  const [draft, setDraft] = useState<string | null>(null)
  const [apply, error] = useApply()
  const value = draft ?? resumeText
  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next !== resumeText) apply({ supervisor: { resumeText: next } })
  }
  return (
    <>
      <ControlError error={error} />
      <SetInput
        className="w-44"
        aria-label={label}
        placeholder={t('general.resumeText.placeholder')}
        maxLength={RESUME_TEXT_CHARS}
        value={value}
        disabled={!resumeAfterLimit}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            save()
          }
        }}
      />
    </>
  )
}

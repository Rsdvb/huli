import { useState } from 'react'
import { UserLock01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SavedStateSummary } from '@shared/browser'
import { Icon } from '@renderer/components/affect/app-shell'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { monthDayTime } from '@renderer/lib/format'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, Segmented, SetButton, Skel } from './controls'
import { ItemLine, Thing } from './rows'
import { useApply } from './use-apply'

/** Huli: whose browser data each session uses: everyone's, its worktree's, or its own. */
export function BrowserProfiles({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const value = useHostScope().useSettingsStore((s) => s.settings.browserProfiles.mode)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={label}
        value={value}
        options={[
          { value: 'shared', label: t('browser.profiles.shared') },
          { value: 'worktree', label: t('browser.profiles.worktree') },
          { value: 'session', label: t('browser.profiles.session') },
        ]}
        onChange={(mode) => apply({ browserProfiles: { mode } })}
      />
    </>
  )
}

/** Huli: in place of the saved sign-ins while they are read, or when there are none. */
export function SavedStatesEmpty({ loading }: { loading: boolean }) {
  const { t } = useTranslation('settings')
  if (loading) {
    return (
      <div className="k-block">
        <Skel width={160} />
      </div>
    )
  }
  return <p className="ui-ss-empty">{t('browser.savedStates.empty')}</p>
}

/** Huli: a saved sign-in: its name, its sites and when it was saved, and Delete. */
export function SavedStateRow({ state }: { state: SavedStateSummary }) {
  const { t } = useTranslation('settings')
  const [deleting, setDeleting] = useState(false)
  const remove = () => {
    setDeleting(true)
    window.kettu.browser
      .deleteSavedState(state.name)
      .then(() => toast(t('browser.savedStates.deleted', { name: state.name })))
      .catch((error: unknown) => {
        setDeleting(false)
        toast(errorMessage(error), undefined, { tone: 'warning' })
      })
  }
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={UserLock01Icon} size={20} />} name={state.name}>
        <ItemLine>
          {t('browser.savedStates.sites', {
            sites: state.sites.join(', '),
            date: monthDayTime(state.savedAt),
          })}
        </ItemLine>
      </Thing>
      <SetButton loading={deleting} onClick={remove}>
        {t('browser.savedStates.delete')}
      </SetButton>
    </div>
  )
}

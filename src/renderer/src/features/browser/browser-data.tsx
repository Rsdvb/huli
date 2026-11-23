import { useState } from 'react'
import { UserLock01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isStateName, MAX_STATE_NAME } from '@shared/browser-args'
import type { BrowserProfile } from '@shared/browser'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { toast } from '@renderer/components/ui/toast'
import { PaneIcon, PaneSpinner } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { openSettings } from '@renderer/stores/view'
import { useSavedStates } from './saved-states'

/**
 * Huli: the address row's browser data: whose cookies and storage the session's pages use, and the
 * saved sign-in states, saved from the shown tab's site or restored into the session's profile.
 */
export function BrowserDataButton({
  sessionId,
  profile,
  canSave,
}: {
  sessionId: string
  profile: BrowserProfile
  /** The shown tab has a site to save the sign-in of. */
  canSave: boolean
}) {
  const { t } = useTranslation('browser')
  const [open, setOpen] = useState(false)
  const states = useSavedStates(open)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const label = t('data.button')

  const save = () => {
    const trimmed = name.trim()
    if (!isStateName(trimmed)) return
    setBusy('save')
    window.kettu.browser
      .saveState(sessionId, trimmed)
      .then(() => {
        setName('')
        toast(t('data.saved', { name: trimmed }), undefined, { tone: 'success' })
      })
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
      .finally(() => setBusy(null))
  }
  const restore = (state: string) => {
    setBusy(state)
    window.kettu.browser
      .restoreState(sessionId, state)
      .then(({ cookies }) =>
        toast(t('data.restored', { name: state, count: cookies }), undefined, { tone: 'success' }),
      )
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
      .finally(() => setBusy(null))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className="kp-tool app-region-no-drag"
            data-profile={profile.kind}
          />
        }
      >
        <PaneIcon icon={UserLock01Icon} />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-80 max-w-[calc(100vw-32px)] p-0">
        <div className="kp-data">
          <div className="kp-data__head">
            <span className="kp-data__title">{t('data.title')}</span>
            <span className="kp-data__profile">
              {profile.kind === 'worktree'
                ? t('data.profile.worktree', { name: profile.label ?? '' })
                : t(`data.profile.${profile.kind}`)}
            </span>
          </div>
          <div className="kp-data__section">
            <span className="kp-data__label">{t('data.states')}</span>
            <form
              className="kp-data__save"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <input
                className="kp-data__input"
                value={name}
                maxLength={MAX_STATE_NAME}
                placeholder={t('data.namePlaceholder')}
                aria-label={t('data.nameLabel')}
                disabled={!canSave || busy !== null}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                type="submit"
                className="kp-btn kp-btn--sm kp-btn--solid"
                disabled={!canSave || busy !== null || !isStateName(name.trim())}
              >
                {busy === 'save' ? <PaneSpinner /> : t('data.save')}
              </button>
            </form>
            {!canSave && <p className="kp-data__note">{t('data.openSite')}</p>}
            {states === null ? (
              <div className="kp-data__loading">
                <PaneSpinner />
              </div>
            ) : states.length === 0 ? (
              <p className="kp-data__note">{t('data.none')}</p>
            ) : (
              <ul className="kp-data__list">
                {states.map((state) => (
                  <li key={state.name} className="kp-data__row">
                    <span className="kp-data__name">
                      <span className="truncate">{state.name}</span>
                      <span className="kp-data__sites truncate">{state.sites.join(', ')}</span>
                    </span>
                    <button
                      type="button"
                      className="kp-btn kp-btn--sm"
                      disabled={busy !== null}
                      onClick={() => restore(state.name)}
                    >
                      {busy === state.name ? <PaneSpinner /> : t('data.restore')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="kp-data__manage"
            onClick={() => {
              setOpen(false)
              openSettings('browser')
            }}
          >
            {t('data.manage')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Key01Icon,
  LinkSquare02Icon,
  SquareLock02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import {
  dotenvLine,
  MAX_SECRET_VALUE,
  secretValueProblem,
  type SecretField,
} from '@shared/secret-request'
import type { SecretRequestEntry as Entry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { openLinkIn } from '../open-link'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useAnswering } from './use-answering'

/**
 * Huli: an agent's request for secrets: a card of labelled fields while it waits, whose values go
 * straight to the host and from there where the card says, then one muted line of what came of it,
 * which names the variables and never a value.
 */
export const SecretRequestEntry = memo(function SecretRequestEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'secret_request')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <SecretCard sessionId={sessionId} entry={entry} agentName={agentName} className={animation} />
  ) : (
    <SecretLine entry={entry} className={animation} />
  )
})

/** A field's own Esc leaves the field, so it never declines the card. */
function keepEscape(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  if (event.key !== 'Escape' || !target.closest('input')) return
  event.stopPropagation()
  target.blur()
}

/** Why a field cannot go as it stands, or null; the host checks the same again. */
function fieldError(
  field: SecretField,
  value: string,
  saved: boolean,
  toFile: boolean,
  t: TFunction<'session'>,
): string | null {
  if (value.trim() === '') return saved || field.optional ? null : t('secretRequest.required')
  const problem = secretValueProblem(value)
  if (problem === 'long') return t('secretRequest.tooLong', { count: MAX_SECRET_VALUE })
  if (problem === 'line') return t('secretRequest.oneLine')
  if (toFile && dotenvLine(field.name, value.trim()) === null) return t('secretRequest.notDotenv')
  return null
}

function SecretCard({
  sessionId,
  entry,
  agentName,
  className,
}: {
  sessionId: string
  entry: Entry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const { answering, error, away, send } = useAnswering(sessionId)
  const card = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const [save, setSave] = useState(entry.saved.length > 0)
  const [tried, setTried] = useState(false)
  const busy = away || answering !== null
  const saved = new Set(entry.saved)
  const toFile = entry.target.kind === 'file'
  const errors = entry.fields.map((field) =>
    fieldError(field, draft[field.name] ?? '', saved.has(field.name), toFile, t),
  )
  const ready = errors.every((e) => e === null)

  useEffect(() => {
    revealWaiting(card.current)
  }, [])

  const provide = async (): Promise<void> => {
    if (busy) return
    setTried(true)
    if (!ready) throw new Error('not ready')
    const focused = !!card.current?.contains(document.activeElement)
    const values: Record<string, string> = {}
    const useSaved: string[] = []
    for (const field of entry.fields) {
      const value = (draft[field.name] ?? '').trim()
      if (value !== '') values[field.name] = value
      else if (saved.has(field.name)) useSaved.push(field.name)
    }
    const sent = await send('provide', () =>
      host('secrets.answer', {
        sessionId,
        entryId: entry.id,
        decision: 'provide',
        values,
        ...(useSaved.length > 0 ? { useSaved } : {}),
        ...(save ? { save: true } : {}),
      }),
    )
    // A card that did not go keeps waiting with what the user typed.
    if (!sent) throw new Error('not sent')
    setDraft({})
    if (focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const decline = (): void => {
    if (busy) return
    void send('decline', () =>
      host('secrets.answer', { sessionId, entryId: entry.id, decision: 'decline' }),
    )
  }

  const toggle = (name: string) =>
    setShown((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="min-w-0" onKeyDownCapture={keepEscape}>
        <ApprovalCard
          className="ks-plan ks-secret"
          title={entry.title}
          description={t('secretRequest.asks', { agent: agentName })}
          icon={<Icon icon={Key01Icon} size={15} />}
          label={t('secretRequest.label')}
          approveLabel={
            answering === 'provide' ? t('secretRequest.providing') : t('secretRequest.provide')
          }
          denyLabel={t('secretRequest.decline')}
          allowAlways={false}
          shortcuts
          status="pending"
          onApprove={provide}
          onDeny={decline}
          preview={
            <div className="ks-plan__preview">
              <p data-selectable="" className="ks-form__message">
                {entry.reason}
              </p>
              {entry.url && (
                <button
                  type="button"
                  className="ks-secret__open"
                  onClick={() => openLinkIn(entry.url!, 'browser', null)}
                >
                  <Icon icon={LinkSquare02Icon} size={13} />
                  {t('secretRequest.open')}
                </button>
              )}
              <div className="ks-form">
                {entry.fields.map((field, i) => {
                  const visible = field.plain === true || shown.has(field.name)
                  const isSaved = saved.has(field.name)
                  const problem = tried ? errors[i] : null
                  const id = `${entry.id}-${field.name}`
                  return (
                    <div key={field.name} className="contents">
                      <label htmlFor={id} className="ks-form__label">
                        {field.label}
                        <span className="ks-secret__name">
                          {field.name}
                          {field.optional && ` · ${t('secretRequest.optional')}`}
                        </span>
                      </label>
                      <div className="ks-form__field">
                        <div className="ks-secret__input">
                          <Input
                            id={id}
                            type={visible ? 'text' : 'password'}
                            value={draft[field.name] ?? ''}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={busy}
                            aria-invalid={!!problem}
                            placeholder={isSaved ? t('secretRequest.saved') : undefined}
                            className="h-8.5 rounded-xl font-mono text-row"
                            onChange={(event) =>
                              setDraft((d) => ({ ...d, [field.name]: event.target.value }))
                            }
                          />
                          {field.plain !== true && (
                            <button
                              type="button"
                              className="ks-secret__eye"
                              aria-label={t(visible ? 'secretRequest.hide' : 'secretRequest.show', {
                                label: field.label,
                              })}
                              aria-pressed={visible}
                              onClick={() => toggle(field.name)}
                            >
                              <Icon icon={visible ? ViewOffSlashIcon : ViewIcon} size={15} />
                            </button>
                          )}
                        </div>
                        {isSaved && (draft[field.name] ?? '') === '' && (
                          <span className="ks-form__hint">{t('secretRequest.usesSaved')}</span>
                        )}
                        {field.hint && <span className="ks-form__hint">{field.hint}</span>}
                        {problem && <span className="ks-form__error">{problem}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="ks-secret__target">
                {entry.target.kind === 'file' ? (
                  <Trans
                    t={t}
                    i18nKey="secretRequest.toFile"
                    values={{ path: entry.target.path }}
                    components={{ b: <b className="font-mono" /> }}
                  />
                ) : (
                  t('secretRequest.toEnv')
                )}
              </p>
              <label className="ks-secret__save">
                <Checkbox
                  checked={save}
                  disabled={busy}
                  onCheckedChange={(checked) => setSave(checked === true)}
                />
                <span>
                  {t('secretRequest.save')}
                  {entry.saved.length > 0 && !save && (
                    <span className="ks-form__hint"> · {t('secretRequest.forget')}</span>
                  )}
                </span>
              </label>
              <p className="ks-secret__privacy">
                <Icon icon={SquareLock02Icon} size={14} />
                <span>{t('secretRequest.privacy')}</span>
              </p>
            </div>
          }
        />
      </div>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** What came of a request, as one muted line: the variables given and where, or why none were. */
function SecretLine({ entry, className }: { entry: Entry; className?: string }) {
  const { t } = useTranslation('session')
  const outcome = entry.outcome!
  const provided = outcome.kind === 'provided'
  const names = provided ? outcome.names.join(', ') : ''
  const key = !provided
    ? 'secretRequest.declined'
    : entry.target.kind === 'file'
      ? 'secretRequest.providedFile'
      : 'secretRequest.providedEnv'
  const values = {
    names,
    title: entry.title,
    path: entry.target.kind === 'file' ? entry.target.path : '',
  }
  const notes = [
    provided && outcome.saved ? t('secretRequest.savedNote') : null,
    entry.device ? t('secretRequest.answeredOn', { device: entry.device.name }) : null,
    outcome.kind === 'expired' ? t('secretRequest.noAnswer') : null,
    outcome.kind === 'ended' ? t('secretRequest.ended') : null,
    outcome.kind === 'failed' ? outcome.message : null,
  ].filter((note): note is string => !!note)

  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="ks-settings-line">
        <HugeiconsIcon
          icon={provided ? CheckmarkCircle02Icon : CancelCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-3.5 shrink-0', provided && 'ks-settings-line__done')}
        />
        <span className="min-w-0 truncate">
          <Trans t={t} i18nKey={key} values={values} components={{ b: <b /> }} />
        </span>
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
      </div>
    </div>
  )
}

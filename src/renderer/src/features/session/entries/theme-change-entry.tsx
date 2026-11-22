import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  PaintBoardIcon,
  Undo02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { agentTheme, type AgentColors } from '@shared/theme-palette'
import { BUILTIN_THEME_ID, THEME_MODES, type Theme, type ThemeMode } from '@shared/themes'
import type { ThemeChangeEntry as Entry, ThemeState } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { startPreview, stopPreview, useThemesStore } from '@renderer/stores/themes'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useAnswering } from './use-answering'

/**
 * Huli: an agent's change to the theme colors: the card while it waits, with swatches of each
 * mode and a preview in this window, then one muted line of what came of it, with Undo while the
 * theme still stands as it left it.
 */
export const ThemeChangeEntry = memo(function ThemeChangeEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'theme_change')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <ThemeCard sessionId={sessionId} entry={entry} agentName={agentName} className={animation} />
  ) : (
    <ThemeLine sessionId={sessionId} entry={entry} className={animation} />
  )
})

/** The theme a state shows, as the window draws it; null for the built-in theme. */
function shownTheme(state: ThemeState): Theme | null {
  if (state.theme === BUILTIN_THEME_ID || !state.agent) return null
  return agentTheme(state.agent.name, state.agent.colors)
}

/** One mode's sheet: the canvas with a line of text, a quiet row and the accent's button. */
function Swatch({
  mode,
  theme,
  colors,
}: {
  mode: ThemeMode
  theme: Theme | null
  colors: AgentColors | null
}) {
  const { t } = useTranslation('session')
  const palette = theme?.[mode].colors ?? {}
  const own = colors?.[mode]
  const style = own
    ? {
        background: palette['bg-app'],
        borderColor: palette['border-default'],
        color: palette['text-primary'],
      }
    : undefined
  return (
    <figure className="ks-theme__swatch">
      <div className="ks-theme__sheet" data-theme={mode} style={style} aria-hidden>
        <span
          className="ks-theme__ink"
          style={own ? { background: palette['text-primary'] } : undefined}
        />
        <span
          className="ks-theme__quiet"
          style={own ? { background: palette['text-tertiary'] } : undefined}
        />
        <span className="ks-theme__accent" style={own ? { background: palette.send } : undefined} />
      </div>
      <figcaption className="ks-theme__caption">
        <b>{t(mode === 'light' ? 'themeChange.light' : 'themeChange.dark')}</b>
        {own ? (
          <span className="font-mono">
            {own.canvas} · {own.accent}
          </span>
        ) : (
          <span>{t('themeChange.builtIn')}</span>
        )}
      </figcaption>
    </figure>
  )
}

function ThemeCard({
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
  const previewing = useThemesStore((s) => s.preview === entry.id)
  const theme = useMemo(() => shownTheme(entry.to), [entry.to])
  const reset = entry.to.theme === BUILTIN_THEME_ID
  // Apply was given here or elsewhere: the card holds until the host says what came of it.
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    revealWaiting(card.current)
  }, [])
  // A preview never outlives its card.
  useEffect(() => () => stopPreview(entry.id), [entry.id])

  const answer = async (decision: 'apply' | 'keep'): Promise<void> => {
    if (away || answering !== null || applying) return
    stopPreview(entry.id)
    const focused = !!card.current?.contains(document.activeElement)
    const sent = await send(decision, () =>
      host('theme.answerChange', { sessionId, entryId: entry.id, decision }),
    )
    if (sent && decision === 'apply') setApplying(true)
    if (!sent) throw new Error('not sent')
    if (focused) emitAppEvent({ kind: 'focus-composer' })
  }

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <ApprovalCard
        className="ks-plan ks-theme"
        title={reset ? t('themeChange.reset') : t('themeChange.title')}
        description={t('themeChange.who', { agent: agentName })}
        icon={<Icon icon={PaintBoardIcon} size={15} />}
        label={t('themeChange.label')}
        approveLabel={applying ? t('themeChange.applying') : t('themeChange.apply')}
        denyLabel={t('themeChange.keep')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={() => answer('apply')}
        onDeny={() => void answer('keep').catch(() => {})}
        preview={
          <div className="ks-plan__preview">
            {!reset && (
              <p className="ks-form__message" data-selectable="">
                {entry.to.name}
              </p>
            )}
            <div className="ks-theme__swatches">
              {THEME_MODES.map((mode) => (
                <Swatch
                  key={mode}
                  mode={mode}
                  theme={theme}
                  colors={reset ? null : (entry.to.agent?.colors ?? null)}
                />
              ))}
            </div>
            <div className="ks-theme__row">
              <Button
                variant="outline"
                size="sm"
                aria-pressed={previewing}
                disabled={answering !== null || applying}
                onClick={() => (previewing ? stopPreview(entry.id) : startPreview(entry.id, theme))}
              >
                <Icon icon={ViewIcon} size={14} />
                {previewing ? t('themeChange.previewing') : t('themeChange.preview')}
              </Button>
              <span className="ks-form__hint">{t('themeChange.note')}</span>
            </div>
          </div>
        }
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Whether the theme still stands as the change left it, as far as this window can tell. */
function useStands(entry: Entry): boolean {
  return useThemesStore((s) => {
    if (s.state.chosen !== entry.to.theme) return false
    if (entry.to.theme === BUILTIN_THEME_ID) return true
    const shown = s.state.installed.find((theme) => theme.id === entry.to.theme)
    return shown?.theme.name === entry.to.name
  })
}

/** What came of a change, as one muted line: made, undone or not, and Undo while it stands. */
function ThemeLine({
  sessionId,
  entry,
  className,
}: {
  sessionId: string
  entry: Entry
  className?: string
}) {
  const { t } = useTranslation('session')
  const [undoing, setUndoing] = useState(false)
  const outcome = entry.outcome!
  const changed = outcome.kind === 'changed'
  const undone = changed && outcome.undone === true
  const live = changed && !undone && outcome.stale !== true
  const stands = useStands(entry)
  const key = undone
    ? 'themeChange.undone'
    : changed
      ? entry.to.theme === BUILTIN_THEME_ID
        ? 'themeChange.resetDone'
        : 'themeChange.changed'
      : 'themeChange.notChanged'
  const notes = [
    entry.device ? t('themeChange.answeredOn', { device: entry.device.name }) : null,
    outcome.kind === 'expired' ? t('themeChange.noAnswer') : null,
    outcome.kind === 'failed' ? outcome.message : null,
  ].filter((note): note is string => !!note)

  const undo = async (): Promise<void> => {
    setUndoing(true)
    try {
      await host('theme.undoChange', { sessionId, entryId: entry.id })
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="ks-settings-line">
        <HugeiconsIcon
          icon={undone ? Undo02Icon : changed ? CheckmarkCircle02Icon : CancelCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-3.5 shrink-0', changed && !undone && 'ks-settings-line__done')}
        />
        <span className="min-w-0 truncate">
          <Trans t={t} i18nKey={key} values={{ name: entry.to.name }} components={{ b: <b /> }} />
        </span>
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
        {live && stands && (
          <Button
            variant="quiet"
            size="xs"
            disabled={undoing}
            className="ks-settings-line__undo"
            onClick={() => void undo()}
          >
            <Icon icon={Undo02Icon} size={12} />
            {t('themeChange.undo')}
          </Button>
        )}
      </div>
    </div>
  )
}

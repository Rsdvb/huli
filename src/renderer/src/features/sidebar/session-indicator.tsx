import { Alert02Icon, Clock01Icon, HourglassIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { KnownExpiry } from '@shared/prompt-cache'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { CacheRing } from './cache-status'
import type { RowStatus } from './row-status'
import { WaitingCount } from './waiting-mark'

/**
 * One status per row, by priority: waiting for you, a turn that may be stuck, paused at the plan
 * limit, error, running (the turn's nine dots), starting, prompt cache expiring, unread (App
 * Shell's blue dot). Its 16 px slot stays when there is none, so a status appearing never moves
 * the title.
 */
export function SessionIndicator({
  status,
  expiring,
  waitingApart = false,
  className,
}: {
  status: RowStatus
  /** The session's prompt cache, in its last minutes. */
  expiring: KnownExpiry | null
  /** The row shows its wait as a button of its own over this slot, which then stays empty. */
  waitingApart?: boolean
  className?: string
}) {
  const { t } = useTranslation('sidebar')

  let mark = null
  if (status.waiting > 0) {
    mark = waitingApart ? null : (
      <span role="img" aria-label={t('indicator.waiting', { count: status.waiting })}>
        <WaitingCount count={status.waiting} />
      </span>
    )
  } else if (status.stalled) {
    mark = (
      <span role="img" aria-label={t('indicator.stalled')} className="grid text-warning">
        <Glyph icon={HourglassIcon} size={14} />
      </span>
    )
  } else if (status.paused) {
    mark = (
      <span role="img" aria-label={t('indicator.paused')} className="grid text-warning">
        <Glyph icon={Clock01Icon} size={14} />
      </span>
    )
  } else if (status.failed) {
    mark = (
      <span role="img" aria-label={t('indicator.error')} className="grid text-danger">
        <Glyph icon={Alert02Icon} size={14} />
      </span>
    )
  } else if (status.running || status.starting) {
    mark = (
      <span
        role="img"
        aria-label={t(status.running ? 'indicator.running' : 'indicator.starting')}
        className="grid"
      >
        <TurnDots phase={status.running ? 'working' : 'thinking'} />
      </span>
    )
  } else if (expiring) {
    mark = <CacheRing cache={expiring} />
  } else if (status.unread) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.unread')}
        className="size-1.5 rounded-full bg-(--accent)"
      />
    )
  }

  return (
    <span
      className={cn(
        'ml-auto grid size-4 shrink-0 place-items-center transition-opacity duration-(--duration-fast)',
        className,
      )}
    >
      {mark}
    </span>
  )
}

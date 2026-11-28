import type { ReactNode } from 'react'
import {
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { reportedTurns, type FromSession, type ReportedTurn, type StopReason } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { useClock } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { hostOfSession } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { reportState, type ReportState } from './helpers'
import {
  openSessionReport,
  sessionReportDisplay,
  useSender,
  type SessionReportTime,
} from './session-report'
import { TurnEndTag } from './turn-end-tag'

const dayStart = (now: number): number => new Date(now).setHours(0, 0, 0, 0)

/**
 * A message another session's agent sent: a quoted card on the agent's side of the thread, so the
 * user's own bubble at the right stays the only one. Its title opens the sender.
 */
export function FromSessionCard({ from, children }: { from: FromSession; children: ReactNode }) {
  const { t } = useTranslation('session')
  const sender = useSender(from.sessionId)
  const title = sender?.title ?? from.title
  return (
    <figure className="ks-from">
      <figcaption className="ks-from__head">
        {/* Huli: a handoff's summary says the session carries on from its sender (接力). */}
        {from.handoff && <span className="shrink-0">{t('handoff.from')}</span>}
        {sender && <AgentMark agent={sender.agentId} size={14} hostId={hostOfSession(sender)} />}
        {sender ? (
          <button
            type="button"
            className="min-w-0 truncate rounded-sm outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
            onClick={() => openSession(sender.id, sender.projectPath)}
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <HugeiconsIcon
          icon={ArrowTurnBackwardIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3 shrink-0"
        />
      </figcaption>
      {children}
    </figure>
  )
}

/**
 * A message Kettu itself wrote to the agent, such as a workflow step's prompt or reminder: the same
 * quoted card on the agent's side, headed by Kettu's own mark, since the user never wrote it.
 */
export function KettuCard({ children }: { children: ReactNode }) {
  const { t } = useTranslation('session')
  return (
    <figure className="ks-from">
      <figcaption className="ks-from__head">
        <BrandIcon size={14} />
        <span className="min-w-0 truncate">{t('userEntry.kettu')}</span>
      </figcaption>
      {children}
    </figure>
  )
}

/**
 * Kettu's report that a turn the session asked for ended: an event line like the thread's other
 * ones, since it is not something anyone said, which says the agent was told. It is drawn from
 * the report's fields, never from the sentence the agent was sent. Huli: a report of several
 * turns names each session under it.
 */
export function ReportLine({
  from,
  end,
  className,
}: {
  from: FromSession
  /** How the turn the report started ended, when it got no reply. */
  end?: { stopReason: StopReason; durationMs: number }
  className?: string
}) {
  const { t } = useTranslation('session')
  const turns = reportedTurns(from)
  const first = turns[0]
  const sender = useSender(first?.sessionId ?? '')
  const today = useClock(dayStart)
  if (!first) return null
  const many = turns.length > 1
  const state = many ? worstState(turns) : reportState(first.stopReason)
  const title = sender?.title ?? first.title
  const display = sessionReportDisplay(first, title, today)
  return (
    <div className={cn('flex flex-col', className)} data-selectable="">
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-ui text-muted-foreground">
        <ReportIcon state={state} />
        <span className="min-w-0 truncate">
          {many ? (
            t('sessionReport.many', { count: turns.length })
          ) : (
            <Trans
              t={t}
              i18nKey={`sessionReport.line.${state}`}
              values={{ title }}
              components={{
                title: <SessionLink sender={sender} turn={first} label={display.openLabel} />,
              }}
            />
          )}
          {!many && display.roundLabel && (
            <span className="tabular-nums"> · {display.roundLabel}</span>
          )}
          <span aria-hidden> · </span>
          {t('sessionReport.told')}
        </span>
        {!many && <ReportTime time={display.time} />}
      </div>
      {many && (
        <ul className="flex flex-col pl-5.5">
          {turns.map((turn, index) => (
            <ReportedRow key={`${turn.sessionId}:${turn.round ?? index}`} turn={turn} />
          ))}
        </ul>
      )}
      {end && <TurnEndTag stopReason={end.stopReason} durationMs={end.durationMs} />}
    </div>
  )
}

/**
 * One session of a report of several: how its turn ended, and its title, which opens it at the
 * round it reports.
 */
function ReportedRow({ turn }: { turn: ReportedTurn }) {
  const { t } = useTranslation('session')
  const sender = useSender(turn.sessionId)
  const today = useClock(dayStart)
  const state = reportState(turn.stopReason)
  const title = sender?.title ?? turn.title
  const display = sessionReportDisplay(turn, title, today)
  return (
    <li className="flex min-h-6 min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <ReportIcon state={state} />
      <span className="min-w-0 truncate">
        <SessionLink sender={sender} turn={turn} label={display.openLabel} arrow>
          {title}
        </SessionLink>
        {display.roundLabel && <span className="tabular-nums"> · {display.roundLabel}</span>}
      </span>
      <span className="shrink-0">{t(`sessionReport.state.${state}`)}</span>
      <ReportTime time={display.time} />
    </li>
  )
}

/** When a reported round finished: its clock time today, else its day too. */
function ReportTime({ time }: { time: SessionReportTime | null }) {
  if (!time) return null
  return (
    <time
      dateTime={time.iso}
      title={time.title}
      className="shrink-0 text-xs text-muted-foreground tabular-nums"
    >
      {time.label}
    </time>
  )
}

/** The state a report of several turns leads with: a failure first, then a stop. */
function worstState(turns: readonly ReportedTurn[]): ReportState {
  const states = turns.map((turn) => reportState(turn.stopReason))
  if (states.every((state) => state === 'finished')) return 'finished'
  if (states.every((state) => state === 'finished' || state === 'stopped')) return 'stopped'
  return 'failed'
}

function ReportIcon({ state }: { state: ReportState }) {
  const done = state === 'finished'
  const stopped = state === 'stopped'
  return (
    <HugeiconsIcon
      icon={done ? CheckmarkCircle02Icon : stopped ? StopCircleIcon : AlertCircleIcon}
      strokeWidth={1.9}
      aria-hidden
      className={cn(
        'size-3.5 shrink-0',
        done && 'text-success',
        !done && !stopped && 'text-danger',
      )}
    />
  )
}

/**
 * A reported session's title, which opens it while Kettu still holds it, at the reported round
 * when the report names one; quoted in a sentence, it goes without the arrow.
 */
function SessionLink({
  sender,
  turn,
  label,
  arrow = false,
  children,
}: {
  sender: ReturnType<typeof useSender>
  turn: ReportedTurn
  label: string
  arrow?: boolean
  children?: ReactNode
}) {
  if (!sender) return <span className="font-medium">{children}</span>
  return (
    <button
      type="button"
      className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:underline"
      aria-label={label}
      title={label}
      onClick={() => openSessionReport(sender, turn)}
    >
      {children}
      {arrow && (
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="ml-0.5 inline-block size-3 align-middle text-muted-foreground"
        />
      )}
    </button>
  )
}

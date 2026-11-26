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
import { useShallow } from 'zustand/react/shallow'
import { reportedTurns, type FromSession, type ReportedTurn, type StopReason } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { cn } from '@renderer/lib/utils'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { reportState, type ReportState } from './helpers'
import { TurnEndTag } from './turn-end-tag'

/** The session a message or report came from, while Kettu still holds it. */
function useSender(sessionId: string) {
  return useSessionsStore(
    useShallow((s) => {
      const sender = s.byId[sessionId]
      return sender
        ? {
            id: sender.id,
            title: sessionTitle(sender),
            agentId: sender.agentId,
            projectPath: sender.projectPath,
          }
        : null
    }),
  )
}

/**
 * A message another session's agent sent: a quoted card on the agent's side of the thread, so the
 * user's own bubble at the right stays the only one. Its title opens the sender.
 */
export function FromSessionCard({ from, children }: { from: FromSession; children: ReactNode }) {
  useTranslation('session')
  const sender = useSender(from.sessionId)
  const title = sender?.title ?? from.title
  return (
    <figure className="ks-from">
      <figcaption className="ks-from__head">
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
  if (!first) return null
  const many = turns.length > 1
  const state = many ? worstState(turns) : reportState(first.stopReason)
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
              values={{ title: sender?.title ?? first.title }}
              components={{ title: <SessionLink sender={sender} /> }}
            />
          )}
          <span aria-hidden> · </span>
          {t('sessionReport.told')}
        </span>
      </div>
      {many && (
        <ul className="flex flex-col pl-5.5">
          {turns.map((turn) => (
            <ReportedRow key={turn.sessionId} turn={turn} />
          ))}
        </ul>
      )}
      {end && <TurnEndTag stopReason={end.stopReason} durationMs={end.durationMs} />}
    </div>
  )
}

/** One session of a report of several: how its turn ended, and its title, which opens it. */
function ReportedRow({ turn }: { turn: ReportedTurn }) {
  const { t } = useTranslation('session')
  const sender = useSender(turn.sessionId)
  const state = reportState(turn.stopReason)
  return (
    <li className="flex min-h-6 min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <ReportIcon state={state} />
      <span className="min-w-0 truncate">
        <SessionLink sender={sender}>{sender?.title ?? turn.title}</SessionLink>
      </span>
      <span className="shrink-0">{t(`sessionReport.state.${state}`)}</span>
    </li>
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

/** A reported session's title, which opens it while Kettu still holds it. */
function SessionLink({
  sender,
  children,
}: {
  sender: ReturnType<typeof useSender>
  children?: ReactNode
}) {
  if (!sender) return <span className="font-medium">{children}</span>
  return (
    <button
      type="button"
      className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:underline"
      onClick={() => openSession(sender.id, sender.projectPath)}
    >
      {children}
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        strokeWidth={1.9}
        aria-hidden
        className="ml-0.5 inline-block size-3 align-middle text-muted-foreground"
      />
    </button>
  )
}

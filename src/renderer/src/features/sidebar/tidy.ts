// Huli: snoozing and settling sessions from the sidebar and the session menus (会话整理): each takes
// the sessions out of the active list with Undo for five seconds, which puts back what they were.

import { AlarmClockIcon, InboxDownloadIcon } from '@hugeicons/core-free-icons'
import { create } from 'zustand'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { planQuota } from '@shared/plan-quota'
import type { SnoozeUntil } from '@shared/session-tidy'
import { settleSession, snoozeSession } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { backTime } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { settle } from './session-menu-model'
import { undoToast } from './undo'

/** What a session's snooze or settle was before a change, which Undo puts back. */
type Before = Pick<SessionSummary, 'id' | 'snooze' | 'settled'>

function before(ids: readonly string[]): Before[] {
  const { byId } = useSessionsStore.getState()
  return ids.flatMap((id) => {
    const s = byId[id]
    return s ? [{ id, snooze: s.snooze ?? null, settled: s.settled ?? null }] : []
  })
}

/** Puts a session's snooze or settle back as it was before `change`. */
function restore(was: Before, change: 'snooze' | 'settle'): Promise<void> {
  if (was.snooze) return snoozeSession(was.id, was.snooze.reset ? 'reset' : was.snooze.until)
  if (was.settled) return settleSession(was.id, true)
  return change === 'snooze' ? snoozeSession(was.id, null) : settleSession(was.id, false)
}

function undoAll(done: readonly Before[], change: 'snooze' | 'settle'): void {
  void settle(
    done.map((was) => was.id),
    (id) =>
      restore(
        done.find((was) => was.id === id)!,
        change,
      ),
  ).then(({ errors }) => {
    if (errors.length > 0) toast(errorMessage(errors[0]))
  })
}

/** The one session's title, or null for several. */
function titleOf(ids: readonly string[]): string | null {
  if (ids.length !== 1) return null
  const summary = useSessionsStore.getState().byId[ids[0]!]
  return summary ? sessionTitle(summary) : null
}

/** Snoozes the sessions until `until`, a time or their agent's plan reset, with Undo. */
export function snoozeWithUndo(ids: readonly string[], until: Exclude<SnoozeUntil, null>): void {
  const was = before(ids)
  const title = titleOf(ids)
  void settle(ids, (id) => snoozeSession(id, until)).then(({ done, errors }) => {
    if (done.length === 0) {
      if (errors.length > 0) toast(errorMessage(errors[0]))
      return
    }
    const back = useSessionsStore.getState().byId[done[0]!]?.snooze?.until
    const time = typeof until === 'number' ? until : back
    const text =
      title === null
        ? i18n.t('sidebar:tidy.snoozedCount', { count: done.length })
        : time !== undefined
          ? i18n.t('sidebar:tidy.snoozed', { title, time: backTime(time) })
          : i18n.t('sidebar:tidy.snoozedReset', { title })
    undoToast(
      errors.length > 0 ? `${text} ${errorMessage(errors[0])}` : text,
      () =>
        undoAll(
          was.filter((item) => done.includes(item.id)),
          'snooze',
        ),
      AlarmClockIcon,
    )
  })
}

/** Brings snoozed sessions back now, which needs no Undo. */
export function wakeNow(ids: readonly string[]): void {
  void settle(ids, (id) => snoozeSession(id, null)).then(({ errors }) => {
    if (errors.length > 0) toast(errorMessage(errors[0]))
  })
}

/** Settles the sessions out of the active list, with Undo. */
export function settleWithUndo(ids: readonly string[]): void {
  const was = before(ids)
  const title = titleOf(ids)
  void settle(ids, (id) => settleSession(id, true)).then(({ done, errors }) => {
    if (done.length === 0) {
      if (errors.length > 0) toast(errorMessage(errors[0]))
      return
    }
    const text =
      title === null
        ? i18n.t('sidebar:tidy.settledCount', { count: done.length })
        : i18n.t('sidebar:tidy.settled', { title })
    undoToast(
      errors.length > 0 ? `${text} ${errorMessage(errors[0])}` : text,
      () =>
        undoAll(
          was.filter((item) => done.includes(item.id)),
          'settle',
        ),
      InboxDownloadIcon,
    )
  })
}

/** Brings settled sessions back to the active list. */
export function unsettle(ids: readonly string[]): void {
  void settle(ids, (id) => settleSession(id, false)).then(({ errors }) => {
    if (errors.length > 0) toast(errorMessage(errors[0]))
  })
}

/**
 * When the session's agent's plan comes back, as 额度恢复后 would snooze it, a minute after the
 * reset as the host counts it; null when no reset is known, and the choice is not offered.
 */
export function planReturns(
  summary: Pick<SessionSummary, 'limitPause'>,
  agent: Pick<AgentStatus, 'limits' | 'balances'> | undefined,
  now: number,
): number | null {
  const quota = agent ? planQuota(agent, now) : null
  const reset =
    summary.limitPause?.resetsAt ??
    (quota?.kind === 'out' || quota?.kind === 'extra' ? quota.resetsAt : null)
  return reset !== null && reset > now ? reset + 60_000 : null
}

/** The sessions the custom snooze dialog is open for; empty while it is closed. */
export const useSnoozeAsk = create<{ ids: readonly string[]; asked: boolean }>(() => ({
  ids: [],
  asked: false,
}))

/** Opens the dialog that picks a day and time to snooze the sessions until. */
export function askSnoozeTime(ids: readonly string[]): void {
  useSnoozeAsk.setState({ ids, asked: true })
}

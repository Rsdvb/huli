// Huli: snoozing and settling sessions on the phone (会话整理), as the desktop's menus do: the quick
// times with when each comes back, more times in place of a picker, and the words of the notices.

import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { SnoozePreset } from '@shared/session-tidy'
import { momentText } from './ui/session/format'

export const PRESET_LABEL: Record<SnoozePreset, string> = {
  hour: '1 小时后',
  tonight: '今晚',
  tomorrow: '明天早上',
  monday: '下周一',
}

const HOUR_MS = 3_600_000

/** More times past the quick ones, each with when it comes back. */
export function laterTimes(now: number): { key: string; label: string; until: number }[] {
  const at = (days: number, hour: number): number => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    date.setHours(hour, 0, 0, 0)
    return date.getTime()
  }
  // Sunday is 0: the coming Saturday, a week on from a Saturday.
  const saturday = (6 - new Date(now).getDay() + 7) % 7 || 7
  return [
    { key: '3h', label: '3 小时后', until: now + 3 * HOUR_MS },
    { key: 'afternoon', label: '明天下午', until: at(1, 14) },
    { key: 'after', label: '后天早上', until: at(2, 9) },
    { key: 'saturday', label: '周六早上', until: at(saturday, 9) },
    { key: 'week', label: '一周后', until: at(7, 9) },
    { key: 'weeks', label: '两周后', until: at(14, 9) },
  ]
}

/** When a snoozed session comes back, as its row and menu say it. */
export function backText(summary: Pick<SessionSummary, 'snooze'>, now = Date.now()): string | null {
  return summary.snooze ? `${momentText(summary.snooze.until, now)} 提醒` : null
}

/** Whether the session sits in a group out of the list: snoozed or settled, and not archived. */
export function parked(summary: SessionSummary): 'snoozed' | 'settled' | null {
  if (summary.archivedAt !== null) return null
  return summary.snooze ? 'snoozed' : summary.settled ? 'settled' : null
}

/** Puts a session's snooze or settle back as it was before `change`, as Undo does. */
export function restoreTidy(
  link: HostLink,
  s: SessionSummary,
  change: 'snooze' | 'settle',
): Promise<unknown> {
  if (s.snooze) {
    return link.request('sessions.snooze', {
      sessionId: s.id,
      until: s.snooze.reset ? 'reset' : s.snooze.until,
    })
  }
  if (s.settled) return link.request('sessions.settle', { sessionId: s.id, settled: true })
  return change === 'snooze'
    ? link.request('sessions.snooze', { sessionId: s.id, until: null })
    : link.request('sessions.settle', { sessionId: s.id, settled: false })
}

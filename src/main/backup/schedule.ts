// Huli: when the daily backup runs. It is due each day at the set local time; a day whose time
// passed while the computer was off or the app was closed is caught up once, at the next chance.

const DAY_MS = 24 * 60 * 60 * 1000

function timeParts(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(':').map(Number)
  return { hours: hours ?? 0, minutes: minutes ?? 0 }
}

/** The day's moment at `time` in local time; a clock change that skips it moves it forward. */
function onDay(day: Date, time: string): number {
  const { hours, minutes } = timeParts(time)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes).getTime()
}

/** The latest moment the backup was due at or before `now`. */
export function lastDue(now: number, time: string): number {
  const today = onDay(new Date(now), time)
  if (today <= now) return today
  return onDay(new Date(now - DAY_MS), time)
}

/** The next moment the backup is due after `now`. */
export function nextDue(now: number, time: string): number {
  const today = onDay(new Date(now), time)
  if (today > now) return today
  // A day later by the calendar, which a clock change makes 23 or 25 hours.
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return onDay(tomorrow, time)
}

/**
 * Whether a backup is owed now: the last due moment came after the last attempt, as when the
 * computer was off then. One attempt pays it, so a day missed is caught up once, not once a day.
 */
export function isOwed(now: number, time: string, lastAttempt: number | null): boolean {
  return lastAttempt === null || lastAttempt < lastDue(now, time)
}

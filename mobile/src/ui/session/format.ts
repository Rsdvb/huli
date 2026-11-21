// Small text helpers of the session screens: times as a Chinese phone shows them, and paths.
//
// Times read one way everywhere on the phone, as the desktop's Chinese says them
// (src/renderer/src/lib/format.ts):
// - The clock names the part of the day, by Chinese's own periods (CLDR's, which the desktop's
//   Intl gives): 凌晨3:54, 早上7:54, 上午11:54, 中午12:54, 下午2:54, 晚上9:54.
// - A day other than today is 昨天 or 明天, the weekday within six days, else the date: 11月3日,
//   with its year when not this one.
// - A moment (momentText) is its day and then its clock, the clock alone today: 下午2:54,
//   昨天 下午2:54, 周三 下午2:54, 11月3日 下午2:54.
// - A list's time column (listTime) is today's clock, else the day alone.
// - How long since (ago), for a status line, is 刚刚 or minutes within the hour, else as a list.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** The part of the day an hour falls in, as Chinese names it. */
export function dayPeriod(hour: number): string {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 12) return '上午'
  if (hour < 13) return '中午'
  if (hour < 19) return '下午'
  return '晚上'
}

/** The time of day: 下午2:54. */
export function clockOf(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${dayPeriod(h)}${h12}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Calendar days from `now` to `ms`: 0 the same day, -1 the day before, 1 the day after. */
function daysFrom(now: number, ms: number): number {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  // Rounded, since a day across a DST change is not 24 hours.
  return Math.round((day(ms) - day(now)) / 86_400_000)
}

/** The day of `ms` other than today, in words; null for today. */
function dayWords(ms: number, now: number): string | null {
  const days = daysFrom(now, ms)
  if (days === 0) return null
  if (days === -1) return '昨天'
  if (days === 1) return '明天'
  const d = new Date(ms)
  if (Math.abs(days) <= 6) return WEEKDAYS[d.getDay()]!
  const date = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${d.getFullYear()}年${date}`
}

/** A moment, past or to come: its day and its clock, today the clock alone. */
export function momentText(ms: number, now = Date.now()): string {
  const day = dayWords(ms, now)
  return day ? `${day} ${clockOf(ms)}` : clockOf(ms)
}

/** When something happened, as a list's time column shows it: today's clock, else the day. */
export function listTime(ms: number, now = Date.now()): string {
  return dayWords(ms, now) ?? clockOf(ms)
}

/** How long since, for a status line: 刚刚, 5 分钟前, then as listTime. */
export function ago(ms: number, now = Date.now()): string {
  const since = Math.max(0, now - ms)
  if (since < MINUTE) return '刚刚'
  if (since < HOUR) return `${Math.floor(since / MINUTE)} 分钟前`
  return listTime(ms, now)
}

/**
 * How long something took, the one way the session screens say it, as the desktop's Chinese does:
 * 「12 秒」「1 分 3 秒」「1 小时 5 分」「2 天 3 小时」. With `tenths`, for a step's time, under a
 * minute it says tenths of a second: 「0.4 秒」「12.3 秒」.
 */
export function durationText(ms: number, tenths = false): string {
  const at = Math.max(0, ms)
  if (tenths && at < 60_000) return `${(Math.floor(at / 100) / 10).toFixed(1)} 秒`
  const s = Math.round(at / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
  return h % 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${Math.floor(h / 24)} 天`
}

/**
 * How long something running has gone, for a count redrawn every 15 seconds: whole seconds through
 * its first minute, then `durationText` to the minute, so no shown second jumps by fifteen.
 */
export function elapsedText(ms: number): string {
  const at = Math.max(0, ms)
  return durationText(at < 60_000 ? at - (at % 1000) : at - (at % 60_000))
}

/** `durationText`, by the name the session screens first gave it. */
export const spanText = (ms: number): string => durationText(ms)

/** "1:05", for a clock that ticks. */
export function tickText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : ''
}

/** The path under `root` when it lies there, else the path as it is. */
export function relativePath(path: string, root: string | null): string {
  if (!root) return path
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(path)
  const b = norm(root)
  const windows = /^[a-z]:\//i.test(b)
  const same = windows ? a.toLowerCase().startsWith(`${b.toLowerCase()}/`) : a.startsWith(`${b}/`)
  if (!same) return path
  const rest = path.slice(b.length + 1)
  return rest || path
}

export function extensionOf(name: string): string {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

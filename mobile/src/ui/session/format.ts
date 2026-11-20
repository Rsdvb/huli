// Small text helpers of the session screens: times as a Chinese phone shows them, and paths.

/** "晚上 9:52", with the date in front when it is not today. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const part = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上'
  const hour = h % 12 === 0 ? 12 : h % 12
  const time = `${part} ${hour}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return time
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
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

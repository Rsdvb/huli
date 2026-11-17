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

/** "14 分钟 43 秒". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} 分钟 ${s % 60} 秒` : `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
}

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

import type { SessionSummary } from '@shared/agent-host'
import type { Theme } from './theme'

export function needsYou(s: SessionSummary): boolean {
  // Huli: open requests only, as the desktop counts them. Claude Code's status can stay
  // `awaiting_permission` after a sub-agent's request is withdrawn, with nothing left to answer.
  return s.permissionCount > 0 || s.attention === 'permission'
}

/**
 * The sessions with what their sub-sessions and sub-agents wait for, at any depth, counted on them,
 * as the desktop's sidebar counts them on the row that shows them: a list of top-level sessions
 * then says "等你处理" for a parent whose child waits.
 */
export function withChildWaits(
  sessions: ReadonlyMap<string, SessionSummary>,
): Map<string, SessionSummary> {
  const children = new Map<string, SessionSummary[]>()
  for (const s of sessions.values()) {
    if (s.parentId === null || s.archivedAt !== null) continue
    const list = children.get(s.parentId) ?? []
    list.push(s)
    children.set(s.parentId, list)
  }
  const waitsBelow = (id: string, depth: number): number =>
    depth > 8
      ? 0
      : (children.get(id) ?? []).reduce(
          (n, child) =>
            n +
            Math.max(child.permissionCount, needsYou(child) ? 1 : 0) +
            waitsBelow(child.id, depth + 1),
          0,
        )
  const out = new Map<string, SessionSummary>()
  for (const [id, s] of sessions) {
    const below = s.parentId === null ? waitsBelow(id, 0) : 0
    out.set(id, below > 0 ? { ...s, permissionCount: s.permissionCount + below } : s)
  }
  return out
}

/** Pinned first; then what waits for the user, what failed, what runs, the rest; newest first. */
export function listOrder(a: SessionSummary, b: SessionSummary): number {
  const rankOf = (s: SessionSummary) =>
    needsYou(s)
      ? 0
      : s.status === 'failed' || s.attention === 'error'
        ? 1
        : s.status === 'running' || s.status === 'starting'
          ? 2
          : 3
  const pinned = Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null)
  return pinned || rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt
}

export function sessionTitle(s: { title: string | null } | undefined): string {
  return s?.title?.trim() || '新会话'
}

export function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : '请稍后再试。'
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function folder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function sessionBadge(
  s: SessionSummary,
  theme: Theme,
): { text: string; color: string } | null {
  if (needsYou(s)) {
    return {
      text: s.permissionCount > 1 ? `等你处理 ${s.permissionCount}` : '等你处理',
      color: theme.warn,
    }
  }
  if (s.status === 'failed' || s.attention === 'error') return { text: '出错', color: theme.danger }
  if (s.status === 'running' || s.status === 'starting') return { text: '运行中', color: theme.ok }
  if (s.status === 'auth_required') return { text: '需要登录', color: theme.warn }
  if (s.attention === 'unread') return { text: '有新回复', color: theme.accent }
  return null
}

export type SessionState = 'waiting' | 'error' | 'live' | 'auth' | 'unread'

/** What a session's row shows about it, by importance, with its words; null for a quiet one. */
export function sessionState(s: SessionSummary): { kind: SessionState; text: string } | null {
  if (needsYou(s)) {
    return {
      kind: 'waiting',
      text: s.permissionCount > 1 ? `等你处理 ${s.permissionCount}` : '等你处理',
    }
  }
  if (s.status === 'failed' || s.attention === 'error') return { kind: 'error', text: '出错' }
  if (s.status === 'running' || s.status === 'starting') return { kind: 'live', text: '运行中' }
  if (s.status === 'auth_required') return { kind: 'auth', text: '需要登录' }
  if (s.attention === 'unread') return { kind: 'unread', text: '有新回复' }
  return null
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function dayPart(hour: number): string {
  if (hour < 6) return '凌晨'
  if (hour < 12) return '上午'
  if (hour < 13) return '中午'
  if (hour < 18) return '下午'
  return '晚上'
}

/** A time of day as the phone's clock app says it: 下午2:54. */
export function clockOf(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${dayPart(h)}${h12}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** When something happened, as a list's time column shows it: today's clock, 昨天, a weekday, a date. */
export function listTime(ms: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(ms)) / 86_400_000)
  if (days <= 0) return clockOf(ms)
  if (days === 1) return '昨天'
  const d = new Date(ms)
  if (days < 7) return WEEKDAYS[d.getDay()]!
  if (d.getFullYear() === new Date(now).getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** The greeting for the hour. */
export function greeting(now = new Date()): string {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h >= 5 && h < 12) return '早上好'
  if (h >= 12 && h < 18) return '下午好'
  return '晚上好'
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

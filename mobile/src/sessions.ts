import type { SessionSummary } from '@shared/agent-host'
import type { Theme } from './theme'

export function needsYou(s: SessionSummary): boolean {
  return s.status === 'awaiting_permission' || s.permissionCount > 0 || s.attention === 'permission'
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

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

// Plan limits and token counts as the session screens say them, by the desktop's rules
// (features/sidebar/plan-usage.ts): the tightest window, the four usage levels, and counts in
// 万 and 亿 as a Chinese phone writes them.

import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { Palette } from '../tokens'
import { clockTime } from './format'

/** The window to name for a plan: a reached one, else the fullest, else the first still current. */
export function tightestLimit(limits: readonly PlanLimit[], now = Date.now()): PlanLimit | null {
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  const reached = current.find((l) => l.state === 'reached')
  if (reached) return reached
  const known = current.filter((l) => l.usedPercent !== null)
  const fullest = [...known].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
  return fullest ?? current[0] ?? null
}

export type UsageTone = 'low' | 'medium' | 'high' | 'critical'

/** Below 50% used, 50 to 79%, 80 to 94%, and from 95% or once the limit is reached. */
export function usageTone(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): UsageTone {
  const used = Math.round(limit.usedPercent ?? 0)
  if (limit.state === 'reached' || used >= 95) return 'critical'
  if (used >= 80) return 'high'
  if (used >= 50) return 'medium'
  return 'low'
}

export function toneColor(tone: UsageTone, c: Palette): string {
  return tone === 'critical'
    ? c.danger
    : tone === 'high'
      ? c.accent
      : tone === 'medium'
        ? c.tint
        : c.success
}

/** A plan window's color in a ring: the plan's own blue until it nears its end. */
export function limitColor(limit: PlanLimit, c: Palette): string {
  const tone = usageTone(limit)
  return tone === 'critical' ? c.danger : tone === 'high' ? c.warning : c.tint
}

// As the desktop's zh-CN catalog names them (planWindowInText in host.json).
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '每周',
  seven_day_opus: 'Opus 每周',
  seven_day_sonnet: 'Sonnet 每周',
  monthly: '每月',
  annual: '每年',
  overage: '额外用量',
}

/** An agent's own English label in Chinese where its shape is known: 「Fable 每周」「5 小时」. */
function labelName(label: string): string {
  const text = label.trim()
  const weekly = /^weekly(?: · (.+))?$/i.exec(text)
  if (weekly) return weekly[1] ? `${weekly[1]} 每周` : '每周'
  const span = /^(\d+)-(minute|hour|day)(?: · (.+))?$/i.exec(text)
  if (span) {
    const unit = { minute: '分钟', hour: '小时', day: '天' }[span[2]!.toLowerCase()]
    return `${span[3] ? `${span[3]} ` : ''}${span[1]} ${unit}`
  }
  if (/^monthly$/i.test(text)) return '每月'
  if (/^(annual|yearly)$/i.test(text)) return '每年'
  return text
}

/** A window's short name: 「每周」, or the agent's own label for one the phone does not know. */
export function windowName(limit: PlanLimit): string {
  return (
    WINDOW_NAMES[limit.window] ??
    (limit.models?.length ? limit.models.join('、') : labelName(limit.label))
  )
}

/** The plan's name with its tier: 「Claude Max 5x」. */
export function planName(account: AgentAccount | null): string | null {
  if (!account?.label) return null
  return account.tier ? `${account.label} ${account.tier}` : account.label
}

/** 「92.9万」「6.3亿」「4766」. */
export function tokensText(n: number): string {
  const trim = (value: number) => {
    const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
    return text.replace(/\.0$/, '')
  }
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(Math.round(n))
}

/** 「周三 凌晨2:40 重置」, or 「3 小时 12 分钟后重置」 within a day. */
export function resetText(at: number, now = Date.now()): string {
  const left = at - now
  if (left <= 0) return '已重置'
  if (left < 3_600_000) return `${Math.max(1, Math.floor(left / 60_000))} 分钟后重置`
  if (left < 86_400_000) {
    const h = Math.floor(left / 3_600_000)
    const m = Math.floor((left % 3_600_000) / 60_000)
    return m ? `${h} 小时 ${m} 分钟后重置` : `${h} 小时后重置`
  }
  const d = new Date(at)
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${weekday} ${clockTime(at).replace(/^\d+月\d+日 /, '')} 重置`
}

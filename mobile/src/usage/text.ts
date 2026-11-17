// How the usage tab writes its numbers and dates: Chinese units, dollars, and short dates.

import { addDays, type MetricKind, type TrendUnit } from './model'

export function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const oneDecimal = (v: number) => {
  const text = v.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** A count in Chinese units: 1,573, 2722.4万, 128.5亿. */
export function compact(n: number): string {
  if (Math.round(n / 1e7) >= 10) return `${oneDecimal(n / 1e8)}亿`
  if (Math.round(n / 1e3) >= 10) return `${oneDecimal(n / 1e4)}万`
  return grouped(n)
}

export function money(cost: number | null): string {
  if (cost === null) return '—'
  if (cost > 0 && cost < 0.01) return '< $0.01'
  return cost >= 100 ? `$${grouped(cost)}` : `$${cost.toFixed(2)}`
}

/** An amount in the metric, short. */
export function metricText(kind: MetricKind, value: number | null): string {
  if (kind === 'cost') return money(value)
  return value === null ? '—' : compact(value)
}

/** An amount in the metric with its unit, for sentences and VoiceOver. */
export function metricWords(kind: MetricKind, value: number | null): string {
  if (kind === 'cost') return money(value)
  if (value === null) return '—'
  if (kind === 'tokens') return `${compact(value)} token`
  return `${compact(value)} ${kind === 'turns' ? '轮' : '次请求'}`
}

export const METRIC_NAMES: Record<MetricKind, string> = {
  tokens: 'Token',
  requests: '请求',
  turns: '轮次',
  cost: '费用',
}

/** A share as a whole percentage, "<1%" for a sliver that would read as none. */
export function percent(share: number | null): string {
  if (share === null) return '—'
  if (share > 0 && share < 0.005) return '<1%'
  return `${Math.round(share * 100)}%`
}

const thisYear = (at: number) => new Date(at).getFullYear() === new Date().getFullYear()

/** "11月17日", with the year when it is not this one. */
export function dateText(day: number, withYear = !thisYear(day)): string {
  const d = new Date(day)
  return `${withYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** "11月17日 星期一". */
export function dayText(day: number): string {
  return `${dateText(day)} 星期${WEEKDAYS[new Date(day).getDay()]}`
}

export function weekdayName(weekday: number): string {
  return `星期${WEEKDAYS[weekday]}`
}

/** "10月19日至11月17日" for [from, to), or one day alone. */
export function rangeText(from: number, to: number): string {
  const last = addDays(to, -1)
  if (last === from) return dateText(from)
  const years = !thisYear(from) || !thisYear(last)
  return `${dateText(from, years)}至${dateText(last, years)}`
}

/** "下午6时至7时" for an hour of the day. */
export function hourName(hour: number): string {
  const part =
    hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 13 ? '中午' : hour < 18 ? '下午' : '晚上'
  const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12)
  return `${part}${h12(hour)}时至${h12(hour + 1)}时`
}

/** A trend bar's period: a day, a week, a month or an hour. */
export function barText(unit: TrendUnit, from: number, to: number): string {
  if (unit === 'hour') {
    const h = new Date(from).getHours()
    return `${dateText(from)} ${hourName(h)}`
  }
  if (unit === 'day') return dayText(from)
  if (unit === 'month' && new Date(from).getDate() === 1 && new Date(to).getDate() === 1) {
    const d = new Date(from)
    return `${d.getFullYear()}年${d.getMonth() + 1}月`
  }
  return rangeText(from, to)
}

/** A tick under a trend bar. */
export function tickText(unit: TrendUnit, from: number): string {
  const d = new Date(from)
  if (unit === 'hour') return `${d.getHours()}时`
  if (unit === 'month') return d.getMonth() === 0 ? `${d.getFullYear()}年` : `${d.getMonth() + 1}月`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export const UNIT_NAMES: Record<TrendUnit, string> = {
  hour: '按小时',
  day: '按天',
  week: '按周',
  month: '按月',
}

/** The price list's ISO date, "10月25日". */
export function priceDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  return dateText(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime())
}

/** When the logs were last read: 刚刚, 5 分钟前, 3 小时前, or a date. */
export function agoText(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${dateText(at)}`
}

/** A folder's last part, for a project row. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

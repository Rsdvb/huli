// Usage: each agent's tokens and cost today and this week, as the computer counts them, and its
// plan limits as the agent last reported them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Stack } from 'expo-router'
import type { AgentStatus, HostEvent, LimitsReason, PlanLimit } from '@shared/agent-host'
import { partsTotal, type UsageStatus, type UsageSummary } from '@shared/usage'
import { useHost } from '../host'
import { ago, errorText } from '../sessions'
import { useTheme, type Theme } from '../theme'

interface Figures {
  tokens: number
  cost: number | null
  turns: number
}

interface Read {
  summary: UsageSummary
  status: UsageStatus
  /** Index of today's period in the summary's days. */
  todayIndex: number
}

const WINDOWS: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '每周',
  seven_day_opus: '每周 · Opus',
  seven_day_sonnet: '每周 · Sonnet',
  monthly: '每月',
  annual: '每年',
  overage: '额外用量',
}

const REASONS: Record<LimitsReason, string> = {
  'vendor-disallows': '服务商不提供套餐额度的读取。',
  'harness-does-not-offer': '这个智能体不报告套餐额度。',
  'administrator-managed': '额度由管理员管理。',
  'model-provider-managed': '额度由模型服务商管理。',
  'not-yet-supported': '暂不支持读取这个智能体的额度。',
  'console-managed': '用 API 密钥登录，用量请到服务商控制台查看。',
}

function limitLabel(limit: PlanLimit): string {
  const known = WINDOWS[limit.window]
  if (known) return known
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  if (weekly) return `每周 · ${weekly[1]}`
  const fiveHour = /^5-hour · (.+)$/.exec(limit.label)
  return fiveHour ? `5 小时 · ${fiveHour[1]}` : limit.label
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function addDays(dayStart: number, days: number): number {
  const d = new Date(dayStart)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

function tokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)} 万`
  return String(n)
}

function money(cost: number | null): string {
  if (cost === null) return '无价格'
  return cost < 0.01 && cost > 0 ? '< $0.01' : `$${cost.toFixed(2)}`
}

function resetText(at: number): string {
  const left = at - Date.now()
  if (left <= 0) return '已重置'
  const hours = Math.floor(left / 3_600_000)
  if (hours < 1) return `${Math.max(1, Math.round(left / 60_000))} 分钟后重置`
  if (hours < 48) return `${hours} 小时后重置`
  return `${Math.round(hours / 24)} 天后重置`
}

function sum(summary: UsageSummary, agentId: string, days: (day: number) => boolean): Figures {
  let total = 0
  let cost: number | null = null
  let turns = 0
  for (const row of summary.days) {
    if (row.agentId !== agentId || !days(row.day)) continue
    total += partsTotal(row)
    turns += row.turns
    if (row.cost !== null) cost = (cost ?? 0) + row.cost
  }
  return { tokens: total, cost, turns }
}

export default function Usage() {
  const theme = useTheme()
  const { link, agents, state } = useHost()
  const [read, setRead] = useState<Read | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({})
  const connected = state.kind === 'connected'

  const load = useCallback(async () => {
    if (!link) return
    setLoading(true)
    try {
      const status = (await link.request('usage.status', undefined)) as UsageStatus
      const today = startOfDay(Date.now())
      const weekStart = addDays(today, -((new Date(today).getDay() + 6) % 7))
      const tomorrow = addDays(today, 1)
      // Periods must ascend strictly, so on a Monday the week is today alone.
      const dayStarts = weekStart < today ? [weekStart, today, tomorrow] : [today, tomorrow]
      const summary = (await link.request('usage.summary', {
        dayStarts,
        from: weekStart,
        to: tomorrow,
        scope: status.fromComputer ? 'computer' : 'kettu',
      })) as UsageSummary
      setRead({ summary, status, todayIndex: dayStarts.length - 2 })
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [link])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'usage.changed') void load()
      if (event.type === 'usage.status') {
        setRead((current) => (current ? { ...current, status: event.status } : current))
      }
    })
  }, [link, load])

  const shown = useMemo(() => {
    const used = new Set(read?.summary.days.map((d) => d.agentId) ?? [])
    const list: AgentStatus[] = [...agents.values()].filter(
      (a) =>
        a.registered !== false &&
        !a.uninstalled &&
        (used.has(a.id) || a.limits.length > 0 || (!a.hidden && !a.disabled)),
    )
    const named = new Set(list.map((a) => a.id))
    const orphans = [...used].filter((id) => !named.has(id))
    return { list, orphans }
  }, [agents, read])

  const refreshLimits = (agent: AgentStatus) => {
    if (!link) return
    setRefreshing((set) => new Set(set).add(agent.id))
    setLimitErrors((errors) => {
      const next = { ...errors }
      delete next[agent.id]
      return next
    })
    link
      .request('agents.refreshLimits', { agentId: agent.id, force: true })
      .catch((failure: unknown) =>
        setLimitErrors((errors) => ({ ...errors, [agent.id]: errorText(failure) })),
      )
      .finally(() =>
        setRefreshing((set) => {
          const next = new Set(set)
          next.delete(agent.id)
          return next
        }),
      )
  }

  const body = () => {
    if (!read) {
      if (error) {
        return (
          <View style={styles.center}>
            <Text style={{ color: theme.danger, fontSize: 15, textAlign: 'center' }}>{error}</Text>
            <Pressable onPress={() => void load()} hitSlop={8} disabled={!connected}>
              <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600' }}>重试</Text>
            </Pressable>
          </View>
        )
      }
      return (
        <View style={styles.center}>
          {connected ? (
            <ActivityIndicator color={theme.accent} />
          ) : (
            <Text style={{ color: theme.muted, fontSize: 15 }}>连上电脑后才能看用量。</Text>
          )}
        </View>
      )
    }
    const { summary, status, todayIndex } = read
    const today = (agentId: string) => sum(summary, agentId, (day) => day === todayIndex)
    const week = (agentId: string) => sum(summary, agentId, () => true)
    return (
      <>
        <Text style={[styles.note, { color: theme.muted }]}>
          {status.unavailable
            ? '电脑上的用量记录打不开，下面的数字可能不全。'
            : status.fromComputer
              ? '按这台电脑上各智能体的日志统计，包括 Huli 之外的使用。'
              : '只统计在 Huli 里发生的使用。'}
          {status.scanning ? ' 正在读取日志…' : ''}
        </Text>
        {error && <Text style={[styles.note, { color: theme.danger }]}>{error}</Text>}
        {shown.list.map((agent) => (
          <AgentCard
            key={agent.id}
            theme={theme}
            name={agent.name}
            agent={agent}
            today={today(agent.id)}
            week={week(agent.id)}
            refreshing={refreshing.has(agent.id)}
            limitError={limitErrors[agent.id] ?? agent.limitsError ?? null}
            onRefresh={connected ? () => refreshLimits(agent) : undefined}
          />
        ))}
        {shown.orphans.map((agentId) => (
          <AgentCard
            key={agentId}
            theme={theme}
            name={agentId}
            agent={null}
            today={today(agentId)}
            week={week(agentId)}
            refreshing={false}
            limitError={null}
            onRefresh={undefined}
          />
        ))}
        {shown.list.length + shown.orphans.length === 0 && (
          <Text style={[styles.note, { color: theme.muted, textAlign: 'center', marginTop: 40 }]}>
            这周还没有用量。
          </Text>
        )}
        <Text style={[styles.note, { color: theme.muted }]}>
          费用按 {summary.pricesAsOf} 的价格估算；本周从周一算起。
        </Text>
      </>
    )
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={loading && read !== null}
          tintColor={theme.accent}
          onRefresh={() => void load()}
        />
      }
    >
      <Stack.Screen options={{ title: '用量' }} />
      {body()}
    </ScrollView>
  )
}

function AgentCard(props: {
  theme: Theme
  name: string
  agent: AgentStatus | null
  today: Figures
  week: Figures
  refreshing: boolean
  limitError: string | null
  onRefresh: (() => void) | undefined
}) {
  const { theme, agent } = props
  const readable =
    !!agent &&
    agent.capabilities.reports &&
    agent.signIn !== 'required' &&
    agent.state !== 'not-installed'
  const limits = agent?.limits ?? []
  const observed = Math.max(0, ...limits.map((l) => l.observedAt))
  const figure = (label: string, f: Figures) => (
    <View style={{ flex: 1 }}>
      <Text style={{ color: theme.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600', marginTop: 2 }}>
        {tokens(f.tokens)}
      </Text>
      <Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>
        {f.tokens > 0 ? money(f.cost) : '—'}
        {f.turns > 0 ? ` · ${f.turns} 轮` : ''}
      </Text>
    </View>
  )
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.line }]}>
      <View style={styles.cardHead}>
        <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600', flex: 1 }}>
          {props.name}
        </Text>
        {agent?.account?.label ? (
          <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1}>
            {agent.account.label}
            {agent.account.tier ? ` ${agent.account.tier}` : ''}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {figure('今天 · token', props.today)}
        {figure('本周 · token', props.week)}
      </View>

      {agent && (
        <View style={{ gap: 8 }}>
          <View style={styles.cardHead}>
            <Text style={{ color: theme.muted, fontSize: 12, flex: 1 }}>
              套餐额度{observed > 0 ? ` · ${ago(observed)}更新` : ''}
            </Text>
            {readable && props.onRefresh && (
              <Pressable onPress={props.onRefresh} disabled={props.refreshing} hitSlop={8}>
                {props.refreshing ? (
                  <ActivityIndicator size="small" color={theme.accent} />
                ) : (
                  <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '600' }}>
                    {limits.length > 0 ? '刷新' : '查看额度'}
                  </Text>
                )}
              </Pressable>
            )}
          </View>
          {limits.map((limit) => (
            <LimitBar key={limit.window} limit={limit} theme={theme} />
          ))}
          {limits.length === 0 && (
            <Text style={{ color: theme.muted, fontSize: 13 }}>
              {agent.limitsReason
                ? REASONS[agent.limitsReason]
                : agent.signIn === 'required' && agent.capabilities.reports
                  ? `${agent.name} 登录后才能读到额度。`
                  : readable
                    ? '还没有读过额度。'
                    : `${agent.name} 不报告套餐额度。`}
            </Text>
          )}
          {props.limitError ? (
            <Text style={{ color: theme.danger, fontSize: 12 }}>{props.limitError}</Text>
          ) : null}
        </View>
      )}
    </View>
  )
}

function LimitBar({ limit, theme }: { limit: PlanLimit; theme: Theme }) {
  const used = Math.round(limit.usedPercent ?? 0)
  const color =
    limit.state === 'reached' || used >= 90 ? theme.danger : used >= 70 ? theme.warn : theme.ok
  const amount = limit.amount
    ? ` · ${limit.amount.used}/${limit.amount.total} ${limit.amount.unit}`
    : ''
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row' }}>
        <Text style={{ color: theme.text, fontSize: 13, flex: 1 }}>
          {limitLabel(limit)}
          {limit.state === 'reached' ? ' · 已用完' : ''}
        </Text>
        <Text style={{ color: theme.muted, fontSize: 12 }}>
          {limit.usedPercent === null ? '—' : `已用 ${used}%`}
          {amount}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: theme.line }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: color, width: `${Math.min(100, Math.max(0, used))}%` },
          ]}
        />
      </View>
      {limit.resetsAt ? (
        <Text style={{ color: theme.muted, fontSize: 11 }}>{resetText(limit.resetsAt)}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  note: { fontSize: 12, lineHeight: 17 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
})

// One account's plan, from a plan card on the Usage tab: its windows as rings beside each one's
// share and when it resets, counting down; what happens at 100%; balances and reset credits; the
// models the current week used, by tokens; and the way to the Usage tab for this account alone.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { UsageStatus, UsageSummary } from '@shared/usage'
import { useActiveHost, useAgents, useHostState, useMaybeLink } from '../host'
import { ManagePage } from '../manage/kit'
import { clockOf, errorText } from '../sessions'
import { ConcentricRings } from '../ui/charts'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { ListGroup, ListRow } from '../ui/ListRow'
import { Press } from '../ui/Press'
import { SectionHeader } from '../ui/SectionHeader'
import { AgentGlyph } from '../ui/session/icons'
import {
  balanceText,
  isExhausted,
  leftText,
  limitColor,
  planName,
  tokensText,
  whenText,
  windowName,
} from '../ui/session/limits'
import { useTicking } from '../ui/session/ticking'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { modelRows, type BreakdownRow } from './model'
import { modelTitle } from './modelTitle'

const DAY = 86_400_000
const WEEK = 7 * DAY
const RING = 148

/** The start of the window the model list covers: the weekly one's, else the last seven days. */
function weekFrom(agent: AgentStatus, now: number): { from: number; weekly: boolean } {
  const weekly = agent.limits.find((l) => l.window === 'seven_day' && l.resetsAt)
  return weekly?.resetsAt
    ? { from: weekly.resetsAt - WEEK, weekly: true }
    : { from: now - WEEK, weekly: false }
}

export default function PlanScreen() {
  const { c } = useTokens()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const agents = useAgents()
  const agent = id ? agents.get(id) : undefined
  const link = useMaybeLink()
  const connected = useHostState().kind === 'connected'
  const host = useActiveHost()
  const now = useTicking(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<BreakdownRow[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!link || !agent) return
    setRefreshing(true)
    setError(null)
    try {
      await link.request('agents.refreshLimits', { agentId: agent.id, force: true, ask: true })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setRefreshing(false)
    }
  }, [link, agent])

  const week = agent ? weekFrom(agent, Date.now()) : null
  const weekStart = week?.from ?? 0
  const agentId = agent?.id ?? null
  const readModels = useCallback(async () => {
    if (!link || !agentId || !weekStart) return
    setModelsError(null)
    try {
      const status = (await link.request('usage.status', undefined)) as UsageStatus
      const to = Date.now()
      const summary = (await link.request('usage.summary', {
        dayStarts: [weekStart, to],
        from: weekStart,
        to,
        scope: status.fromComputer ? 'computer' : 'kettu',
      })) as UsageSummary
      setModels(modelRows(summary, agentId))
    } catch (failure) {
      setModelsError(errorText(failure))
    }
  }, [link, agentId, weekStart])
  useEffect(() => {
    if (connected) void readModels()
  }, [connected, readModels])

  if (!agent) {
    return (
      <ManagePage title="套餐">
        <EmptyState
          icon="chart"
          title="找不到这个 Agent"
          message="它可能已在电脑上移除。"
          action={{ label: '返回', onPress: () => router.back() }}
        />
      </ManagePage>
    )
  }

  const plan = planName(agent.account)
  const observed = Math.max(0, ...agent.limits.map((l) => l.observedAt))
  return (
    <ManagePage
      title={agent.name}
      subtitle={[agent.harnessName, plan].filter(Boolean).join(' · ')}
      onRefresh={() => Promise.all([refresh(), readModels()])}
    >
      {agent.limits.length > 0 ? (
        <Hero agent={agent} now={now} />
      ) : (
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>还没有读到套餐用量。</Text>
      )}
      <Note
        agent={agent}
        observed={observed}
        refreshing={refreshing}
        error={error}
        onRefresh={connected ? () => void refresh() : undefined}
      />
      <Extras agent={agent} />
      <Models
        rows={models}
        error={modelsError}
        weekly={week?.weekly ?? false}
        onRetry={() => void readModels()}
      />
      <ListGroup header="用量">
        <ListRow
          title="仅此账号的用量"
          subtitle={host?.name ?? '电脑'}
          icon="chart"
          chevron
          onPress={() =>
            router.navigate({
              pathname: '/usage',
              params: { agent: agent.id, at: String(Date.now()) },
            })
          }
        />
      </ListGroup>
    </ManagePage>
  )
}

/** The rings, the outer one first, beside each window's name, share and reset. */
function Hero(props: { agent: AgentStatus; now: number }) {
  const { c } = useTokens()
  const { agent, now } = props
  const limits = agent.limits
  const stroke = limits.length > 3 ? 9 : 12
  return (
    <View style={styles.hero}>
      <View style={styles.ring}>
        <ConcentricRings
          size={RING}
          stroke={stroke}
          gap={4}
          rings={limits.map((l) => ({
            progress: isExhausted(l, now) ? 1 : (l.usedPercent ?? 0) / 100,
            color: limitColor(l, c),
          }))}
        />
        <View style={styles.glyph} pointerEvents="none">
          <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={34} />
        </View>
      </View>
      <View style={styles.windows}>
        {limits.map((l) => (
          <Window key={l.window} limit={l} now={now} />
        ))}
      </View>
    </View>
  )
}

function Window(props: { limit: PlanLimit; now: number }) {
  const { c } = useTokens()
  const { limit, now } = props
  const out = isExhausted(limit, now)
  const high = out || (limit.usedPercent ?? 0) >= 90
  const at = limit.resetsAt
  const reset = at && at > now ? `${whenText(at, now)} 重置 · 还有 ${leftText(at - now)}` : null
  return (
    <View
      accessible
      accessibilityLabel={`${windowName(limit)}已用 ${
        out ? '完' : `${Math.round(limit.usedPercent ?? 0)}%`
      }${reset ? `，${reset}` : ''}`}
    >
      <View style={styles.windowHead}>
        <View style={[styles.dot, { backgroundColor: limitColor(limit, c) }]} />
        <Text style={[typeScale.callout, { color: c.textSecondary }]} numberOfLines={1}>
          {windowName(limit)}
        </Text>
      </View>
      <Text
        style={[typeScale.title, styles.tabular, { color: high ? limitColor(limit, c) : c.text }]}
      >
        {out ? '已用完' : limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
      </Text>
      {reset ? (
        <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>{reset}</Text>
      ) : null}
    </View>
  )
}

/** What 100% means for the agent, and when the windows were read, with a way to read them again. */
function Note(props: {
  agent: AgentStatus
  observed: number
  refreshing: boolean
  error: string | null
  onRefresh: (() => void) | undefined
}) {
  const { c } = useTokens()
  const { agent } = props
  const extra = (agent.balances ?? []).some((b) => b.label === 'Extra usage' && b.amount > 0)
  const note = extra
    ? `到 100% 时，${agent.name} 会改从额外用量里扣，扣完才停止回答。`
    : `到 100% 时，${agent.name} 会停止回答，直到窗口重置。例程会等待并说明原因；会话可以切换到其他 Agent 继续。`
  return (
    <View style={styles.noteWrap}>
      <View style={styles.noteRow}>
        <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>{note}</Text>
        <Press
          onPress={() => {
            haptic.tap()
            props.onRefresh?.()
          }}
          disabled={!props.onRefresh || props.refreshing}
          accessibilityRole="button"
          accessibilityLabel="重新读取套餐用量"
          hitSlop={8}
          style={styles.readAt}
        >
          <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
            {props.observed > 0 ? `读取于 ${clockOf(props.observed)}` : '还没读过'}
          </Text>
          {props.refreshing ? (
            <ActivityIndicator size="small" color={c.textTertiary} />
          ) : (
            <Icon name="refresh" size={14} color={c.textTertiary} />
          )}
        </Press>
      </View>
      {props.error ? (
        <Text style={[typeScale.footnote, { color: c.danger }]}>{props.error}</Text>
      ) : null}
    </View>
  )
}

/** The balances that pay past the windows, and the reset credits, which Settings redeems. */
function Extras(props: { agent: AgentStatus }) {
  const { agent } = props
  const balances = agent.balances ?? []
  const credits = agent.resetCredits
  if (balances.length === 0 && !credits) return null
  return (
    <ListGroup>
      {balances.map((balance) => {
        const text = balanceText(balance)
        return (
          <ListRow
            key={`${balance.label}/${balance.currency}`}
            title={text.name}
            value={text.value}
          />
        )
      })}
      {credits ? (
        <ListRow
          title="重置卡"
          subtitle={credits.available > 0 ? '在 Agent 设置里使用。' : '账号里现在没有重置卡。'}
          value={`${credits.available} 张`}
          chevron={credits.available > 0}
          onPress={
            credits.available > 0
              ? () => router.push({ pathname: '/settings/agent', params: { id: agent.id } })
              : undefined
          }
        />
      ) : null}
    </ListGroup>
  )
}

/** The models the week used, by tokens: each one's name, a bar of its share, the share and tokens. */
function Models(props: {
  rows: BreakdownRow[] | null
  error: string | null
  weekly: boolean
  onRetry(): void
}) {
  const { c } = useTokens()
  const rows = props.rows ?? []
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  const title = props.weekly ? '本周使用的模型' : '最近 7 天使用的模型'
  return (
    <View style={styles.models}>
      <SectionHeader
        title={title}
        count={props.rows ? rows.length : undefined}
        right={
          total > 0 ? (
            <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
              {tokensText(total)} token
            </Text>
          ) : undefined
        }
      />
      {props.error ? (
        <ListGroup>
          <ListRow title="没能读取" subtitle={props.error} value="重试" onPress={props.onRetry} />
        </ListGroup>
      ) : props.rows === null ? (
        <ActivityIndicator color={c.textTertiary} />
      ) : rows.length === 0 ? (
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>这段时间还没有用量。</Text>
      ) : (
        rows.map((row) => {
          const share = total > 0 ? row.total / total : 0
          const name = row.name ? modelTitle(row.name) : '未知模型'
          return (
            <View
              key={row.key}
              style={styles.modelRow}
              accessible
              accessibilityLabel={`${name}，${percentText(share)}，${tokensText(row.total)} token`}
            >
              <Text
                style={[typeScale.callout, styles.modelName, { color: c.text }]}
                numberOfLines={1}
              >
                {name}
              </Text>
              <View style={[styles.track, { backgroundColor: c.track }]}>
                <View
                  style={[
                    styles.fill,
                    { backgroundColor: c.tint, width: `${Math.max(2, Math.round(share * 100))}%` },
                  ]}
                />
              </View>
              <Text style={[typeScale.callout, styles.share, styles.tabular, { color: c.text }]}>
                {percentText(share)}
              </Text>
              <Text
                style={[
                  typeScale.footnote,
                  styles.amount,
                  styles.tabular,
                  { color: c.textTertiary },
                ]}
                numberOfLines={1}
              >
                {tokensText(row.total)}
              </Text>
            </View>
          )
        })
      )}
    </View>
  )
}

function percentText(share: number): string {
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  ring: { width: RING, height: RING },
  glyph: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  windows: { flex: 1, gap: space.md },
  windowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  tabular: { fontVariant: ['tabular-nums'] },
  noteWrap: { gap: space.xs },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  flex: { flex: 1 },
  readAt: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  models: { gap: space.md },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  modelName: { width: 104 },
  track: { flex: 1, height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
  share: { width: 44, textAlign: 'right' },
  amount: { width: 52, textAlign: 'right' },
})

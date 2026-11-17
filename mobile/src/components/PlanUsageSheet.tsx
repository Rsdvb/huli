// An agent's plan usage, from the ring under the composer, the model menu's last row and the
// context sheet: the plan and its mark, each window with a bar in its level's color, how much is
// used and when it resets, counting down; the session's tokens, when the limits were read and a
// way to read them again, the way to the Usage tab for the agent, and the other agents' plans
// folded under it. The desktop shows the same in the composer's usage card
// (features/session/composer/usage.tsx) and the Usage page's plan cards.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import { useAgents, useHostState, useMaybeLink } from '../host'
import { errorText } from '../sessions'
import { BottomSheet } from '../ui/BottomSheet'
import { Skeleton } from '../ui/Skeleton'
import { useComputer } from '../ui/session/computer'
import { haptic } from '../ui/session/feedback'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import {
  amountText,
  balanceText,
  canReadLimits,
  isExhausted,
  limitColor,
  limitsReadAt,
  limitsWhy,
  limitTextColor,
  moneyText,
  planName,
  readText,
  resetText,
  tightestLimit,
  tokensText,
  windowName,
  windowShort,
} from '../ui/session/limits'
import { useSessionTokens } from '../ui/session/palette'
import { gentle } from '../ui/session/Press'
import { UsageRing } from '../ui/session/StatusLine'
import { usableAgents } from './ConfigMenus'

/** The clock the sheets count down by: every 15 seconds while shown. */
export function useTicking(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/**
 * The windows shown first, as rings beside a plan's name: the weekly ones, as the desktop's cards
 * lead with the longest, else the tightest; at most two.
 */
export function leadLimits(limits: readonly PlanLimit[], now = Date.now()): PlanLimit[] {
  const known = limits.filter((l) => l.usedPercent !== null || isExhausted(l, now))
  const weekly = known.filter((l) => l.window === 'seven_day' || l.window.startsWith('seven_day_'))
  if (weekly.length > 0) return weekly.slice(0, 2)
  const tightest = tightestLimit(known, now)
  return tightest ? [tightest] : []
}

/** A window as a ring and its short name and share: 「◔ 7 天 37%」. */
export function LimitChip(props: { limit: PlanLimit; now: number }) {
  const { c } = useSessionTokens()
  const { limit } = props
  const percent = Math.round(limit.usedPercent ?? 0)
  return (
    <View style={styles.chip}>
      <UsageRing
        percent={isExhausted(limit, props.now) ? 100 : percent}
        color={limitColor(limit, c)}
        track={c.fillStrong}
        size={15}
      />
      <Text style={[styles.chipText, { color: c.textTertiary }]} numberOfLines={1}>
        {windowShort(limit)}{' '}
        <Text style={{ color: limitTextColor(limit, c, c.text) }}>
          {limit.usedPercent === null ? '已用完' : `${percent}%`}
        </Text>
      </Text>
    </View>
  )
}

export function PlanUsageSheet(props: {
  visible: boolean
  onClose(): void
  /** The agent whose plan leads the sheet: the session's, or New session's choice. */
  agentId: string | null
  /** The session's usage, for its tokens; absent outside a session. */
  usage?: SessionUsage | null
  /** The sheet leads away, to the Usage tab: a sheet it opened from closes too. */
  onLeave?(): void
}) {
  const { c } = useSessionTokens()
  const hostState = useHostState()
  const agents = useAgents()
  const computer = useComputer()
  const connected = hostState.kind === 'connected'
  const link = useMaybeLink()
  const agent = props.agentId ? agents.get(props.agentId) : undefined
  const now = useTicking(props.visible)
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [othersOpen, setOthersOpen] = useState(false)

  const read = useCallback(
    (target: AgentStatus, force: boolean) => {
      if (!link) return
      setReading((was) => new Set(was).add(target.id))
      setErrors((was) => {
        const next = { ...was }
        delete next[target.id]
        return next
      })
      link
        .request('agents.refreshLimits', { agentId: target.id, ...(force ? { force } : {}) })
        .catch((failure: unknown) =>
          setErrors((was) => ({ ...was, [target.id]: errorText(failure) })),
        )
        .finally(() =>
          setReading((was) => {
            const next = new Set(was)
            next.delete(target.id)
            return next
          }),
        )
    },
    [link],
  )

  // Read afresh each time the sheet opens; the host asks an agent at most once a minute.
  useEffect(() => {
    if (!props.visible || !connected || !agent || !canReadLimits(agent)) return
    read(agent, false)
    // Once per opening, not on every push of the agent's status.
  }, [props.visible, connected, agent?.id, read])

  const others = usableAgents(agents)
    .filter((a) => a.id !== agent?.id)
    .filter((a) => a.limits.length > 0 || a.capabilities.reports || a.account?.kind === 'account')
    .sort((a, b) => Number(b.limits.length > 0) - Number(a.limits.length > 0))

  const openOthers = () => {
    gentle()
    haptic.tap()
    const next = !othersOpen
    setOthersOpen(next)
    // Only agents already running are asked, so that none starts just for the read.
    if (next && connected) {
      for (const other of others) {
        if (other.state === 'ready' && canReadLimits(other)) read(other, false)
      }
    }
  }

  const viewUsage = () => {
    if (!agent) return
    haptic.tap()
    props.onClose()
    props.onLeave?.()
    router.navigate({ pathname: '/usage', params: { agent: agent.id, at: String(Date.now()) } })
  }

  const tokens = props.usage?.tokens?.total ?? null
  const cost = props.usage?.cost ?? null
  const readAt = agent ? limitsReadAt(agent) : 0
  const busy = !!agent && reading.has(agent.id)

  return (
    <BottomSheet visible={props.visible} onClose={props.onClose}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
          套餐用量
        </Text>
        <Text style={[styles.where, { color: c.textSecondary }]} numberOfLines={1}>
          {computer.name}
        </Text>
      </View>

      {!agent ? (
        <Text style={[styles.note, { color: c.textSecondary }]}>
          {props.agentId ? '这台电脑上找不到这个 Agent。' : '还没有选 Agent。'}
        </Text>
      ) : (
        <>
          <PlanBlock
            agent={agent}
            now={now}
            reading={busy}
            error={errors[agent.id] ?? agent.limitsError ?? null}
            onRetry={connected && canReadLimits(agent) ? () => read(agent, true) : undefined}
          />

          {tokens !== null || cost ? (
            <View style={styles.line}>
              <Text style={[styles.lineName, { color: c.textSecondary }]}>本会话</Text>
              <Text style={[styles.lineValue, { color: c.text }]} numberOfLines={1}>
                {[
                  tokens !== null ? `${tokensText(tokens)} token` : null,
                  cost ? `≈ ${moneyText(cost.amount, cost.currency)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ) : null}

          {canReadLimits(agent) && (
            <View style={styles.line}>
              <Text style={[styles.lineName, { color: c.textSecondary }]} numberOfLines={1}>
                {busy ? '正在读取…' : readAt > 0 ? readText(readAt, now) : '还没有读过'}
              </Text>
              <Pressable
                onPress={() => {
                  haptic.tap()
                  read(agent, true)
                }}
                disabled={busy || !connected}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="刷新套餐用量"
                accessibilityState={{ disabled: busy || !connected, busy }}
                style={({ pressed }) => [
                  styles.refresh,
                  { backgroundColor: c.fill, opacity: !connected ? 0.4 : pressed ? 0.6 : 1 },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={c.textSecondary} />
                ) : (
                  <Icon icon={G.retry} size={13} color={c.tint} weight="semibold" />
                )}
                <Text style={[styles.refreshText, { color: busy ? c.textSecondary : c.tint }]}>
                  刷新
                </Text>
              </Pressable>
            </View>
          )}

          <Pressable
            onPress={viewUsage}
            accessibilityRole="link"
            accessibilityLabel={`查看 ${agent.name} 的用量`}
            style={({ pressed }) => [
              styles.action,
              { backgroundColor: pressed ? c.fillStrong : c.fill },
            ]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.actionTitle, { color: c.text }]}>查看用量</Text>
              <Text style={[styles.actionNote, { color: c.textSecondary }]} numberOfLines={1}>
                {agent.name} 每天用的 token、请求和费用
              </Text>
            </View>
            <Icon icon={G.right} size={13} color={c.textTertiary} weight="semibold" />
          </Pressable>
        </>
      )}

      {others.length > 0 && (
        <View style={styles.others}>
          <Pressable
            onPress={openOthers}
            accessibilityRole="button"
            accessibilityState={{ expanded: othersOpen }}
            accessibilityLabel={`其他 Agent，${others.length} 个`}
            style={({ pressed }) => [styles.othersHead, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.section, { color: c.textSecondary }]}>
              其他 Agent
              <Text style={{ color: c.textTertiary }}> {others.length}</Text>
            </Text>
            <View style={{ flex: 1 }} />
            {!othersOpen &&
              others
                .flatMap((a) => {
                  const lead = tightestLimit(a.limits, now)
                  return lead && lead.usedPercent !== null ? [{ a, lead }] : []
                })
                .slice(0, 2)
                .map(({ a, lead }) => (
                  <View key={a.id} style={styles.peek}>
                    <AgentGlyph agentId={a.id} harness={a.harnessId} size={14} />
                    <UsageRing
                      percent={lead.usedPercent ?? 0}
                      color={limitColor(lead, c)}
                      track={c.fillStrong}
                      size={13}
                    />
                  </View>
                ))}
            <View style={{ transform: [{ rotate: othersOpen ? '90deg' : '0deg' }] }}>
              <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
            </View>
          </Pressable>
          {othersOpen &&
            others.map((other) => (
              <OtherAgent
                key={other.id}
                agent={other}
                now={now}
                reading={reading.has(other.id)}
                error={errors[other.id] ?? other.limitsError ?? null}
              />
            ))}
        </View>
      )}
    </BottomSheet>
  )
}

/** The plan's name and mark, then each window, or why there are none. */
function PlanBlock(props: {
  agent: AgentStatus
  now: number
  reading: boolean
  error: string | null
  onRetry: (() => void) | undefined
}) {
  const { c } = useSessionTokens()
  const { agent, now } = props
  const plan = planName(agent.account)
  const balances = agent.balances ?? []
  return (
    <View style={[styles.card, { backgroundColor: c.fill }]}>
      <View style={styles.plan}>
        <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={26} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.planName, { color: c.text }]} numberOfLines={1}>
            {plan ?? agent.name}
          </Text>
          {plan ? (
            <Text style={[styles.planOf, { color: c.textSecondary }]} numberOfLines={1}>
              {agent.name}
            </Text>
          ) : null}
        </View>
      </View>

      {agent.limits.length > 0 ? (
        agent.limits.map((limit) => <WindowRow key={limit.window} limit={limit} now={now} />)
      ) : props.reading ? (
        <View style={styles.loading} accessibilityLabel="正在读取套餐用量">
          {(['50%', '35%'] as const).map((width) => (
            <View key={width} style={{ gap: 7 }}>
              <Skeleton width={width} height={12} />
              <Skeleton height={6} radius={3} />
            </View>
          ))}
        </View>
      ) : (
        <Text style={[styles.note, { color: c.textSecondary }]}>{limitsWhy(agent)}</Text>
      )}

      {balances.map((balance) => {
        const { name, value } = balanceText(balance)
        return (
          <View key={`${balance.label}/${balance.currency}`} style={styles.balance}>
            <Text style={[styles.windowName, { color: c.textSecondary }]}>{name}</Text>
            <Text style={[styles.windowValue, { color: c.text }]}>{value}</Text>
          </View>
        )
      })}

      {props.error ? (
        <View style={styles.error}>
          <Icon icon={G.warning} size={13} color={c.danger} />
          <Text style={[styles.errorText, { color: c.danger }]} numberOfLines={3}>
            没能读到套餐用量：{props.error}
          </Text>
          {props.onRetry && !props.reading ? (
            <Pressable onPress={props.onRetry} hitSlop={8} accessibilityRole="button">
              <Text style={[styles.retry, { color: c.tint }]}>重试</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** A window: its name and share, a bar in its level's color, and when it resets. */
function WindowRow(props: { limit: PlanLimit; now: number; compact?: boolean }) {
  const { c } = useSessionTokens()
  const { limit, now } = props
  const out = isExhausted(limit, now)
  const used = Math.round(limit.usedPercent ?? (out ? 100 : 0))
  const color = limitColor(limit, c)
  const reset = limit.resetsAt !== null ? resetText(limit.resetsAt, now) : null
  return (
    <View
      style={styles.window}
      accessible
      accessibilityLabel={[
        `${windowName(limit)}，已用 ${limit.usedPercent === null && !out ? '未知' : `${used}%`}`,
        out ? '已用完' : null,
        reset,
      ]
        .filter(Boolean)
        .join('，')}
    >
      <View style={styles.windowHead}>
        <Text style={[styles.windowName, { color: c.text }]} numberOfLines={1}>
          {windowName(limit)}
        </Text>
        {out && (
          <View style={[styles.badge, { backgroundColor: c.danger }]}>
            <Text style={[styles.badgeText, { color: c.onAccent }]}>已用完</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        <Text style={[styles.windowValue, { color: limitTextColor(limit, c, c.text) }]}>
          {limit.usedPercent === null && !out ? '—' : `${used}%`}
        </Text>
      </View>
      <View
        style={[styles.bar, props.compact && styles.barCompact, { backgroundColor: c.fillStrong }]}
      >
        <View
          style={[
            styles.barFill,
            { backgroundColor: color, width: `${Math.min(100, Math.max(0, used))}%` },
          ]}
        />
      </View>
      {reset || limit.amount ? (
        <View style={styles.windowFoot}>
          <Text
            style={[styles.reset, { color: out ? c.danger : c.textSecondary }]}
            numberOfLines={1}
          >
            {reset ?? ''}
          </Text>
          {limit.amount ? (
            <Text style={[styles.reset, { color: c.textSecondary }]} numberOfLines={1}>
              {amountText(limit.amount)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** Another agent's plan in a line, which opens to its windows. */
function OtherAgent(props: {
  agent: AgentStatus
  now: number
  reading: boolean
  error: string | null
}) {
  const { c } = useSessionTokens()
  const { agent, now } = props
  const [open, setOpen] = useState(false)
  const lead = leadLimits(agent.limits, now)
  const plan = planName(agent.account)
  return (
    <View>
      <Pressable
        onPress={() => {
          gentle()
          haptic.pick()
          setOpen((was) => !was)
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[
          plan ?? agent.name,
          ...lead.map((l) => `${windowName(l)} 已用 ${Math.round(l.usedPercent ?? 100)}%`),
        ].join('，')}
        style={({ pressed }) => [styles.other, { opacity: pressed ? 0.6 : 1 }]}
      >
        <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={20} />
        <Text style={[styles.otherName, { color: c.text }]} numberOfLines={1}>
          {plan ?? agent.name}
        </Text>
        <View style={{ flex: 1 }} />
        {props.reading && lead.length === 0 ? (
          <ActivityIndicator size="small" color={c.textTertiary} />
        ) : lead.length > 0 ? (
          lead.map((limit) => <LimitChip key={limit.window} limit={limit} now={now} />)
        ) : (
          <Text style={[styles.chipText, { color: c.textTertiary }]}>没有限额</Text>
        )}
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
        </View>
      </Pressable>
      {open && (
        <View style={styles.otherBody}>
          {agent.limits.length > 0 ? (
            agent.limits.map((limit) => (
              <WindowRow key={limit.window} limit={limit} now={now} compact />
            ))
          ) : (
            <Text style={[styles.note, { color: c.textSecondary }]}>{limitsWhy(agent)}</Text>
          )}
          {props.error ? (
            <Text style={[styles.errorText, { color: c.danger }]} numberOfLines={2}>
              没能读到套餐用量：{props.error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingHorizontal: 4 },
  title: { fontSize: 19, lineHeight: 25, fontWeight: '600' },
  where: { flex: 1, textAlign: 'right', fontSize: 14 },
  note: { fontSize: 14, lineHeight: 20 },
  card: { borderRadius: 16, padding: 14, gap: 14 },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  planName: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  planOf: { fontSize: 13, lineHeight: 17 },
  window: { gap: 6 },
  windowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  windowName: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
  windowValue: { fontSize: 15, lineHeight: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  windowFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  reset: { fontSize: 13, lineHeight: 17, fontVariant: ['tabular-nums'] },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barCompact: { height: 4, borderRadius: 2 },
  barFill: { height: '100%', borderRadius: 3 },
  badge: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontSize: 11, lineHeight: 15, fontWeight: '700' },
  loading: { gap: 16 },
  balance: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  error: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retry: { fontSize: 14, fontWeight: '600' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 4,
    minHeight: 28,
  },
  lineName: { flex: 1, fontSize: 15 },
  lineValue: { fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  refresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 30,
  },
  refreshText: { fontSize: 14, fontWeight: '600' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionTitle: { fontSize: 16, fontWeight: '500' },
  actionNote: { fontSize: 13 },
  others: { gap: 4, paddingBottom: 6 },
  othersHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    minHeight: 36,
  },
  section: { fontSize: 15, fontWeight: '500' },
  peek: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  other: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    minHeight: 40,
  },
  otherName: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  otherBody: { gap: 12, paddingLeft: 32, paddingRight: 4, paddingBottom: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipText: { fontSize: 14, fontVariant: ['tabular-nums'] },
})

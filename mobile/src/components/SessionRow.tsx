// One session in a list: its agent's avatar, its title, the project it is in and how it is doing,
// and when it last changed. Swipes and long-press come from the list that holds it.

import { memo, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import Reanimated, { FadeInDown } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { Bot } from 'lucide-react-native'
import type { PlanProgress, SessionPullRequest, SessionSummary } from '@shared/agent-host'
import { folder, listTime, sessionState, sessionTitle, type SessionState } from '../sessions'
import { sessionPullRequests, topPrState } from '../sessionMenu'
import { SubagentMenu } from './SubagentMenu'
import { PR_STATE_TEXT, PrMark } from '../ui/session/gitIcons'
import { AgentAvatar, type AvatarBadge } from '../ui/AgentAvatar'
import { Icon } from '../ui/Icon'
import { OsIcon } from '../ui/OsIcon'
import { Press } from '../ui/Press'
import { SwipeRow, type SwipeAction } from '../ui/SwipeRow'
import { Skeleton } from '../ui/Skeleton'
import {
  motion,
  radius,
  size as sizes,
  space,
  type as typeScale,
  useTokens,
  type Palette,
} from '../ui/tokens'

const BADGES: Record<SessionState, AvatarBadge> = {
  waiting: 'waiting',
  error: 'error',
  live: 'live',
  auth: 'waiting',
  unread: 'unread',
}

function stateColor(c: Palette, kind: SessionState): string {
  return {
    waiting: c.warning,
    auth: c.warning,
    error: c.danger,
    live: c.success,
    unread: c.tint,
  }[kind]
}

/** A session's sub-agents as its row counts them: those running, else all of them. */
export interface SubagentCount {
  count: number
  running: boolean
}

/** The sub-agents of each session, as the desktop's row badge counts them. */
export function subagentCounts(sessions: Iterable<SessionSummary>): Map<string, SubagentCount> {
  const tally = new Map<string, { all: number; running: number }>()
  for (const s of sessions) {
    if (s.parentId === null || s.origin !== 'subagent') continue
    const t = tally.get(s.parentId) ?? { all: 0, running: 0 }
    t.all += 1
    if (s.status === 'running' || s.status === 'awaiting_permission' || s.status === 'starting')
      t.running += 1
    tally.set(s.parentId, t)
  }
  const out = new Map<string, SubagentCount>()
  // Finished sub-agents show only while the parent itself still runs, as a count without a spinner.
  for (const [id, t] of tally) {
    if (t.running > 0) out.set(id, { count: t.running, running: true })
    else out.set(id, { count: t.all, running: false })
  }
  return out
}

/** How long a running turn has gone, as the row's time column shows it. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`
}

/** Re-renders every `everyMs` while `on`, for a clock that counts up. */
function useTick(on: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [on, everyMs])
  return now
}

/** The plan's progress as a small ring and done/total, as the desktop's row shows it. */
function PlanRing(props: { plan: PlanProgress }) {
  const { c } = useTokens()
  const side = 15
  const stroke = 2
  const r = (side - stroke) / 2
  const length = 2 * Math.PI * r
  const share = Math.min(1, props.plan.done / props.plan.total)
  return (
    <View
      style={styles.planRing}
      accessibilityLabel={`计划完成 ${props.plan.done}/${props.plan.total}`}
    >
      <Svg width={side} height={side} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle
          cx={side / 2}
          cy={side / 2}
          r={r}
          stroke={c.fillStrong}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={side / 2}
          cy={side / 2}
          r={r}
          stroke={c.success}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length * share} ${length}`}
          fill="none"
        />
      </Svg>
      <Text style={[typeScale.subhead, styles.time, { color: c.textTertiary }]}>
        {props.plan.done}/{props.plan.total}
      </Text>
    </View>
  )
}

/** The sub-agents' count on a row: a bot, the number, and a spinner while any runs. */
function SubagentBadge(props: { subagents: SubagentCount }) {
  const { c } = useTokens()
  const { count, running } = props.subagents
  return (
    <View
      style={[styles.subagents, { backgroundColor: c.fill, borderColor: c.border }]}
      accessibilityLabel={running ? `${count} 个子 Agent 在运行` : `${count} 个子 Agent`}
    >
      <Bot size={11} color={c.tint} strokeWidth={2.2} />
      <Text style={[styles.subagentText, { color: c.tint }]}>{count}</Text>
      {running && (
        <ActivityIndicator size="small" color={c.textTertiary} style={styles.subagentSpin} />
      )}
    </View>
  )
}

/** A small chip naming the task a step's session works for; it opens the task. */
function TaskChip(props: { id: string; title: string }) {
  const { c } = useTokens()
  return (
    <Pressable
      onPress={() => router.push(`/task/${props.id}`)}
      hitSlop={6}
      accessibilityRole="link"
      accessibilityLabel={`需求：${props.title}，点按打开`}
      style={({ pressed }) => [
        styles.taskChip,
        { backgroundColor: c.tintSoft, opacity: pressed ? motion.pressOpacity : 1 },
      ]}
    >
      <Icon name="flow" size={11} color={c.tint} />
      <Text style={[typeScale.caption, styles.shrink, { color: c.tint }]} numberOfLines={1}>
        {props.title}
      </Text>
    </Pressable>
  )
}

/**
 * A session's pull requests on its row, as the desktop's badge: the icon of the one that most
 * needs someone, the count when there are several, and a red dot for failing checks.
 */
function PrBadge(props: { prs: SessionPullRequest[] }) {
  const { c } = useTokens()
  const { prs } = props
  const failing = prs.some((pr) => pr.failing)
  const states = new Set(prs.map((pr) => pr.state))
  const only = states.size === 1 ? [...states][0] : null
  const label = [
    `${prs.length} 个 Pull Request`,
    only ? (prs.length === 1 ? PR_STATE_TEXT[only] : `全部${PR_STATE_TEXT[only]}`) : null,
    failing ? `${prs.filter((pr) => pr.failing).length} 个检查失败` : null,
  ]
    .filter(Boolean)
    .join('，')
  return (
    <View style={styles.prs} accessibilityRole="image" accessibilityLabel={label}>
      <PrMark state={topPrState(prs)} size={13} failing={failing} ring={c.bg} />
      {prs.length > 1 ? (
        <Text style={[styles.prCount, { color: c.textTertiary }]}>{prs.length}</Text>
      ) : null}
    </View>
  )
}

export const SessionRow = memo(function SessionRow(props: {
  session: SessionSummary
  /** Its sub-agents, counted by `subagentCounts`. */
  subagents?: SubagentCount
  agentName: string | undefined
  /** The project's name as the computer names it, if known. */
  projectName: string | undefined
  /** A search hit's text, shown under the title. */
  snippet?: string
  /** The task a workflow step's session works for: its title on a chip that opens it. */
  task?: { id: string; title: string }
  /** What the time column shows; the last change by default. */
  time?: number
  start?: SwipeAction
  end?: SwipeAction
  /** The session open beside the list (iPad). */
  selected?: boolean
  /** New to the list: it fades and slides in, on the UI thread. */
  appear?: boolean
  /** The computer it is on, when the list shows several: its system and name. */
  mark?: { platform: string | undefined; name: string; offline: boolean }
  /** While the list selects: whether this one is chosen. */
  check?: boolean
  /**
   * The list is not live (the cache's copy, or the computer away): a running session shows as
   * last heard of, without a timer or anything that moves, until the computer answers.
   */
  stale?: boolean
  onPress(): void
  /** Where the system gives no context menu (Android), the long press opens the session's menu. */
  onLongPress?: () => void
}) {
  const { c } = useTokens()
  const s = props.session
  const known = sessionState(s)
  const state =
    known?.kind === 'live' && props.stale ? { kind: 'live' as const, text: '上次在运行' } : known
  const place = s.scratch ? '无项目' : (props.projectName ?? folder(s.projectPath))
  const plan = s.plan && s.plan.total > 0 ? s.plan : null
  const prs = sessionPullRequests(s)
  const running = !props.stale && (s.status === 'running' || s.status === 'starting')
  const subagents =
    props.stale && props.subagents ? { ...props.subagents, running: false } : props.subagents
  const since = running ? (s.turnStartedAt ?? null) : null
  // Seconds count each second through the first minute; minutes and hours need less.
  const counting = since !== null && Date.now() - since < 60_000
  const now = useTick(since !== null, counting ? 1000 : 15_000)
  // A running row says how long its turn has gone; the rest say when they last changed.
  const time = since !== null ? elapsedText(now - since) : listTime(props.time ?? s.updatedAt)
  // The avatar's badge already says it runs; the meta line keeps only what asks for the user, and
  // that a run is only as last heard of.
  const stateText = state && (state.kind !== 'live' || props.stale) ? state : null

  const selecting = props.check !== undefined
  const row = (
    <Press
      onPress={props.onPress}
      {...(props.onLongPress ? { onLongPress: props.onLongPress, delayLongPress: 350 } : {})}
      scale={false}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityLabel={`${sessionTitle(s)}，${place}${props.mark ? `，${props.mark.name}` : ''}${state ? `，${state.text}` : ''}`}
      accessibilityHint={selecting ? '点按选择，按住拖到文件夹上' : '长按查看更多操作'}
      accessibilityState={
        selecting ? { checked: props.check } : props.selected ? { selected: true } : undefined
      }
      // Opaque, so the row lifts as itself when its context menu opens.
      style={[
        styles.row,
        { backgroundColor: c.bg },
        props.selected && [styles.selected, { backgroundColor: c.fillStrong }],
      ]}
    >
      {selecting ? (
        <Icon
          name={props.check ? 'checkCircle' : 'circle'}
          size={22}
          color={props.check ? c.tint : c.textTertiary}
        />
      ) : null}
      <AgentAvatar
        size={sizes.rowAvatar}
        agentId={s.agentId}
        name={props.agentName}
        badge={state ? (state.kind === 'live' && props.stale ? 'stale' : BADGES[state.kind]) : null}
      />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          {s.pinnedAt !== null && <Icon name="pin" size={13} color={c.accent} weight="semibold" />}
          <Text style={[typeScale.rowTitle, styles.title, { color: c.text }]} numberOfLines={1}>
            {sessionTitle(s)}
          </Text>
          {subagents && (running || subagents.running) ? (
            <SubagentMenu parentId={s.id}>
              <SubagentBadge subagents={subagents} />
            </SubagentMenu>
          ) : null}
          {prs.length > 0 ? <PrBadge prs={prs} /> : null}
          <View style={{ flex: 1 }} />
          {plan && running && !props.snippet ? <PlanRing plan={plan} /> : null}
          <Text style={[typeScale.subhead, styles.time, { color: c.textTertiary }]}>{time}</Text>
        </View>
        {props.snippet ? (
          <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={2}>
            {props.snippet}
          </Text>
        ) : null}
        <View style={styles.meta}>
          {props.task ? (
            <TaskChip id={props.task.id} title={props.task.title} />
          ) : (
            <>
              <Icon name="folder" size={13} color={c.textTertiary} />
              <Text
                style={[typeScale.footnote, styles.place, { color: c.textTertiary }]}
                numberOfLines={1}
              >
                {place}
              </Text>
            </>
          )}
          {props.mark ? (
            <View style={styles.mark}>
              <OsIcon
                platform={props.mark.platform}
                size={11}
                color={props.mark.offline ? c.textTertiary : c.textSecondary}
              />
              <Text
                style={[
                  typeScale.footnote,
                  styles.markName,
                  { color: props.mark.offline ? c.textTertiary : c.textSecondary },
                ]}
                numberOfLines={1}
              >
                {props.mark.name}
              </Text>
            </View>
          ) : null}
          {stateText && (
            <Text
              style={[
                typeScale.footnote,
                {
                  color:
                    props.stale && stateText.kind === 'live'
                      ? c.textTertiary
                      : stateColor(c, stateText.kind),
                  fontWeight: '500',
                },
              ]}
              numberOfLines={1}
            >
              {stateText.text}
            </Text>
          )}
          {plan && running && plan.current && !props.snippet && (
            <Text
              style={[typeScale.footnote, styles.plan, { color: c.textTertiary }]}
              numberOfLines={1}
            >
              {plan.current.text}
            </Text>
          )}
        </View>
      </View>
    </Press>
  )

  const body =
    selecting || (!props.start && !props.end) ? (
      row
    ) : (
      <SwipeRow start={props.start} end={props.end} item={s.id}>
        {row}
      </SwipeRow>
    )
  // Only a row that is new to the list comes in; one the list mounts again as it scrolls doesn't.
  if (!props.appear) return body
  return <Reanimated.View entering={ROW_ENTERING}>{body}</Reanimated.View>
})

const ROW_ENTERING = FadeInDown.springify()
  .dampingRatio(0.84)
  .duration(400)
  .withInitialValues({
    opacity: 0,
    transform: [{ translateY: -8 }],
  })

const TITLE_WIDTHS = ['68%', '54%', '76%', '46%', '62%', '50%', '72%'] as const

/** Rows the shape and size of SessionRow's, while the list loads. */
export function SessionRowSkeleton(props: { count?: number }) {
  return (
    <View accessibilityLabel="正在加载">
      {Array.from({ length: props.count ?? 7 }, (_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={sizes.rowAvatar} height={sizes.rowAvatar} radius={sizes.rowAvatar / 2} />
          <View style={styles.body}>
            <View style={[styles.titleLine, styles.skeletonLine]}>
              <View style={styles.title}>
                <Skeleton width={TITLE_WIDTHS[i % TITLE_WIDTHS.length]} height={15} />
              </View>
              <Skeleton width={52} height={12} />
            </View>
            <View style={[styles.meta, styles.skeletonMeta]}>
              <Skeleton width={13} height={11} radius={2} />
              <Skeleton width="22%" height={11} />
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  skeletonLine: { height: typeScale.rowTitle.lineHeight },
  skeletonMeta: { height: typeScale.footnote.lineHeight },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  selected: { marginHorizontal: space.sm, paddingHorizontal: space.md, borderRadius: radius.md },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  title: { flexShrink: 1 },
  time: { fontVariant: ['tabular-nums'], fontWeight: '400' },
  planRing: { flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: space.xs },
  subagents: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 20,
    paddingLeft: 6,
    paddingRight: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  subagentText: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  subagentSpin: { transform: [{ scale: 0.55 }], width: 12, height: 12, marginLeft: -1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  prs: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 2 },
  prCount: { fontSize: 12, fontVariant: ['tabular-nums'] },
  place: { flexShrink: 1, maxWidth: '55%' },
  shrink: { flexShrink: 1 },
  taskChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: '60%',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
  },
  plan: { flexShrink: 1 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, maxWidth: '35%' },
  markName: { flexShrink: 1 },
})

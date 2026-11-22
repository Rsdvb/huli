// What fills a session's context, from the status line's ring: how full it is, a bar of its parts
// and their rows by the desktop's grouping (features/session/composer/context-bar.ts), the prompt
// cache's time left, and the plan's windows on the computer, whose line opens the plan's usage.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { ClipPath, Defs, G as SvgGroup, Path, Pattern, Rect } from 'react-native-svg'
import type { AgentStatus, ContextList } from '@shared/agent-host'
import type { ContextBreakdown } from '@shared/context'
import { expiryOf, knownExpiry, modelOption } from '@shared/prompt-cache'
import type { HostLink } from '@shared/remote/link'
import { compactPrompt, type SessionView } from '@shared/thread'
import { hostErrorText } from '../hostErrors'
import { BottomSheet } from '../ui/BottomSheet'
import { Skeleton } from '../ui/Skeleton'
import { haptic } from '../ui/session/feedback'
import { momentText } from '../ui/session/format'
import { cacheLeftText, useCacheLeft } from '../ui/session/promptCache'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import {
  isExhausted,
  limitTextColor,
  moneyText,
  planName,
  resetText,
  tokensText,
  toneColor,
  usageTone,
  windowName,
} from '../ui/session/limits'
import { useSessionTokens } from '../ui/session/palette'
import { shortModelName } from '../ui/session/optionText'
import { UsageRing } from '../ui/session/StatusLine'
import type { Palette } from '../ui/tokens'
import { modelName, optionOf, shownChoice } from './ConfigMenus'
import { LimitChip, PlanUsageSheet, leadLimits, useTicking } from './PlanUsageSheet'

type Category = ContextBreakdown['categories'][number]
type Part = { kind: 'source'; color: number } | { kind: 'buffer' } | { kind: 'free' }

interface ContextRow {
  name: string
  tokens: number
  share: number | null
  part: Part
}

const FREE = /^free space$/i
const BUFFER = /^autocompact buffer$/i
const KINDS = [/^messages$/i, /^memory files$/i, /^system tools$/i, /^mcp tools$/i]
const SMALL = [/^system prompt$/i, /^skills$/i, /^mcp server instructions$/i]

/** Messages, memory files, system tools and MCP tools in their colors; the small costs in grays. */
function contextRows(categories: Category[]): ContextRow[] {
  const kinds: Category[][] = KINDS.map(() => [])
  const small: Category[][] = SMALL.map(() => [])
  const others: Category[] = []
  const free: ContextRow[] = []
  const buffer: ContextRow[] = []
  for (const category of categories) {
    if (FREE.test(category.name)) free.push({ ...category, part: { kind: 'free' } })
    else if (BUFFER.test(category.name)) buffer.push({ ...category, part: { kind: 'buffer' } })
    else {
      const kind = KINDS.findIndex((name) => name.test(category.name))
      const fixed = SMALL.findIndex((name) => name.test(category.name))
      if (kind >= 0) kinds[kind]!.push(category)
      else if (fixed >= 0) small[fixed]!.push(category)
      else others.push(category)
    }
  }
  const colored = kinds.flatMap((list, index) =>
    list.map((category): ContextRow => ({ ...category, part: { kind: 'source', color: index } })),
  )
  const grays = [...small.flat(), ...others].map((category, index): ContextRow => ({
    ...category,
    part: { kind: 'source', color: KINDS.length + Math.min(index, 2) },
  }))
  return [...colored, ...grays, ...buffer, ...free]
}

const NAMES: Record<string, string> = {
  messages: '消息',
  'memory files': '记忆文件',
  'system tools': '系统工具',
  'mcp tools': 'MCP 工具',
  'system prompt': '系统提示',
  skills: '技能',
  'mcp server instructions': 'MCP 服务器说明',
  'autocompact buffer': '自动压缩预留',
  'free space': '空闲',
}

const rowName = (name: string) => NAMES[name.toLowerCase()] ?? name

/** A listed item's tokens as the agent wrote them, 「1.2k」 or 「12345」, as a count. */
function parseTokens(text: string): number | null {
  const match = /([\d.,]+)\s*([kKmM])?/.exec(text)
  if (!match) return null
  const n = Number(match[1]!.replace(/,/g, ''))
  const unit = match[2]?.toLowerCase()
  return Number.isFinite(n) ? n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1) : null
}

function partColor(part: Part, c: Palette, grays: readonly string[], buffer: string): string {
  if (part.kind === 'buffer') return buffer
  if (part.kind === 'free') return c.fillStrong
  return part.color < KINDS.length ? c.series[part.color]! : grays[part.color - KINDS.length]!
}

type Read =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; breakdown: ContextBreakdown | null }
  | { kind: 'error'; error: string }

export function ContextSheet(props: {
  visible: boolean
  onClose(): void
  link: HostLink
  sessionId: string
  session: SessionView | undefined
  agent: AgentStatus | undefined
  hostName: string
  connected: boolean
}) {
  const { c, s } = useSessionTokens()
  const { session, agent, link, sessionId } = props
  const [read, setRead] = useState<Read>({ kind: 'idle' })
  const [open, setOpen] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  const now = useTicking(props.visible)
  const running = session?.status === 'running' || session?.status === 'awaiting_permission'
  const reports = !!agent?.capabilities.context
  const canRead = reports && (!running || !!agent?.capabilities.liveContext)

  const load = useCallback(() => {
    setRead({ kind: 'loading' })
    ;(link.request('sessions.context', { sessionId }) as Promise<ContextBreakdown | null>).then(
      (breakdown) => setRead({ kind: 'done', breakdown }),
      (error: unknown) => setRead({ kind: 'error', error: hostErrorText(error) }),
    )
  }, [link, sessionId])

  useEffect(() => {
    if (!props.visible) {
      setUsageOpen(false)
      return
    }
    if (!props.connected) return
    if (canRead) load()
    if (agent?.capabilities.reports) {
      // The user opened the sheet: a read they asked for.
      void link.request('agents.refreshLimits', { agentId: agent.id, ask: true }).catch(() => {})
    }
    // Read once each time the sheet opens; later snapshots come with the host's pushes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, props.connected])

  // Opened mid-turn, the breakdown waits for the turn's end, then is read while still shown.
  const readable = props.visible && props.connected && canRead
  const waited = useRef(false)
  useEffect(() => {
    if (!props.visible) waited.current = false
    else if (!canRead) waited.current = true
    else if (readable && waited.current) {
      waited.current = false
      load()
    }
  }, [props.visible, canRead, readable, load])

  const pushed = session?.context?.breakdown ?? null
  const fetched = read.kind === 'done' ? read.breakdown : null
  const breakdown =
    pushed && fetched
      ? pushed.observedAt >= fetched.observedAt
        ? pushed
        : fetched
      : (pushed ?? fetched)
  const usage = session?.usage ?? null
  const used = usage && usage.used > 0 ? usage.used : (breakdown?.used ?? 0)
  const size = usage && usage.size > 0 ? usage.size : (breakdown?.size ?? 0)
  const share = size > 0 ? used / size : 0
  const percent = Math.round(share * 100)
  const tone = toneColor(usageTone({ usedPercent: percent, state: 'ok' }), c)
  const rows = breakdown ? contextRows(breakdown.categories) : null
  const lists = breakdown?.lists ?? []
  const listOf = (name: string): ContextList | undefined =>
    lists.find((l) => l.name.toLowerCase() === name.toLowerCase())
  const unlisted = lists.filter(
    (l) => !rows?.some((r) => r.name.toLowerCase() === l.name.toLowerCase()),
  )
  const model = session ? optionOf(session.config, 'model') : undefined
  const modelLabel = model
    ? shortModelName(shownChoice(model) ?? { name: modelName(String(model.value)) })
    : null

  const expiry = session
    ? knownExpiry(
        expiryOf(
          session.agentId,
          session.usage?.cache,
          modelOption(session.config),
          agent?.account ?? null,
        ),
      )
    : null

  const toggle = (name: string) => {
    setOpen((was) => (was === name ? null : name))
  }

  const limits = agent?.limits ?? []
  const plan = planName(agent?.account ?? null)
  const subscribed = agent?.account ? agent.account.kind === 'account' : limits.length > 0
  const lead = leadLimits(limits, now)
  const rest = limits.filter((limit) => !lead.includes(limit))
  const openUsage = () => {
    haptic.tap()
    setUsageOpen(true)
  }

  // Huli: the agent's own compaction, in one tap, while the session is free to take it; the
  // conversation shows it running as the agent's compaction divider.
  const compact =
    props.connected && session?.status === 'ready' && session.queue.length === 0
      ? compactPrompt(session.commands)
      : null
  const [compacting, setCompacting] = useState(false)
  const runCompact = () => {
    if (!compact || compacting) return
    haptic.tap()
    setCompacting(true)
    link.request('sessions.queue', { sessionId, content: [{ type: 'text', text: compact }] }).then(
      () => {
        setCompacting(false)
        props.onClose()
      },
      (error: unknown) => {
        setCompacting(false)
        Alert.alert('没能压缩上下文', hostErrorText(error))
      },
    )
  }

  return (
    <BottomSheet visible={props.visible} onClose={props.onClose}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
          上下文
        </Text>
        <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
          {[modelLabel, size > 0 ? `${tokensText(size)} 窗口` : null].filter(Boolean).join(' · ')}
        </Text>
      </View>

      {size > 0 ? (
        <View style={styles.big}>
          <Text style={[styles.percent, { color: tone }]}>{percent}%</Text>
          <Text style={[styles.used, { color: c.text }]}>
            {tokensText(used)}
            <Text style={{ color: c.textSecondary }}> / {tokensText(size)} tokens</Text>
          </Text>
        </View>
      ) : (
        <Text style={[styles.note, { color: c.textSecondary }]}>
          这个会话还没有上下文用量，发一条消息后再看。
        </Text>
      )}

      {size > 0 && (
        <ContextBar
          size={size}
          parts={(rows ?? [{ name: 'used', tokens: used, share: null, part: { kind: 'free' } }])
            .filter((row) => row.tokens > 0 && (!rows || row.part.kind !== 'free'))
            .map((row) => ({
              tokens: row.tokens,
              color: rows ? partColor(row.part, c, s.contextGrays, s.contextBuffer) : tone,
              hatched: row.part.kind === 'buffer',
            }))}
        />
      )}

      {rows ? (
        <View style={styles.rows}>
          {rows.map((row) => {
            const list = listOf(row.name)
            const rowShare = row.share ?? (size > 0 ? (row.tokens / size) * 100 : 0)
            const expanded = open === row.name
            return (
              <View key={row.name}>
                <Pressable
                  disabled={!list}
                  onPress={() => toggle(row.name)}
                  accessibilityRole={list ? 'button' : 'text'}
                  accessibilityState={list ? { expanded } : undefined}
                  accessibilityLabel={`${rowName(row.name)}，${tokensText(row.tokens)} tokens，${Math.round(rowShare)}%`}
                  style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
                >
                  {row.part.kind === 'buffer' ? (
                    <HatchSwatch color={s.contextGrays[0]} />
                  ) : (
                    <View
                      style={[
                        styles.swatch,
                        {
                          backgroundColor: partColor(row.part, c, s.contextGrays, s.contextBuffer),
                        },
                      ]}
                    />
                  )}
                  <Text
                    style={[
                      styles.rowName,
                      { color: row.part.kind === 'free' ? c.textSecondary : c.text },
                    ]}
                    numberOfLines={1}
                  >
                    {rowName(row.name)}
                  </Text>
                  {list && (
                    <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
                      <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
                    </View>
                  )}
                  <View style={{ flex: 1 }} />
                  <Text
                    style={[
                      styles.value,
                      { color: row.part.kind === 'free' ? c.textSecondary : c.text },
                    ]}
                  >
                    {tokensText(row.tokens)}
                  </Text>
                  <Text style={[styles.share, { color: c.textSecondary }]}>
                    {Math.round(rowShare)}%
                  </Text>
                </Pressable>
                {expanded && list && <ListItems list={list} />}
              </View>
            )
          })}
          {unlisted.map((list) => (
            <View key={list.name}>
              <Pressable
                onPress={() => toggle(list.name)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open === list.name }}
                style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
                <Text style={[styles.rowName, { color: c.text }]}>{rowName(list.name)}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[styles.share, { color: c.textSecondary }]}>{list.items.length}</Text>
              </Pressable>
              {open === list.name && <ListItems list={list} />}
            </View>
          ))}
        </View>
      ) : read.kind === 'loading' && size > 0 ? (
        <View style={styles.loading} accessibilityLabel="正在读取上下文构成">
          {(['80%', '60%', '66%'] as const).map((width) => (
            <View key={width} style={styles.row}>
              <Skeleton width={SWATCH} height={SWATCH} radius={3} />
              <Skeleton width={width} height={12} />
            </View>
          ))}
        </View>
      ) : read.kind === 'error' ? (
        <View style={styles.state}>
          <Text style={[styles.note, { color: c.danger }]}>没能读到构成：{read.error}</Text>
          <Pressable onPress={load} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.retry, { color: c.tint }]}>重试</Text>
          </Pressable>
        </View>
      ) : size > 0 && reports && running && !canRead ? (
        <Text style={[styles.note, { color: c.textSecondary }]}>这一轮结束后可以看到构成。</Text>
      ) : null}

      {compact && (
        <Pressable
          onPress={runCompact}
          disabled={compacting}
          accessibilityRole="button"
          accessibilityLabel="压缩上下文，把之前的对话总结成摘要"
          accessibilityState={{ busy: compacting }}
          style={({ pressed }) => [
            styles.compact,
            { backgroundColor: c.fill, opacity: pressed || compacting ? 0.6 : 1 },
          ]}
        >
          <Icon icon={G.compact} size={16} color={c.text} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={[styles.compactTitle, { color: c.text }]}>压缩上下文</Text>
            <Text style={[styles.note, styles.compactNote, { color: c.textSecondary }]}>
              把之前的对话总结成摘要，腾出空间
            </Text>
          </View>
          <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
        </Pressable>
      )}

      {expiry && <CacheBlock expiry={expiry} used={used} />}

      {(subscribed && agent) || usage?.tokens || usage?.cost ? (
        <View style={styles.plan}>
          {subscribed && agent && (
            <>
              <Text style={[styles.section, { color: c.textSecondary }]}>
                {props.hostName} 上的套餐用量
              </Text>
              <Pressable
                onPress={openUsage}
                accessibilityRole="button"
                accessibilityLabel={[
                  plan ?? agent.name,
                  ...lead.map((l) =>
                    isExhausted(l, now)
                      ? `${windowName(l)}已用完`
                      : `${windowName(l)}已用 ${Math.round(l.usedPercent ?? 0)}%`,
                  ),
                  '查看套餐用量',
                ].join('，')}
                style={({ pressed }) => [styles.planHead, { opacity: pressed ? 0.55 : 1 }]}
              >
                <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={20} />
                <Text style={[styles.planName, { color: c.text }]} numberOfLines={1}>
                  {plan ?? agent.name}
                </Text>
                <View style={{ flex: 1 }} />
                {lead.map((limit) => (
                  <LimitChip key={limit.window} limit={limit} now={now} />
                ))}
                <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
              </Pressable>
              {limits.length === 0 ? (
                <Text style={[styles.note, { color: c.textSecondary }]}>
                  {agent.limitsError
                    ? `没能读到套餐用量：${agent.limitsError}`
                    : '还没有读到套餐用量。'}
                </Text>
              ) : (
                rest.map((limit) => (
                  <View key={limit.window} style={styles.limitRow}>
                    <Text style={[styles.limitName, { color: c.textSecondary }]} numberOfLines={1}>
                      {windowName(limit)}
                    </Text>
                    <Text style={[styles.limitValue, { color: c.text }]} numberOfLines={1}>
                      <Text style={{ color: limitTextColor(limit, c, c.text) }}>
                        {isExhausted(limit, now)
                          ? '已用完'
                          : limit.usedPercent === null
                            ? '—'
                            : `${Math.round(limit.usedPercent)}%`}
                      </Text>
                      {limit.resetsAt ? ` · ${resetText(limit.resetsAt, now)}` : ''}
                    </Text>
                  </View>
                ))
              )}
            </>
          )}
          {usage?.tokens || usage?.cost ? (
            <View style={styles.limitRow}>
              <Text style={[styles.limitName, { color: c.textSecondary }]}>本会话</Text>
              <Text style={[styles.limitValue, { color: c.text }]}>
                {[
                  usage.tokens ? `${tokensText(usage.tokens.total)} token` : null,
                  usage.cost ? `≈ ${moneyText(usage.cost.amount, usage.cost.currency)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <PlanUsageSheet
        visible={usageOpen}
        onClose={() => setUsageOpen(false)}
        agentId={agent?.id ?? null}
        usage={usage}
        onLeave={props.onClose}
      />
    </BottomSheet>
  )
}

const BAR = 8
const BAR_GAP = 1.5
// A part this small still shows as a sliver, as the desktop's bar keeps every source in sight.
const SLIVER = 2

/** The context as one bar: each part in its color, the buffer hatched, then what is free. */
function ContextBar(props: {
  size: number
  parts: { tokens: number; color: string; hatched: boolean }[]
}) {
  const { c, s } = useSessionTokens()
  const [width, setWidth] = useState(0)
  let x = 0
  const rects = props.parts.map((part, index) => {
    const w = Math.max(SLIVER, (part.tokens / props.size) * width - BAR_GAP)
    const rect = { x, w, part, index }
    x += w + BAR_GAP
    return rect
  })
  return (
    <View
      style={styles.bar}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0 && (
        <Svg width={width} height={BAR}>
          <Defs>
            <ClipPath id="bar">
              <Rect x={0} y={0} width={width} height={BAR} rx={BAR / 2} />
            </ClipPath>
            <Pattern
              id="hatch"
              patternUnits="userSpaceOnUse"
              width={4}
              height={4}
              patternTransform="rotate(45)"
            >
              <Rect x={0} y={0} width={1.6} height={4} fill={s.contextGrays[0]} />
            </Pattern>
          </Defs>
          <SvgGroup clipPath="url(#bar)">
            <Rect x={0} y={0} width={width} height={BAR} fill={c.fillStrong} />
            {rects.map(({ x: left, w, part, index }) => (
              <Rect
                key={index}
                x={left}
                y={0}
                width={w}
                height={BAR}
                fill={part.hatched ? 'url(#hatch)' : part.color}
              />
            ))}
          </SvgGroup>
        </Svg>
      )}
    </View>
  )
}

/** The buffer's swatch: two strokes, as the desktop's hatched key. */
function HatchSwatch(props: { color: string }) {
  return (
    <Svg width={SWATCH} height={SWATCH} viewBox="0 0 10 10">
      <Path
        d="M1 7.5 L5 2.5 M5 9 L9 4"
        stroke={props.color}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  )
}

const SWATCH = 10

function itemTokens(text: string): string {
  const n = parseTokens(text)
  return n === null ? text : tokensText(n)
}

function ListItems(props: { list: ContextList }) {
  const { c } = useSessionTokens()
  return (
    <View style={styles.items}>
      {props.list.items.map((item, index) => (
        <View key={index} style={styles.item}>
          <Text style={[styles.itemName, { color: c.textSecondary }]} numberOfLines={1}>
            {item.name}
            {item.detail ? <Text style={{ color: c.textTertiary }}> · {item.detail}</Text> : null}
          </Text>
          <Text style={[styles.itemValue, { color: c.textTertiary }]}>
            {itemTokens(item.tokens)}
          </Text>
        </View>
      ))}
    </View>
  )
}

/** The cache's time left, counting as the status line's chip does, so the two always agree. */
function CacheBlock(props: { expiry: NonNullable<ReturnType<typeof knownExpiry>>; used: number }) {
  const { c } = useSessionTokens()
  const { expiry } = props
  const left = useCacheLeft(expiry.expiresAt)
  const state =
    left <= 0
      ? expiry.estimate
        ? '可能已过期'
        : '已过期'
      : `${expiry.estimate ? '约剩' : '剩余'} ${cacheLeftText(left)}`
  const color = left <= 0 ? c.textTertiary : left <= 60_000 ? c.warning : c.tint
  return (
    <View style={styles.cache}>
      <Text style={[styles.section, { color: c.textSecondary }]}>提示词缓存</Text>
      <View style={styles.cacheRow}>
        <UsageRing
          percent={(left / expiry.ttl) * 100}
          color={color}
          track={c.fillStrong}
          size={24}
          stroke={3}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.cacheLine, { color: c.text }]}>
            {state} · 上次请求 {momentText(expiry.lastRequestAt)}
          </Text>
          <Text style={[styles.note, { color: c.textSecondary }]}>
            {left > 0 ? '之后' : ''}下一条消息会按全价重新读取全部 {tokensText(props.used)} token。
          </Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingHorizontal: 4 },
  title: { fontSize: 19, lineHeight: 25, fontWeight: '600' },
  meta: { flex: 1, textAlign: 'right', fontSize: 15 },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4 },
  percent: { fontSize: 38, lineHeight: 44, fontWeight: '700', fontVariant: ['tabular-nums'] },
  used: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bar: { height: BAR, marginHorizontal: 4 },
  rows: { paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: 2.5 },
  rowName: { fontSize: 15, flexShrink: 1 },
  value: { fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 56, textAlign: 'right' },
  share: { fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
  loading: { paddingHorizontal: 4 },
  items: { paddingLeft: 18, paddingBottom: 6, gap: 4 },
  item: { flexDirection: 'row', gap: 10 },
  itemName: { flex: 1, fontSize: 13 },
  itemValue: { fontSize: 13, fontVariant: ['tabular-nums'] },
  state: { alignItems: 'center', gap: 8, paddingVertical: 12 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  retry: { fontSize: 14, fontWeight: '600' },
  section: { fontSize: 15, fontWeight: '500', paddingHorizontal: 4 },
  cache: { gap: 8, marginTop: 6 },
  cacheRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  cacheLine: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  plan: { gap: 4, marginTop: 6, paddingBottom: 8 },
  planHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    minHeight: 36,
  },
  planName: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  limitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    minHeight: 26,
  },
  limitName: { fontSize: 15, flex: 1 },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
  },
  compactTitle: { fontSize: 16, fontWeight: '600' },
  compactNote: { paddingHorizontal: 0 },
  limitValue: { fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
})

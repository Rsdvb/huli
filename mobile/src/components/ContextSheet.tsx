// What fills a session's context, from the status line's ring: how full it is, a bar of its parts
// and their rows by the desktop's grouping (features/session/composer/context-bar.ts), the prompt
// cache's time left, and the plan's windows on the computer.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentStatus, ContextList } from '@shared/agent-host'
import type { ContextBreakdown } from '@shared/context'
import { expiryOf, knownExpiry, modelOption } from '@shared/prompt-cache'
import type { HostLink } from '@shared/remote/link'
import type { SessionView } from '@shared/thread'
import { errorText } from '../sessions'
import { BottomSheet } from '../ui/BottomSheet'
import { clockTime } from '../ui/session/format'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import {
  limitColor,
  planName,
  resetText,
  tokensText,
  toneColor,
  usageTone,
  windowName,
} from '../ui/session/limits'
import { useSessionTokens } from '../ui/session/palette'
import { gentle } from '../ui/session/Press'
import { UsageRing } from '../ui/session/StatusLine'
import type { Palette } from '../ui/tokens'
import { modelName, optionOf, shownChoice } from './ConfigMenus'

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
  'autocompact buffer': '自动压缩预留',
  'free space': '空闲',
}

const rowName = (name: string) => NAMES[name.toLowerCase()] ?? name

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
  const [now, setNow] = useState(Date.now())
  const running = session?.status === 'running' || session?.status === 'awaiting_permission'
  const reports = !!agent?.capabilities.context
  const canRead = reports && (!running || !!agent?.capabilities.liveContext)

  const load = useCallback(() => {
    setRead({ kind: 'loading' })
    ;(link.request('sessions.context', { sessionId }) as Promise<ContextBreakdown | null>).then(
      (breakdown) => setRead({ kind: 'done', breakdown }),
      (error: unknown) => setRead({ kind: 'error', error: errorText(error) }),
    )
  }, [link, sessionId])

  useEffect(() => {
    if (!props.visible || !props.connected) return
    setNow(Date.now())
    if (canRead) load()
    if (agent) {
      void link.request('agents.refreshLimits', { agentId: agent.id }).catch(() => {})
    }
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
    // Read once each time the sheet opens; later snapshots come with the host's pushes.
  }, [props.visible, props.connected])

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
  const modelLabel = model ? modelName(shownChoice(model)?.name ?? String(model.value)) : null

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
    gentle()
    setOpen((was) => (was === name ? null : name))
  }

  const limits = agent?.limits ?? []
  const plan = planName(agent?.account ?? null)
  const subscribed = agent?.account ? agent.account.kind === 'account' : limits.length > 0

  return (
    <BottomSheet visible={props.visible} onClose={props.onClose}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.text }]}>上下文</Text>
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
        <View style={[styles.bar, { backgroundColor: c.fillStrong }]}>
          {(
            rows ?? [
              { name: 'used', tokens: used, share: null, part: { kind: 'source', color: 0 } },
            ]
          )
            .filter((row) => row.tokens > 0 && row.part.kind !== 'free')
            .map((row, index) => (
              <View
                key={`${index}-${row.name}`}
                style={{
                  flex: row.tokens,
                  backgroundColor: rows
                    ? partColor(row.part, c, s.contextGrays, s.contextBuffer)
                    : c.textTertiary,
                  marginRight: 1,
                }}
              />
            ))}
          <View style={{ flex: Math.max(0, size - (rows ? sumUsed(rows) : used)) }} />
        </View>
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
                  <View
                    style={[
                      styles.swatch,
                      {
                        backgroundColor: partColor(row.part, c, s.contextGrays, s.contextBuffer),
                      },
                      row.part.kind === 'free' && { opacity: 0.6 },
                    ]}
                  />
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
                  <Text style={[styles.value, { color: c.text }]}>{tokensText(row.tokens)}</Text>
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
        <View style={styles.state}>
          <ActivityIndicator size="small" color={c.textSecondary} />
          <Text style={[styles.note, { color: c.textSecondary }]}>正在读取构成…</Text>
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

      {expiry && <CacheBlock expiry={expiry} used={used} now={now} />}

      {subscribed && agent && (
        <View style={styles.plan}>
          <Text style={[styles.section, { color: c.textSecondary }]}>
            {props.hostName} 上的套餐用量
          </Text>
          <View style={styles.planHead}>
            <AgentGlyph agentId={agent.id} harness={agent.harnessId} size={20} />
            <Text style={[styles.planName, { color: c.text }]} numberOfLines={1}>
              {plan ?? agent.name}
            </Text>
          </View>
          {limits.length === 0 ? (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              {agent.limitsError ? `没能读到用量：${agent.limitsError}` : '还没有读到用量。'}
            </Text>
          ) : (
            limits.map((limit) => (
              <View key={limit.window} style={styles.limitRow}>
                <UsageRing
                  percent={limit.usedPercent ?? 0}
                  color={limitColor(limit, c)}
                  track={c.fillStrong}
                  size={15}
                />
                <Text style={[styles.limitName, { color: c.textSecondary }]} numberOfLines={1}>
                  {windowName(limit)}
                </Text>
                <Text style={[styles.limitValue, { color: c.text }]} numberOfLines={1}>
                  {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
                  {limit.resetsAt ? ` · ${resetText(limit.resetsAt, now)}` : ''}
                </Text>
              </View>
            ))
          )}
          {usage?.tokens || usage?.cost ? (
            <View style={styles.limitRow}>
              <View style={{ width: 15 }} />
              <Text style={[styles.limitName, { color: c.textSecondary }]}>本会话</Text>
              <Text style={[styles.limitValue, { color: c.text }]}>
                {[
                  usage.tokens ? `${tokensText(usage.tokens.total)} token` : null,
                  usage.cost ? `≈ ${usage.cost.amount.toFixed(2)} ${usage.cost.currency}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </BottomSheet>
  )
}

function sumUsed(rows: ContextRow[]): number {
  return rows.reduce((sum, row) => (row.part.kind === 'free' ? sum : sum + row.tokens), 0)
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
          <Text style={[styles.itemValue, { color: c.textTertiary }]}>{item.tokens}</Text>
        </View>
      ))}
    </View>
  )
}

function CacheBlock(props: {
  expiry: NonNullable<ReturnType<typeof knownExpiry>>
  used: number
  now: number
}) {
  const { c } = useSessionTokens()
  const { expiry, now } = props
  const left = Math.max(0, expiry.expiresAt - now)
  const minutes = Math.ceil(left / 60_000)
  const leftText =
    left <= 0
      ? expiry.estimate
        ? '大概已经过期'
        : '已过期'
      : `${expiry.estimate ? '大约' : ''}剩余 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}`
  const color = left <= 0 ? c.textTertiary : left <= 60_000 ? c.warning : c.tint
  return (
    <View style={styles.cache}>
      <Text style={[styles.section, { color: c.textSecondary }]}>Prompt cache</Text>
      <View style={styles.cacheRow}>
        <UsageRing
          percent={(left / expiry.ttl) * 100}
          color={color}
          track={c.fillStrong}
          size={30}
          stroke={3.5}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.cacheLine, { color: c.text }]}>
            {leftText} · 上次请求 {clockTime(expiry.lastRequestAt)}
          </Text>
          <Text style={[styles.note, { color: c.textSecondary }]}>
            {left > 0 ? '之后' : ''}下一条消息会按全价重新读取全部 {tokensText(props.used)}。
          </Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingHorizontal: 4 },
  title: { fontSize: 20, fontWeight: '700' },
  meta: { flex: 1, textAlign: 'right', fontSize: 14 },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4 },
  percent: { fontSize: 40, lineHeight: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  used: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    marginHorizontal: 4,
  },
  rows: { paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  swatch: { width: 11, height: 11, borderRadius: 3 },
  rowName: { fontSize: 16, flexShrink: 1 },
  value: { fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 56, textAlign: 'right' },
  share: { fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
  items: { paddingLeft: 19, paddingBottom: 6, gap: 4 },
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
  plan: { gap: 6, marginTop: 6, paddingBottom: 8 },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  planName: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  limitName: { fontSize: 15, flex: 1 },
  limitValue: { fontSize: 15, fontVariant: ['tabular-nums'] },
})

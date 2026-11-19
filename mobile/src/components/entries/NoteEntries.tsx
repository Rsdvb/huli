// The host's own notes in a conversation, as the desktop words them: another agent taking the
// session over, the user taking a surface over and handing it back, a message from another session,
// and a session or sub-agent this one started, with whether it waits for the user.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { harnessOf, type ThreadEntry } from '@shared/thread'
import { useAgent, useConnected, useLink, useSession } from '../../host'
import { sessionTitle } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { WorkingDots } from '../../ui/session/Working'
import { gentle } from '../../ui/session/Press'
import { spanText } from '../../ui/session/format'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { subagentRunning, useSubagentDigest } from '../../ui/session/subagents'
import { durationText } from '../../ui/session/work'
import { useAgentName } from './AccessEntries'
import { E, QuietLine } from './kit'

type Of<K extends ThreadEntry['kind']> = Extract<ThreadEntry, { kind: K }>

const HARNESS_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
  pi: 'Pi',
}

export function TakeoverEntry(props: { entry: Of<'takeover'> }) {
  const { entry } = props
  const { c } = useSessionTokens()
  const agent = useAgent(entry.agentId)
  const [open, setOpen] = useState(false)
  const name = agent?.name ?? HARNESS_NAMES[harnessOf(entry.agentId)] ?? 'Agent'
  const text = entry.turns > 0 ? `由 ${name} 接手 · 带上前面 ${entry.turns} 轮` : `由 ${name} 接手`
  return (
    <View>
      <QuietLine
        icon={G.swap}
        text={text}
        {...(entry.carried
          ? {
              onPress: () => {
                gentle()
                setOpen((v) => !v)
              },
            }
          : {})}
      />
      {open && (
        <View style={[styles.panel, { backgroundColor: c.fill }]}>
          <Text style={[styles.small, { color: c.textTertiary }]}>
            {entry.omitted > 0
              ? `带过去的内容。还有 ${entry.omitted} 轮没带，它能用读历史的工具取回。`
              : '带过去的内容。'}
          </Text>
          {entry.summarize ? (
            <Text style={[styles.small, { color: c.textTertiary }]}>
              已要求它先总结前面的对话再接着做
            </Text>
          ) : null}
          <Text selectable style={[styles.carried, { color: c.textSecondary }]}>
            {entry.carried.length > 6000 ? `${entry.carried.slice(0, 6000)}\n…` : entry.carried}
          </Text>
        </View>
      )}
    </View>
  )
}

const SURFACE: Record<Of<'control_note'>['surface'], string> = {
  browser: '浏览器',
  device: '设备',
  terminal: '终端',
  computer: '电脑',
}

export function ControlNoteEntry(props: { entry: Of<'control_note'>; sessionId: string }) {
  const { entry } = props
  const agent = useAgentName(props.sessionId)
  const text =
    entry.event === 'paused'
      ? `你点了 ${entry.app}，${agent} 暂停了`
      : `你用了${SURFACE[entry.surface]} ${spanText(entry.durationMs)}，然后交还`
  return <QuietLine icon={E.cursor} text={text} />
}

/** In a session another one messaged: who sent it and what it says, quoted. */
export function SessionMessageEntry(props: { entry: Of<'session_message'> }) {
  const { entry } = props
  const { c } = useSessionTokens()
  const sender = useSession(entry.senderId)
  const text = entry.content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : part.ref.kind === 'attachment'
          ? `[${part.ref.attachment.name}]`
          : part.ref.kind === 'link'
            ? part.ref.name
            : '',
    )
    .filter(Boolean)
    .join('\n')
  return (
    <Pressable
      disabled={!sender}
      onPress={() => sender && router.push(`/session/${sender.id}`)}
      style={({ pressed }) => [
        styles.quote,
        { backgroundColor: c.fill, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.quoteHead}>
        <Icon icon={E.message} size={12} color={c.textTertiary} />
        <Text style={[styles.small, { color: c.textTertiary, fontWeight: '500' }]}>
          {sender ? `来自 ${sessionTitle(sender)}` : '来自父会话'}
        </Text>
      </View>
      <Text selectable style={[styles.quoteText, { color: c.textSecondary }]}>
        {text}
      </Text>
    </Pressable>
  )
}

/**
 * A session this one started, or a sub-agent of it: its title, and whether it waits for the user,
 * failed, runs or is done; a tap opens it.
 */
/**
 * The first line of a sub-session the user started: the session it started from, which it opens.
 * Nothing else is handed over, so it names nothing more.
 */
export function SubSessionStart(props: { sessionId: string }) {
  const { c } = useSessionTokens()
  const summary = useSession(props.sessionId)
  const parent = useSession(summary?.origin === 'user' ? summary.parentId : null)
  if (!parent) return null
  return (
    <View style={[styles.started, { backgroundColor: c.fill }]}>
      <Icon icon={G.child} size={13} color={c.textTertiary} />
      <Text style={[styles.startedText, { color: c.textSecondary }]}>
        从{' '}
        <Text
          style={{ color: c.text, fontWeight: '600' }}
          onPress={() => router.push(`/session/${parent.id}`)}
          accessibilityRole="link"
        >
          {sessionTitle(parent)}
        </Text>{' '}
        开始
      </Text>
    </View>
  )
}

/** How long a running sub-agent has run, ticking each second. */
function Elapsed(props: { since: number; color: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <Text style={[styles.small, { color: props.color, fontVariant: ['tabular-nums'] }]}>
      {durationText(Math.max(0, now - props.since))}
    </Text>
  )
}

export function ChildEntry(props: { entry: Of<'subagent'> | Of<'session_started'> }) {
  const { entry } = props
  const { c, s } = useSessionTokens()
  const connected = useConnected()
  const link = useLink()
  const child = useSession(entry.sessionId)
  const digest = useSubagentDigest(link, entry.kind === 'subagent' ? child : undefined, connected)
  const waiting =
    !!child &&
    (child.permissionCount > 0 ||
      child.attention === 'permission' ||
      child.status === 'awaiting_permission')
  const failed = !!child && (child.attention === 'error' || child.status === 'failed')
  const running = !!child && subagentRunning(child)
  const cancelled = !running && !failed && digest?.stopReason === 'cancelled'
  const title = child
    ? sessionTitle(child)
    : entry.kind === 'subagent'
      ? '子 Agent'
      : '已启动一个会话'
  const label = entry.kind === 'session_started' && child ? `已启动 ${title}` : title
  // While it runs, the time since it started; once it ends, its run's.
  const ticking = running && child && digest?.durationMs == null ? child.createdAt : null
  if (entry.kind === 'subagent') {
    // Its state first, then its type and its tools and time: 「正在运行 · general-purpose · 3 个工具
    // · 12 秒」, 「已完成 · 1 分 20 秒」.
    const state = waiting
      ? '需要授权'
      : failed
        ? '失败'
        : running
          ? '正在运行'
          : cancelled
            ? '已取消'
            : child
              ? '已完成'
              : null
    const facts = [
      child?.description || null,
      digest?.tools != null ? `${digest.tools} 个工具` : null,
      !running && digest?.durationMs != null ? durationText(digest.durationMs) : null,
    ].filter(Boolean)
    const stateColor = waiting ? c.warning : failed ? c.danger : c.textSecondary
    const dot = <Text style={{ color: c.textTertiary }}>{'  ·  '}</Text>
    return (
      <Pressable
        onPress={() => child && router.push(`/session/${entry.sessionId}`)}
        disabled={!child}
        accessibilityRole="button"
        accessibilityLabel={[title, state, ...facts].filter(Boolean).join('，')}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: waiting ? s.warningSoft : c.surface,
            borderColor: waiting ? c.warning : c.border,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <AgentAvatar agentId={child?.agentId ?? ''} size={36} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[styles.cardTitle, { color: c.text }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.cardMeta}>
            {waiting ? (
              <View style={[styles.dot, { backgroundColor: c.warning }]} />
            ) : failed ? (
              <Icon icon={G.failed} size={12} color={c.danger} />
            ) : running ? (
              <WorkingDots color={c.accent} size={11} phase={child?.working?.phase} />
            ) : child && !cancelled ? (
              <Icon icon={G.check} size={12} color={c.success} weight="semibold" />
            ) : null}
            <Text style={[styles.metaText, { color: c.textTertiary }]} numberOfLines={1}>
              {state ? <Text style={{ color: stateColor }}>{state}</Text> : null}
              {facts.map((fact, i) => (
                <Text key={i}>
                  {state || i > 0 ? dot : null}
                  {fact}
                </Text>
              ))}
              {ticking !== null ? (
                <Text>
                  {dot}
                  <Elapsed since={ticking} color={c.textTertiary} />
                </Text>
              ) : null}
            </Text>
          </View>
        </View>
        <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
      </Pressable>
    )
  }
  return (
    <Pressable
      onPress={() => router.push(`/session/${entry.sessionId}`)}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.child,
        {
          backgroundColor: waiting ? s.warningSoft : c.fill,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon icon={G.subagent} size={14} color={waiting ? c.warning : c.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.childTitle, { color: c.text }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {waiting ? (
        <Text style={[styles.pill, { color: c.warning, backgroundColor: s.warningSoft }]}>
          需要授权
        </Text>
      ) : failed ? (
        <Text style={[styles.small, { color: c.danger }]}>失败</Text>
      ) : running ? (
        <ActivityIndicator
          size="small"
          color={c.textTertiary}
          style={{ transform: [{ scale: 0.75 }] }}
        />
      ) : child ? (
        <Text style={[styles.small, { color: c.textTertiary }]}>已完成</Text>
      ) : null}
      <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />
    </Pressable>
  )
}

const STOP_REASON = {
  end_turn: null,
  cancelled: '已取消',
  max_tokens: '已达到 token 上限而停止',
  max_turn_requests: '已达到请求次数上限而停止',
  refusal: 'Agent 拒绝了请求',
} as const

/** A turn's end, when it shows on its own rather than as a turn's footer. */
export function TurnEndEntry(props: { entry: Of<'turn_end'> }) {
  const { entry } = props
  const reason = STOP_REASON[entry.stopReason]
  const time = spanText(entry.durationMs)
  return (
    <QuietLine
      icon={entry.stopReason === 'cancelled' ? G.stopOutline : G.info}
      text={reason ? (entry.durationMs >= 1000 ? `${reason} · ${time}` : reason) : `用时 ${time}`}
    />
  )
}

const styles = StyleSheet.create({
  panel: { borderRadius: 12, padding: 12, gap: 6, marginTop: 4, marginBottom: 4 },
  small: { fontSize: 12, lineHeight: 16 },
  carried: { fontSize: 12, lineHeight: 18 },
  quote: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  quoteHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  quoteText: { fontSize: 14, lineHeight: 20 },
  child: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 40,
    paddingVertical: 6,
  },
  childTitle: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    paddingRight: 14,
    paddingVertical: 10,
  },
  cardTitle: { fontSize: 15.5, lineHeight: 20, fontWeight: '600' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { flexShrink: 1, fontSize: 13.5, lineHeight: 18 },
  statusCol: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  started: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  startedText: { flex: 1, fontSize: 13, lineHeight: 18 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
})

// The host's own notes in a conversation, as the desktop words them: another agent taking the
// session over, the user taking a surface over and handing it back, a message from another session,
// and a session or sub-agent this one started, with whether it waits for the user.

import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { harnessOf, type ThreadEntry } from '@shared/thread'
import { useHost } from '../../host'
import { sessionTitle } from '../../sessions'
import { gentle } from '../../ui/session/Press'
import { spanText } from '../../ui/session/format'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
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
  const { agents } = useHost()
  const [open, setOpen] = useState(false)
  const name = agents.get(entry.agentId)?.name ?? HARNESS_NAMES[harnessOf(entry.agentId)] ?? 'Agent'
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
  const { sessions } = useHost()
  const sender = entry.senderId ? sessions.get(entry.senderId) : undefined
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
export function ChildEntry(props: { entry: Of<'subagent'> | Of<'session_started'> }) {
  const { entry } = props
  const { c, s } = useSessionTokens()
  const { sessions } = useHost()
  const child = sessions.get(entry.sessionId)
  const waiting =
    !!child &&
    (child.permissionCount > 0 ||
      child.attention === 'permission' ||
      child.status === 'awaiting_permission')
  const failed = !!child && (child.attention === 'error' || child.status === 'failed')
  const running = child?.status === 'running' || child?.status === 'starting'
  const title = child
    ? sessionTitle(child)
    : entry.kind === 'subagent'
      ? '子 Agent'
      : '已启动一个会话'
  const label = entry.kind === 'session_started' && child ? `已启动 ${title}` : title
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
        {entry.kind === 'subagent' && child?.description ? (
          <Text style={[styles.small, { color: c.textTertiary }]} numberOfLines={1}>
            {child.description}
          </Text>
        ) : null}
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
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
})

// One row of a session's conversation: the user's bubble, the agent's reply in full width, its
// thinking and tool calls as quiet lines that open, the turn's changes and footer, and the host's
// own records as small notes.

import { memo, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { ThreadEntry } from '@shared/thread'
import { useSessionRows } from '../ui/session/context'
import { copyText, plainText, showMenu } from '../ui/session/feedback'
import { spanText } from '../ui/session/format'
import { G, Icon, type IconSpec } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { gentle } from '../ui/session/Press'
import { ToolRow } from '../ui/session/ToolRow'
import { TurnChanges } from '../ui/session/TurnChanges'
import { TurnFooter } from '../ui/session/TurnFooter'
import { sameRow, type Row } from '../ui/session/turns'
import { Markdown } from './Markdown'
import { UserMessage } from './UserMessage'

type Of<K extends ThreadEntry['kind']> = Extract<ThreadEntry, { kind: K }>

function Reply(props: { entry: Of<'agent'> }) {
  const { entry } = props
  const { selectText } = useSessionRows()
  const menu = () =>
    showMenu(undefined, [
      { label: '复制', onPress: () => void copyText(plainText(entry.markdown)) },
      { label: '复制为 Markdown', onPress: () => void copyText(entry.markdown) },
      { label: '选择文本', onPress: () => selectText(plainText(entry.markdown)) },
    ])
  if (!entry.markdown && !entry.streaming) return null
  return (
    <Pressable onLongPress={entry.markdown ? menu : undefined} delayLongPress={400}>
      <Markdown markdown={entry.markdown} streaming={entry.streaming} />
    </Pressable>
  )
}

function Thought(props: { entry: Of<'thought'> }) {
  const { c } = useSessionTokens()
  const { entry } = props
  const [open, setOpen] = useState(false)
  const label = entry.streaming
    ? '思考中…'
    : entry.durationMs
      ? `思考了 ${spanText(entry.durationMs)}`
      : '思考过程'
  return (
    <View>
      <Pressable
        onPress={() => {
          gentle()
          setOpen((v) => !v)
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.quiet, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Icon icon={G.thought} size={14} color={c.textTertiary} />
        <Text style={[styles.quietText, { color: c.textSecondary }]}>{label}</Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />
        </View>
      </Pressable>
      {open && entry.markdown ? (
        <View style={[styles.thoughtBody, { borderLeftColor: c.borderStrong }]}>
          <Markdown markdown={entry.markdown} size="compact" color={c.textSecondary} />
        </View>
      ) : null}
    </View>
  )
}

function Plan(props: { entry: Of<'plan'> }) {
  const { c, s } = useSessionTokens()
  const items = props.entry.items
  const done = items.filter((item) => item.status === 'completed').length
  return (
    <View style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.border }]}>
      <View style={styles.cardHead}>
        <Icon icon={G.plan} size={15} color={c.textSecondary} />
        <Text style={[styles.cardTitle, { color: c.text }]}>计划</Text>
        <Text style={[styles.count, { color: c.textTertiary }]}>
          {done}/{items.length}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        {items.map((item, i) => {
          const icon =
            item.status === 'completed' ? G.done : item.status === 'in_progress' ? G.doing : G.todo
          const color =
            item.status === 'completed'
              ? c.success
              : item.status === 'in_progress'
                ? c.tint
                : c.textTertiary
          return (
            <View key={i} style={styles.planItem}>
              <View style={{ height: 21, justifyContent: 'center' }}>
                <Icon icon={icon} size={16} color={color} />
              </View>
              <Text
                style={[
                  styles.planText,
                  {
                    color: item.status === 'completed' ? c.textTertiary : c.text,
                    fontWeight: item.status === 'in_progress' ? '600' : '400',
                    textDecorationLine: item.status === 'completed' ? 'line-through' : 'none',
                  },
                ]}
              >
                {item.content}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function Notice(props: { entry: Of<'notice'> }) {
  const { c, s } = useSessionTokens()
  const { entry } = props
  const tone =
    entry.severity === 'error'
      ? { icon: G.error, color: c.danger, bg: s.dangerSoft }
      : entry.severity === 'warning'
        ? { icon: G.warning, color: c.warning, bg: s.warningSoft }
        : { icon: G.info, color: c.textSecondary, bg: c.fill }
  return (
    <View style={[styles.notice, { backgroundColor: tone.bg }]}>
      <View style={{ height: 20, justifyContent: 'center' }}>
        <Icon icon={tone.icon} size={15} color={tone.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={[styles.noticeTitle, { color: entry.severity === 'info' ? c.text : tone.color }]}
        >
          {entry.title}
        </Text>
        {entry.description ? (
          <Text style={[styles.noticeText, { color: c.textSecondary }]}>{entry.description}</Text>
        ) : null}
      </View>
    </View>
  )
}

/** A small line of the host's own record, with an icon and, when it leads somewhere, a chevron. */
function Note(props: {
  icon: IconSpec
  text: string
  detail?: string
  onPress?: () => void
  busy?: boolean
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={props.onPress}
      disabled={!props.onPress}
      style={({ pressed }) => [styles.quiet, { opacity: pressed ? 0.55 : 1 }]}
    >
      <Icon icon={props.icon} size={14} color={c.textTertiary} />
      <Text style={[styles.quietText, { color: c.textSecondary, flexShrink: 1 }]} numberOfLines={1}>
        {props.text}
        {props.detail ? <Text style={{ color: c.textTertiary }}> {props.detail}</Text> : null}
        {props.busy ? '…' : ''}
      </Text>
      {props.onPress && <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />}
    </Pressable>
  )
}

function Compaction(props: { entry: Of<'compaction'> }) {
  const { c } = useSessionTokens()
  const busy = props.entry.status === 'in_progress'
  const text =
    props.entry.status === 'failed'
      ? '整理上下文失败'
      : props.entry.status === 'cancelled'
        ? '整理上下文已取消'
        : busy
          ? '正在整理上下文…'
          : '上下文已整理'
  return (
    <View style={styles.divider}>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <Icon icon={G.compact} size={13} color={c.textTertiary} />
      <Text style={[styles.dividerText, { color: c.textTertiary }]}>{text}</Text>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
    </View>
  )
}

export const EntryView = memo(function EntryView(props: { entry: ThreadEntry }) {
  const { entry } = props
  switch (entry.kind) {
    case 'user':
      if (entry.approval) return null
      return (
        <UserMessage
          content={entry.content}
          {...(entry.steered ? { steered: true } : {})}
          {...(entry.device ? { device: entry.device } : {})}
          {...(entry.from ? { from: entry.from } : {})}
        />
      )
    case 'agent':
      return <Reply entry={entry} />
    case 'thought':
      return <Thought entry={entry} />
    case 'tool':
      return <ToolRow entry={entry} />
    case 'plan':
      return <Plan entry={entry} />
    case 'notice':
      return <Notice entry={entry} />
    case 'compaction':
      return <Compaction entry={entry} />
    case 'subagent':
    case 'session_started':
      return (
        <Note
          icon={G.subagent}
          text="开了一个子会话"
          onPress={() => router.push(`/session/${entry.sessionId}`)}
        />
      )
    case 'git':
      if (entry.event === 'commit') {
        const count = entry.commits.length + entry.more
        return (
          <Note
            icon={G.commit}
            text={`提交了 ${count} 个 commit`}
            {...(entry.commits[0] ? { detail: entry.commits[0].subject } : {})}
          />
        )
      }
      if (entry.event === 'push') {
        return (
          <Note icon={G.push} text={`推送了 ${entry.count} 个 commit`} detail={entry.upstream} />
        )
      }
      if (entry.event === 'branch') {
        return <Note icon={G.branch} text="切换到分支" detail={entry.branch} />
      }
      return (
        <Note
          icon={G.pr}
          text="开了 Pull Request"
          onPress={() => void Linking.openURL(entry.url).catch(() => {})}
        />
      )
    case 'artifact':
      return <Note icon={G.artifact} text="Artifact" detail={entry.title} />
    default:
      return null
  }
})

// Room above and below each kind of entry: replies breathe, tool lines sit close together.
const SPACING: Partial<Record<ThreadEntry['kind'], [number, number]>> = {
  user: [10, 10],
  agent: [8, 8],
  plan: [6, 6],
  notice: [6, 6],
  compaction: [8, 8],
}

/** A row of the conversation list, which redraws only when its own data changed. */
export const ThreadRow = memo(
  function ThreadRow(props: { row: Row }) {
    const { row } = props
    if (row.type === 'changes') {
      return (
        <View style={{ paddingTop: 8, paddingBottom: 4 }}>
          <TurnChanges tools={row.tools} />
        </View>
      )
    }
    if (row.type === 'footer') {
      return (
        <View style={{ paddingBottom: 22 }}>
          <TurnFooter end={row.end} endedAt={row.endedAt} replies={row.replies} />
        </View>
      )
    }
    const { entry } = row
    if (
      (entry.kind === 'user' && entry.approval) ||
      (entry.kind === 'agent' && !entry.markdown && !entry.streaming)
    ) {
      return null
    }
    const [top, bottom] = SPACING[entry.kind] ?? [3, 3]
    return (
      <View style={{ paddingTop: top, paddingBottom: bottom }}>
        <EntryView entry={entry} />
      </View>
    )
  },
  (a, b) => sameRow(a.row, b.row),
)

const styles = StyleSheet.create({
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 28,
    alignSelf: 'flex-start',
  },
  quietText: { fontSize: 14, lineHeight: 19 },
  thoughtBody: {
    borderLeftWidth: 2,
    paddingLeft: 12,
    marginLeft: 6,
    marginTop: 4,
    marginBottom: 4,
  },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  cardTitle: { fontSize: 15, fontWeight: '600', flex: 1 },
  count: { fontSize: 13, fontVariant: ['tabular-nums'] },
  planItem: { flexDirection: 'row', gap: 10 },
  planText: { flex: 1, fontSize: 15, lineHeight: 21 },
  notice: {
    flexDirection: 'row',
    gap: 9,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noticeTitle: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  noticeText: { fontSize: 13, lineHeight: 18 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12 },
})

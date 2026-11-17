// One entry of a session's thread, as compact as a phone wants: the conversation in full, tools as
// a line that opens to their input and output, and the host's own records as a short note.

import { useMemo, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { ThreadEntry, ToolEntry, UserContent } from '@shared/thread'
import { diffTexts, handDiff, type ToolDiff } from '../diff'
import { duration } from '../sessions'
import type { Theme } from '../theme'
import { Markdown } from './Markdown'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

const TOOL_VERBS: Record<ToolEntry['toolKind'], string> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  search: '搜索',
  execute: '运行',
  think: '思考',
  fetch: '获取',
  switch_mode: '切换模式',
  other: '工具',
}

function contentText(content: UserContent[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      const ref = part.ref
      switch (ref.kind) {
        case 'image':
          return '［图片］'
        case 'attachment':
          return `［${ref.attachment.name}］`
        case 'link':
          return `［${ref.name}］`
        case 'audio':
          return '［音频］'
        case 'video':
          return '［视频］'
        default:
          return `［${ref.label}］`
      }
    })
    .join('\n')
}

function toolStatus(entry: ToolEntry, theme: Theme): { mark: string; color: string } {
  if (entry.permission && !entry.permissionResult) return { mark: '等你', color: theme.warn }
  switch (entry.status) {
    case 'completed':
      return { mark: '✓', color: theme.ok }
    case 'failed':
      return { mark: '✗', color: theme.danger }
    case 'cancelled':
      return { mark: '已取消', color: theme.muted }
    default:
      return { mark: '…', color: theme.muted }
  }
}

function answerText(entry: ToolEntry): string | null {
  const result = entry.permissionResult
  if (!result) return null
  if (result === 'cancelled') return '请求已取消'
  if (result === 'withdrawn') return '请求已撤回'
  const verb = result.kind.startsWith('allow') ? '已允许' : '已拒绝'
  const where = result.device ? `（在 ${result.device.name} 上）` : ''
  if (result.questions?.length) return `已回答${where}`
  return `${verb}${result.name ? `：${result.name}` : ''}${where}`
}

function DiffChip(props: { part: ToolDiff; theme: Theme }) {
  const { part, theme } = props
  const stats = useMemo(() => diffTexts(part.oldText, part.newText), [part])
  const open = () =>
    router.push({
      pathname: '/diff',
      params: { key: handDiff({ path: part.path, oldText: part.oldText, newText: part.newText, diff: stats }) },
    })
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      style={({ pressed }) => [styles.diff, { borderColor: theme.line, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ flex: 1, color: theme.text, fontSize: 12 }} numberOfLines={1} ellipsizeMode="head">
        {part.oldText === null ? '新建 ' : '改动 '}
        {part.path}
      </Text>
      <Text style={{ fontSize: 12, fontVariant: ['tabular-nums'] }}>
        <Text style={{ color: theme.ok }}>+{stats.insertions}</Text>{' '}
        <Text style={{ color: theme.danger }}>−{stats.deletions}</Text>
      </Text>
      <Text style={{ color: theme.muted, fontSize: 14 }}>›</Text>
    </Pressable>
  )
}

function Tool(props: { entry: ToolEntry; theme: Theme }) {
  const { entry, theme } = props
  const [open, setOpen] = useState(false)
  const status = toolStatus(entry, theme)
  const target = entry.rawInput && entry.toolKind === 'execute' ? entry.rawInput : entry.title
  const answer = answerText(entry)
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={[styles.tool, { borderColor: theme.line }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: theme.muted, fontSize: 13 }}>{TOOL_VERBS[entry.toolKind]}</Text>
        <Text
          style={{ flex: 1, color: theme.text, fontSize: 13, fontFamily: entry.toolKind === 'execute' ? MONO : undefined }}
          numberOfLines={open ? undefined : 1}
        >
          {target}
        </Text>
        <Text style={{ color: status.color, fontSize: 13 }}>{status.mark}</Text>
      </View>
      {answer && <Text style={{ color: theme.muted, fontSize: 12, marginTop: 4 }}>{answer}</Text>}
      {open &&
        entry.content.map((part, i) =>
          part.type === 'markdown' ? (
            <Text key={i} selectable style={[styles.output, { color: theme.text, backgroundColor: theme.line }]}>
              {part.markdown.length > 4000 ? `${part.markdown.slice(0, 4000)}\n…` : part.markdown}
            </Text>
          ) : part.type === 'diff' ? (
            <DiffChip key={i} part={part} theme={theme} />
          ) : null,
        )}
    </Pressable>
  )
}

export function EntryView(props: { entry: ThreadEntry; theme: Theme }) {
  const { entry, theme } = props
  const [thoughtOpen, setThoughtOpen] = useState(false)
  switch (entry.kind) {
    case 'user':
      if (entry.approval) return null
      return (
        <View style={[styles.user, { backgroundColor: theme.accent }]}>
          <Text selectable style={{ color: theme.accentText, fontSize: 15, lineHeight: 21 }}>
            {contentText(entry.content)}
          </Text>
        </View>
      )
    case 'agent':
      return (
        <View style={styles.agent}>
          <Markdown markdown={entry.markdown || (entry.streaming ? '…' : '')} theme={theme} />
        </View>
      )
    case 'thought':
      return (
        <Pressable onPress={() => setThoughtOpen((v) => !v)} style={styles.note}>
          <Text style={{ color: theme.muted, fontSize: 13, fontStyle: 'italic' }} numberOfLines={thoughtOpen ? undefined : 2}>
            {entry.streaming ? '思考中… ' : '思考：'}
            {entry.markdown}
          </Text>
        </Pressable>
      )
    case 'tool':
      return <Tool entry={entry} theme={theme} />
    case 'plan':
      return (
        <View style={[styles.plan, { borderColor: theme.line }]}>
          <Text style={{ color: theme.text, fontWeight: '700', marginBottom: 6 }}>计划</Text>
          {entry.items.map((item, i) => (
            <Text key={i} style={{ color: item.status === 'completed' ? theme.muted : theme.text, fontSize: 14, lineHeight: 21 }}>
              {item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '▶' : '☐'} {item.content}
            </Text>
          ))}
        </View>
      )
    case 'notice': {
      const color = entry.severity === 'error' ? theme.danger : entry.severity === 'warning' ? theme.warn : theme.muted
      return (
        <View style={[styles.notice, { borderColor: color }]}>
          <Text style={{ color, fontWeight: '600' }}>{entry.title}</Text>
          {entry.description ? <Text style={{ color: theme.muted, marginTop: 2 }}>{entry.description}</Text> : null}
        </View>
      )
    }
    case 'turn_end':
      return (
        <Text style={[styles.divider, { color: theme.muted }]}>
          {entry.stopReason === 'cancelled' ? '已停止' : '本轮结束'} · {duration(entry.durationMs)}
        </Text>
      )
    case 'compaction':
      return <Text style={[styles.divider, { color: theme.muted }]}>整理上下文{entry.status === 'in_progress' ? '中…' : ''}</Text>
    case 'subagent':
    case 'session_started':
      return <Text style={[styles.divider, { color: theme.muted }]}>开了一个子会话</Text>
    case 'git':
      return (
        <Text style={[styles.divider, { color: theme.muted }]}>
          {entry.event === 'commit'
            ? `提交了 ${entry.commits.length + entry.more} 个 commit`
            : entry.event === 'push'
              ? `推送了 ${entry.count} 个 commit`
              : entry.event === 'branch'
                ? `切换到分支 ${entry.branch}`
                : '开了 Pull Request'}
        </Text>
      )
    case 'artifact':
      return <Text style={[styles.divider, { color: theme.muted }]}>Artifact：{entry.title}</Text>
    default:
      return null
  }
}

const styles = StyleSheet.create({
  user: { alignSelf: 'flex-end', maxWidth: '85%', borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  agent: { paddingVertical: 2 },
  note: { paddingVertical: 2 },
  tool: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  output: { fontFamily: MONO, fontSize: 12, borderRadius: 6, padding: 8, marginTop: 6 },
  diff: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, marginTop: 6 },
  plan: { borderWidth: 1, borderRadius: 10, padding: 10 },
  notice: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4 },
  divider: { textAlign: 'center', fontSize: 12, paddingVertical: 4 },
})

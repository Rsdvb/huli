// A tool call as one quiet line: an icon for its kind, what it did, and how it went; tapped, it
// opens to its command, its output and its edits.

import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { ToolEntry } from '@shared/thread'
import { handDiff } from '../../diff'
import { useSessionRows } from './context'
import { baseName, relativePath } from './format'
import { FileMark, G, Icon, TOOL_ICONS } from './icons'
import { MONO, useSessionTokens } from './palette'
import { gentle } from './Press'
import { Counts } from './TurnChanges'
import { toolEdits, type FileEdit } from './turns'

const VERBS: Record<ToolEntry['toolKind'], string> = {
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

const OUTPUT_CHARS = 4000

function answerText(entry: ToolEntry): string | null {
  const result = entry.permissionResult
  if (!result) return null
  if (result === 'cancelled') return '请求已取消'
  if (result === 'withdrawn') return '请求已撤回'
  const verb = result.kind.startsWith('allow') ? '已允许' : '已拒绝'
  const where = result.device ? `（在 ${result.device.name} 上）` : ''
  if (result.questions?.length) return `已回答${where}`
  return `${verb}${result.name ? `：${result.name.replace(/`/g, '')}` : ''}${where}`
}

/** What the line names: the command for a shell call, else the agent's title for the call. */
function target(entry: ToolEntry, root: string | null): string {
  if (entry.toolKind === 'execute' && entry.rawInput) return entry.rawInput.split('\n')[0]!
  const location = entry.locations[0]?.path
  if (
    location &&
    (entry.toolKind === 'read' || entry.toolKind === 'edit' || entry.toolKind === 'delete')
  ) {
    const shown = relativePath(location, root)
    return shown === location ? baseName(location) : shown
  }
  return entry.title
}

function EditLine(props: { edit: FileEdit; root: string | null }) {
  const { c } = useSessionTokens()
  const { edit } = props
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/diff',
          params: {
            key: handDiff({
              path: edit.path,
              oldText: edit.oldText,
              newText: edit.newText,
              diff: edit.diff,
            }),
          },
        })
      }
      accessibilityRole="button"
      style={({ pressed }) => [styles.edit, { backgroundColor: pressed ? c.fillStrong : c.fill }]}
    >
      <FileMark path={edit.path} size={13} />
      <Text style={[styles.editPath, { color: c.text }]} numberOfLines={1} ellipsizeMode="head">
        {edit.oldText === null ? '新建 ' : ''}
        {relativePath(edit.path, props.root)}
      </Text>
      <Counts insertions={edit.diff.insertions} deletions={edit.diff.deletions} size={12} />
      <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
    </Pressable>
  )
}

export const ToolRow = memo(function ToolRow(props: { entry: ToolEntry }) {
  const { c, s } = useSessionTokens()
  const { root } = useSessionRows()
  const { entry } = props
  const [open, setOpen] = useState(false)
  const waiting = !!entry.permission && !entry.permissionResult
  const running = entry.status === 'pending' || entry.status === 'in_progress'
  const editsOf = toolEdits(entry)
  const totals = editsOf.reduce(
    (sum, e) => ({
      insertions: sum.insertions + e.diff.insertions,
      deletions: sum.deletions + e.diff.deletions,
    }),
    { insertions: 0, deletions: 0 },
  )
  const answer = answerText(entry)
  const outputs = entry.content.flatMap((part) =>
    part.type === 'markdown' && part.markdown.trim() ? [part.markdown] : [],
  )
  const shell = entry.toolKind === 'execute'
  const toggle = () => {
    gentle()
    setOpen((v) => !v)
  }

  return (
    <View>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={[styles.badge, { backgroundColor: c.fill }]}>
          <Icon icon={TOOL_ICONS[entry.toolKind]} size={13} color={c.textSecondary} />
        </View>
        <Text style={[styles.verb, { color: c.textSecondary }]}>{VERBS[entry.toolKind]}</Text>
        <Text
          style={[styles.target, { color: c.text }, shell && { fontFamily: MONO, fontSize: 13 }]}
          numberOfLines={1}
          ellipsizeMode={shell ? 'tail' : 'head'}
        >
          {target(entry, root)}
        </Text>
        {editsOf.length > 0 && (
          <Counts insertions={totals.insertions} deletions={totals.deletions} size={12} />
        )}
        {waiting ? (
          <Text style={[styles.pill, { color: c.warning, backgroundColor: s.warningSoft }]}>
            等你
          </Text>
        ) : running ? (
          <ActivityIndicator
            size="small"
            color={c.textTertiary}
            style={{ transform: [{ scale: 0.75 }] }}
          />
        ) : entry.status === 'failed' ? (
          <Icon icon={G.failed} size={14} color={c.danger} />
        ) : entry.status === 'cancelled' ? (
          <Text style={[styles.status, { color: c.textTertiary }]}>已取消</Text>
        ) : null}
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
        </View>
      </Pressable>
      {answer && !open && (
        <Text style={[styles.answer, { color: c.textTertiary }]} numberOfLines={1}>
          {answer}
        </Text>
      )}
      {open && (
        <View style={styles.body}>
          {entry.description ? (
            <Text style={[styles.description, { color: c.textSecondary }]}>
              {entry.description}
            </Text>
          ) : null}
          {answer && <Text style={[styles.description, { color: c.textSecondary }]}>{answer}</Text>}
          {entry.rawInput ? (
            <View style={[styles.block, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
              <Text selectable style={[styles.mono, { color: c.text }]}>
                {shell ? `$ ${entry.rawInput}` : entry.rawInput.slice(0, OUTPUT_CHARS)}
              </Text>
            </View>
          ) : !shell && entry.title !== target(entry, root) ? (
            <Text style={[styles.description, { color: c.textSecondary }]}>{entry.title}</Text>
          ) : null}
          {outputs.map((output, i) => (
            <View
              key={i}
              style={[styles.block, { backgroundColor: s.code, borderColor: s.codeBorder }]}
            >
              <Text selectable style={[styles.mono, { color: c.textSecondary }]}>
                {output.length > OUTPUT_CHARS ? `${output.slice(0, OUTPUT_CHARS)}\n…` : output}
              </Text>
            </View>
          ))}
          {editsOf.map((edit, i) => (
            <EditLine key={i} edit={edit} root={root} />
          ))}
          {!entry.rawInput &&
            outputs.length === 0 &&
            editsOf.length === 0 &&
            !entry.description && (
              <Text style={[styles.description, { color: c.textTertiary }]}>没有输出</Text>
            )}
        </View>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  badge: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  verb: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  target: { flex: 1, fontSize: 14, lineHeight: 19 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  status: { fontSize: 12 },
  answer: { fontSize: 12, lineHeight: 16, marginLeft: 32, marginTop: -2 },
  body: { marginLeft: 32, marginTop: 4, marginBottom: 4, gap: 6 },
  description: { fontSize: 13, lineHeight: 18 },
  block: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  edit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 36,
  },
  editPath: { flex: 1, fontSize: 13 },
})

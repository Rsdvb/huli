// A turn's edits as one card: how many files and lines it changed, and a row per file that opens
// to a preview of its change or, tapped, to the whole diff.

import { memo, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { ToolEntry } from '@shared/thread'
import { handDiff } from '../../diff'
import { useSessionRows } from './context'
import { relativePath } from './format'
import { FileMark, G, Icon } from './icons'
import { MONO, useSessionTokens } from './palette'
import { gentle } from './Press'
import { fileChanges, mergedDiff, type FileChange } from './turns'

const PREVIEW_ROWS = 14

export function Counts(props: { insertions: number; deletions: number; size?: number }) {
  const { c } = useSessionTokens()
  const style = {
    fontFamily: MONO,
    fontSize: props.size ?? 13,
    fontVariant: ['tabular-nums' as const],
  }
  return (
    <Text style={style}>
      {props.insertions > 0 || props.deletions === 0 ? (
        <Text style={{ color: c.added }}>+{props.insertions}</Text>
      ) : null}
      {props.insertions > 0 && props.deletions > 0 ? ' ' : ''}
      {props.deletions > 0 ? <Text style={{ color: c.removed }}>−{props.deletions}</Text> : null}
    </Text>
  )
}

function openChange(change: FileChange) {
  const diff = mergedDiff(change)
  const first = change.edits[0]!
  const last = change.edits[change.edits.length - 1]!
  router.push({
    pathname: '/diff',
    params: {
      key: handDiff({ path: change.path, oldText: first.oldText, newText: last.newText, diff }),
    },
  })
}

function Preview(props: { change: FileChange }) {
  const { c } = useSessionTokens()
  const diff = useMemo(() => mergedDiff(props.change), [props.change])
  const rows = diff.rows.slice(0, PREVIEW_ROWS)
  const more = diff.rows.length - rows.length
  return (
    <Pressable
      onPress={() => openChange(props.change)}
      style={[styles.preview, { backgroundColor: c.fill }]}
    >
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <Text key={i} style={[styles.line, { color: c.textTertiary }]} numberOfLines={1}>
            {row.text}
          </Text>
        ) : (
          <Text
            key={i}
            numberOfLines={1}
            style={[
              styles.line,
              {
                color:
                  row.kind === 'add' ? c.added : row.kind === 'del' ? c.removed : c.textSecondary,
                backgroundColor:
                  row.kind === 'add' ? c.addedBg : row.kind === 'del' ? c.removedBg : 'transparent',
              },
            ]}
          >
            {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
            {row.text}
          </Text>
        ),
      )}
      <Text style={[styles.more, { color: c.tint }]}>
        {more > 0 ? `查看完整改动（还有 ${more} 行）` : '查看完整改动'}
      </Text>
    </Pressable>
  )
}

function FileRow(props: { change: FileChange; root: string | null; first: boolean }) {
  const { c } = useSessionTokens()
  const [open, setOpen] = useState(false)
  const { change } = props
  const toggle = () => {
    gentle()
    setOpen((v) => !v)
  }
  return (
    <View
      style={
        !props.first ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border } : null
      }
    >
      <Pressable
        onPress={() => openChange(change)}
        accessibilityRole="button"
        accessibilityLabel={`${change.path}，增加 ${change.insertions} 行，删除 ${change.deletions} 行`}
        style={({ pressed }) => [styles.file, pressed && { backgroundColor: c.fill }]}
      >
        <Pressable onPress={toggle} hitSlop={10} accessibilityLabel={open ? '收起' : '展开预览'}>
          <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
            <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
          </View>
        </Pressable>
        <FileMark path={change.path} size={15} />
        <Text style={[styles.path, { color: c.text }]} numberOfLines={1} ellipsizeMode="head">
          {relativePath(change.path, props.root)}
        </Text>
        {change.created && (
          <Text style={[styles.tag, { color: c.added, backgroundColor: c.addedBg }]}>新建</Text>
        )}
        <Counts insertions={change.insertions} deletions={change.deletions} />
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <Preview change={change} />
        </View>
      )}
    </View>
  )
}

export const TurnChanges = memo(function TurnChanges(props: { tools: ToolEntry[] }) {
  const { c, s } = useSessionTokens()
  const { root } = useSessionRows()
  const changes = useMemo(() => fileChanges(props.tools), [props.tools])
  if (changes.length === 0) return null
  const insertions = changes.reduce((n, ch) => n + ch.insertions, 0)
  const deletions = changes.reduce((n, ch) => n + ch.deletions, 0)
  return (
    <View style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.border }]}>
      <View style={[styles.head, { borderBottomColor: c.border }]}>
        <Text style={[styles.title, { color: c.text }]}>改动了 {changes.length} 个文件</Text>
        <Counts insertions={insertions} deletions={deletions} size={14} />
      </View>
      {changes.map((change, i) => (
        <FileRow key={change.path} change={change} root={root} first={i === 0} />
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 14,
    paddingRight: 16,
    minHeight: 46,
  },
  path: { flex: 1, fontSize: 14, lineHeight: 19 },
  tag: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
    overflow: 'hidden',
  },
  preview: { borderRadius: 10, paddingVertical: 8, overflow: 'hidden' },
  line: { fontFamily: MONO, fontSize: 11.5, lineHeight: 17, paddingHorizontal: 10 },
  more: { fontSize: 13, fontWeight: '500', paddingHorizontal: 10, paddingTop: 8 },
})

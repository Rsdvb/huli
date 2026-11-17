// One memory entry: its title, summary and text, who wrote it and when, and editing, moving a
// project's entry to global memory, and deleting it.

import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import type { MemoryEntry } from '@shared/memory'
import { Markdown } from '../../components/Markdown'
import { useHost } from '../../host'
import {
  Button,
  Buttons,
  call,
  confirm,
  ManagePage,
  ReadState,
  Tag,
  useActions,
  useConnected,
  useRead,
} from '../../manage/kit'
import { EntryEditor, memoryCall, scopeOf, useEntryLine } from '../../manage/memory'
import { EmptyState } from '../../ui/EmptyState'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'
import { ago } from '../../sessions'

export default function MemoryEntryPage() {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const params = useLocalSearchParams<{ scope?: string; id?: string }>()
  const scope = scopeOf(params.scope ?? 'global')
  const id = params.id ?? ''
  const read = useRead<MemoryEntry | 'gone'>(
    `${params.scope ?? 'global'}\n${id}`,
    (link) =>
      memoryCall(() => call(link, 'memory.list', { scope })).then(
        (list) => list.find((e) => e.id === id) ?? 'gone',
      ),
    ['memory.changed'],
  )
  const [editing, setEditing] = useState(false)
  const actions = useActions()
  const line = useEntryLine()
  const entry = read.value === 'gone' ? null : read.value
  const project = scope.layer === 'project' ? scope.project : null
  const projectName = project
    ? (host.projects.find((p) => p.path === project)?.name ?? project.split(/[\\/]/).pop())
    : null
  const session =
    entry?.source.sessionId != null ? host.sessions.get(entry.source.sessionId) : undefined

  const remove = async (target: MemoryEntry) => {
    const ok = await confirm({
      title: `删除“${target.title}”？`,
      message: '它会从纸鸢的记忆里删掉，Agent 之后不会再拿到它。',
      confirm: '删除',
    })
    if (!ok || !host.link) return
    const done = await actions.run(
      'remove',
      () => memoryCall(() => call(host.link!, 'memory.remove', { scope, id: target.id })),
      '没能删除',
    )
    if (done) router.back()
  }

  const move = async (target: MemoryEntry) => {
    if (!project || !host.link) return
    const ok = await confirm({
      title: '移到全局',
      message: '全局记忆每个会话都会用到。',
      confirm: '移到全局',
      destructive: false,
    })
    if (!ok) return
    const done = await actions.run(
      'move',
      () => memoryCall(() => call(host.link!, 'memory.moveToGlobal', { project, id: target.id })),
      '没能移动',
    )
    if (done) router.back()
  }

  return (
    <ManagePage
      title={entry?.title ?? '记忆'}
      onRefresh={read.reload}
      overlay={
        entry ? (
          <EntryEditor
            visible={editing}
            scope={scope}
            entry={entry}
            onClose={() => setEditing(false)}
            onSaved={() => void read.reload()}
          />
        ) : null
      }
    >
      {read.value === null ? (
        <ReadState read={read} what="这条记忆" icon="brain" rows={2} />
      ) : !entry ? (
        <EmptyState icon="brain" title="这条记忆已经不在了。" />
      ) : (
        <>
          <View style={styles.head}>
            <Text style={[typeScale.title, { color: c.text }]} selectable>
              {entry.title}
            </Text>
            <Text style={[typeScale.callout, { color: c.textSecondary }]} selectable>
              {entry.description}
            </Text>
            <View style={styles.meta}>
              {scope.layer === 'global' ? <Tag label="全局" tone="tint" /> : null}
              <Text style={[typeScale.footnote, { color: c.textTertiary }]}>{line(entry)}</Text>
            </View>
          </View>

          <View style={[styles.body, { backgroundColor: c.surface, borderColor: c.border }]}>
            {entry.body.trim() ? (
              <Markdown markdown={entry.body} />
            ) : (
              <Text style={[typeScale.footnote, { color: c.textTertiary }]}>只有标题和摘要。</Text>
            )}
          </View>

          <ListGroup>
            {projectName ? (
              <ListRow title="项目" icon="folder" plainIcon value={projectName} />
            ) : null}
            <ListRow
              title={`${ago(entry.createdAt)}写下`}
              icon="clock"
              plainIcon
              value={
                entry.updatedAt !== entry.createdAt ? `${ago(entry.updatedAt)}改过` : undefined
              }
            />
            {session ? (
              <ListRow
                title={`回到写它的会话：${session.title || '未命名会话'}`}
                icon="message"
                plainIcon
                chevron
                onPress={() =>
                  router.push({ pathname: '/session/[id]', params: { id: session.id } })
                }
              />
            ) : null}
          </ListGroup>

          <Buttons>
            <Button
              label="编辑"
              icon="pencil"
              disabled={!connected}
              onPress={() => setEditing(true)}
            />
            {project ? (
              <Button
                label="移到全局"
                busy={actions.busy('move')}
                disabled={!connected}
                onPress={() => void move(entry)}
              />
            ) : null}
            <Button
              label="删除…"
              tone="danger"
              icon="trash"
              busy={actions.busy('remove')}
              disabled={!connected}
              onPress={() => void remove(entry)}
            />
          </Buttons>
        </>
      )}
    </ManagePage>
  )
}

const styles = StyleSheet.create({
  head: { gap: space.sm, marginHorizontal: space.xs },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  body: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
  },
})

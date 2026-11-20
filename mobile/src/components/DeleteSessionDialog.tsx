// Deleting a session, as the desktop's dialog asks it: what its folder has uncommitted, the work
// deleting would stop and the sub-sessions that go with it, with 改为归档, which keeps them all.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SessionSummary } from '@shared/agent-host'
import { call } from '../git'
import { useAgent, useConnected, useMaybeLink, useSessions } from '../host'
import { LockLayer } from '../lock'
import { sessionTitle } from '../sessions'
import {
  descendantCount,
  hasLiveWorktree,
  stakeFolder,
  workItems,
  workLabel,
  type WorkItem,
} from '../sessionMenu'
import { Press } from '../ui/Press'
import { G, Icon } from '../ui/session/icons'
import { baseName } from '../ui/session/format'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

interface Stake {
  /** Null when the computer could not read the folder. */
  files: number | null
  work: WorkItem[]
}

export function DeleteSessionDialog(props: {
  summary: SessionSummary | null
  visible: boolean
  onClose(): void
  onDelete(): void
  onArchive(): void
}) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const connected = useConnected()
  const sessions = useSessions()
  const agent = useAgent(props.summary?.agentId)
  const { summary } = props
  const [stake, setStake] = useState<Stake | null>(null)
  const id = summary?.id ?? null
  const folder = summary ? stakeFolder(summary) : null

  useEffect(() => {
    setStake(null)
    if (!props.visible || !id || !link || !connected) return
    let live = true
    void Promise.all([
      folder
        ? call(link, 'git.changes', { projectPath: folder }).then(
            (files) => files.length,
            () => null,
          )
        : Promise.resolve(0),
      call(link, 'sessions.runningWork', { sessionIds: [id] }).then(
        ({ sessions }) => workItems(sessions),
        () => [],
      ),
    ]).then(([files, work]) => live && setStake({ files, work }))
    return () => {
      live = false
    }
  }, [props.visible, id, folder, link, connected])

  if (!summary) return null
  const title = sessionTitle(summary)
  const children = descendantCount(sessions, summary.id)
  const worktree = summary.worktree && hasLiveWorktree(summary) ? summary.worktree : null
  // An agent whose own copy goes with it, else one whose copy stays in its vendor's app.
  const removes = agent ? (agent.deletesCopy ?? agent.capabilities.deleteSession) : false
  const shared = !removes && agent?.sharesSignIn ? agent.harnessName : null
  const name = folder ? baseName(folder) : ''

  let stakeLine: string | null = null
  if (stake && folder) {
    if (stake.files === null) stakeLine = `纸鸢没能检查它的文件夹 ${name} 里有没有未提交的文件。`
    else if (worktree) {
      stakeLine =
        stake.files === 0
          ? `它在工作树 ${name}（分支 ${worktree.branch}）里工作。删除会话不会删掉工作树，除非你选择删除。`
          : `它的工作树 ${name}（分支 ${worktree.branch}）有 ${stake.files} 个未提交的文件。`
    } else if (stake.files > 0) stakeLine = `它的文件夹 ${name} 有 ${stake.files} 个未提交的文件。`
  }
  const body =
    (children > 0
      ? `对话、历史记录及其 ${children} 个子会话将无法恢复。归档会保留它们。`
      : '对话及其历史记录将无法恢复。归档会保留两者。') +
    (removes && agent
      ? ` 也会从 ${agent.harnessName} 自己的本地历史里删除，官方客户端和应用里不会再显示。`
      : '') +
    (shared ? ` ${shared} 自己保留的那份，纸鸢删不掉。` : '')
  const canArchive = summary.parentId === null && summary.archivedAt === null

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={[styles.backdrop, { backgroundColor: c.scrim }]}>
        <View style={[styles.card, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          <Text style={[typeScale.headline, { color: c.text }]}>删除“{title}”？</Text>
          {!stake && !connected ? (
            <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
              电脑没有连上，连上后才能删除。
            </Text>
          ) : !stake ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.textSecondary} />
            </View>
          ) : (
            <ScrollView style={styles.scroll} contentContainerStyle={{ gap: space.md }}>
              {stakeLine ? (
                <View style={[styles.note, { backgroundColor: c.fill }]}>
                  <Icon icon={G.branch} size={15} color={c.textSecondary} />
                  <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
                    {stakeLine}
                  </Text>
                </View>
              ) : null}
              {stake.work.length > 0 ? (
                <View style={{ gap: space.xs }}>
                  <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                    删除会停止以下内容：
                  </Text>
                  <WorkList items={stake.work} />
                </View>
              ) : null}
            </ScrollView>
          )}
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>{body}</Text>
          <View style={styles.buttons}>
            <Press
              onPress={props.onDelete}
              disabled={!stake}
              accessibilityRole="button"
              style={[styles.button, { backgroundColor: c.danger, opacity: stake ? 1 : 0.5 }]}
            >
              <Text style={[typeScale.body, { color: c.onAccent, fontWeight: '600' }]}>删除</Text>
            </Press>
            {canArchive ? (
              <Press
                onPress={props.onArchive}
                accessibilityRole="button"
                style={[styles.button, { backgroundColor: c.fill }]}
              >
                <Text style={[typeScale.body, { color: c.text }]}>改为归档</Text>
              </Press>
            ) : null}
            <Press
              onPress={props.onClose}
              accessibilityRole="button"
              style={[styles.button, { backgroundColor: c.fill }]}
            >
              <Text style={[typeScale.body, { color: c.text }]}>取消</Text>
            </Press>
          </View>
        </View>
      </View>
      <LockLayer />
    </Modal>
  )
}

/** What a confirmation says will stop, one row each. */
export function WorkList(props: { items: WorkItem[] }) {
  const { c } = useTokens()
  return (
    <View>
      {props.items.map((item) => (
        <View key={item.key} style={[styles.work, { borderBottomColor: c.border }]}>
          {item.kind === 'turn' ? (
            <ActivityIndicator size="small" color={c.textTertiary} />
          ) : (
            <Icon
              icon={
                item.kind === 'command'
                  ? G.terminal
                  : item.kind === 'subagent'
                    ? G.subagent
                    : G.info
              }
              size={14}
              color={c.textSecondary}
            />
          )}
          <Text style={[typeScale.subhead, styles.flex, { color: c.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={[typeScale.caption, { color: c.textTertiary }]}>{workLabel(item)}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'center', padding: space.xxl },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    gap: space.md,
    maxHeight: '80%',
  },
  loading: { paddingVertical: space.lg, alignItems: 'center' },
  scroll: { flexGrow: 0 },
  note: {
    flexDirection: 'row',
    gap: space.sm,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  work: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  buttons: { gap: space.sm, marginTop: space.xs },
  button: { height: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})

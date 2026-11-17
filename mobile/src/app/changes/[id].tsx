// The files changed in the folder a session works in, its worktree's or its project's, as the
// computer's git sees them now; a file opens to its diff.

import { useMemo, type ReactElement } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { ChangeStatus, ChangedFile, GitStatus } from '@shared/git'
import { sessionFolder, useChanges } from '../../git'
import { useHost, useLink } from '../../host'
import { baseName, dirName } from '../../ui/session/format'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { FileMark, G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { StateView } from '../../ui/session/StateView'
import { Counts } from '../../ui/session/TurnChanges'

type Tone = 'added' | 'changed' | 'moved' | 'removed'

const STATUS: Record<ChangeStatus, { mark: string; label: string; tone: Tone }> = {
  added: { mark: 'A', label: '新增', tone: 'added' },
  untracked: { mark: 'U', label: '新文件', tone: 'added' },
  modified: { mark: 'M', label: '修改', tone: 'changed' },
  typechange: { mark: 'T', label: '类型改变', tone: 'changed' },
  renamed: { mark: 'R', label: '重命名', tone: 'moved' },
  copied: { mark: 'C', label: '复制', tone: 'moved' },
  deleted: { mark: 'D', label: '删除', tone: 'removed' },
  conflicted: { mark: '!', label: '冲突', tone: 'removed' },
}

function branchText(status: GitStatus): string {
  if (status.head.branch) return status.head.branch
  if (status.head.detached && status.head.oid) return `分离于 ${status.head.oid.slice(0, 7)}`
  return '还没有提交'
}

function FileRow(props: { file: ChangedFile; first: boolean; last: boolean; onPress(): void }) {
  const { c, s } = useSessionTokens()
  const { file } = props
  const status = STATUS[file.status]
  const tone = {
    added: { color: c.added, bg: c.addedBg },
    changed: { color: c.warning, bg: s.warningSoft },
    moved: { color: c.tint, bg: c.tintSoft },
    removed: { color: c.removed, bg: c.removedBg },
  }[status.tone]
  const dir = dirName(file.path)
  const counted = file.insertions !== null && file.deletions !== null
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${status.label} ${file.path}`}
      style={({ pressed }) => [
        styles.file,
        {
          backgroundColor: pressed ? c.fill : s.dockCard,
          borderTopLeftRadius: props.first ? 16 : 0,
          borderTopRightRadius: props.first ? 16 : 0,
          borderBottomLeftRadius: props.last ? 16 : 0,
          borderBottomRightRadius: props.last ? 16 : 0,
        },
      ]}
    >
      <FileMark path={file.path} size={17} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={[
            styles.name,
            {
              color: c.text,
              textDecorationLine: file.status === 'deleted' ? 'line-through' : 'none',
            },
          ]}
          numberOfLines={1}
        >
          {baseName(file.path)}
        </Text>
        {dir || file.oldPath ? (
          <Text
            style={[styles.dir, { color: c.textTertiary }]}
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {dir}
          </Text>
        ) : null}
      </View>
      {counted && (file.insertions || file.deletions) ? (
        <Counts insertions={file.insertions!} deletions={file.deletions!} />
      ) : null}
      <View style={[styles.mark, { backgroundColor: tone.bg }]}>
        <Text style={[styles.markText, { color: tone.color }]}>{status.mark}</Text>
      </View>
      <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
    </Pressable>
  )
}

export default function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const summary = host.sessions.get(id)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const changes = useChanges(link, folder)
  const { status, files, error } = changes
  const connected = host.state.kind === 'connected'

  const totals = useMemo(() => {
    let insertions = 0
    let deletions = 0
    for (const file of files ?? []) {
      insertions += file.insertions ?? 0
      deletions += file.deletions ?? 0
    }
    return { insertions, deletions }
  }, [files])

  const open = (file: ChangedFile) =>
    router.push({
      pathname: '/diff',
      params: { id, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) },
    })

  let body: ReactElement
  if (!summary) {
    body =
      connected && host.sessions.size > 0 ? (
        <StateView text="找不到这个会话。" />
      ) : (
        <StateView loading />
      )
  } else if (summary.scratch) {
    body = <StateView text="这个会话没有项目，没有可看的改动。" />
  } else if (!status || !files) {
    body = error ? (
      <StateView text={error} tone="danger" retry={changes.reload} />
    ) : (
      <StateView loading />
    )
  } else if (!status.repo) {
    body = <StateView text="这个文件夹不是 git 仓库。" icon={G.folder} />
  } else {
    body = (
      <FlatList
        data={files}
        keyExtractor={(file) => file.path}
        renderItem={({ item, index }) => (
          <FileRow
            file={item}
            first={index === 0}
            last={index === files.length - 1}
            onPress={() => open(item)}
          />
        )}
        ItemSeparatorComponent={() => (
          <View style={{ backgroundColor: s.dockCard }}>
            <View style={[styles.separator, { backgroundColor: c.border }]} />
          </View>
        )}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={changes.reload}
            tintColor={c.textSecondary}
          />
        }
        ListHeaderComponent={
          <View style={styles.summary}>
            <View style={styles.branch}>
              <Icon icon={G.branch} size={15} color={c.textSecondary} />
              <Text style={[styles.branchText, { color: c.text }]} numberOfLines={1}>
                {branchText(status)}
              </Text>
            </View>
            {files.length > 0 ? (
              <View style={styles.totals}>
                <Text style={[styles.total, { color: c.textSecondary }]}>
                  {files.length} 个文件
                </Text>
                <Counts insertions={totals.insertions} deletions={totals.deletions} />
                {status.stale ? (
                  <Text style={[styles.total, { color: c.textTertiary }]}>· 可能不是最新</Text>
                ) : null}
              </View>
            ) : null}
            {error ? <Text style={[styles.total, { color: c.danger }]}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon icon={G.done} size={28} color={c.success} />
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>没有未提交的改动</Text>
          </View>
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title="改动"
        subtitle={
          summary && !summary.scratch
            ? `${baseName(summary.projectPath)}${summary.worktree ? ' · 工作树' : ''}`
            : null
        }
      />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  summary: { paddingHorizontal: 4, paddingTop: 8, paddingBottom: 14, gap: 6 },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  branchText: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  totals: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  total: { fontSize: 13 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    minHeight: 58,
  },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  dir: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  mark: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  markText: { fontSize: 11, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  empty: { alignItems: 'center', gap: 10, paddingTop: 64 },
  emptyText: { fontSize: 15 },
})

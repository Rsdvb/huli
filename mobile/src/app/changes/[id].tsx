// The files changed in the folder a session works in, its worktree's or its project's, as the
// computer's git sees them now; a file opens to its diff.

import { useMemo, type ReactElement } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { ChangeStatus, ChangedFile, GitStatus } from '@shared/git'
import { Loading, Message } from '../../components/Placeholder'
import { sessionFolder, useChanges } from '../../git'
import { useHost, useLink } from '../../host'
import { folder as baseName } from '../../sessions'
import { useTheme, type Theme } from '../../theme'

const STATUS: Record<
  ChangeStatus,
  { mark: string; label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }
> = {
  added: { mark: 'A', label: '新增', tone: 'ok' },
  untracked: { mark: 'U', label: '新文件', tone: 'ok' },
  modified: { mark: 'M', label: '修改', tone: 'warn' },
  typechange: { mark: 'T', label: '类型改变', tone: 'warn' },
  renamed: { mark: 'R', label: '重命名', tone: 'muted' },
  copied: { mark: 'C', label: '复制', tone: 'muted' },
  deleted: { mark: 'D', label: '删除', tone: 'danger' },
  conflicted: { mark: '!', label: '冲突', tone: 'danger' },
}

function toneColor(tone: (typeof STATUS)[ChangeStatus]['tone'], theme: Theme): string {
  return tone === 'ok'
    ? theme.ok
    : tone === 'warn'
      ? theme.warn
      : tone === 'danger'
        ? theme.danger
        : theme.muted
}

function dirName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}

function branchText(status: GitStatus): string {
  if (status.head.branch) return status.head.branch
  if (status.head.detached && status.head.oid) return `分离于 ${status.head.oid.slice(0, 7)}`
  return '还没有提交'
}

function FileRow(props: { file: ChangedFile; theme: Theme; onPress(): void }) {
  const { file, theme, onPress } = props
  const status = STATUS[file.status]
  const color = toneColor(status.tone, theme)
  const dir = dirName(file.path)
  const counted = file.insertions !== null && file.deletions !== null
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${status.label} ${file.path}`}
      style={({ pressed }) => [styles.file, { backgroundColor: pressed ? theme.line : theme.card }]}
    >
      <View style={[styles.mark, { borderColor: color }]}>
        <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{status.mark}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            color: theme.text,
            fontSize: 15,
            textDecorationLine: file.status === 'deleted' ? 'line-through' : 'none',
          }}
          numberOfLines={1}
        >
          {baseName(file.path)}
        </Text>
        {dir || file.oldPath ? (
          <Text
            style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {dir}
          </Text>
        ) : null}
      </View>
      {counted ? (
        <Text style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>
          {file.insertions ? <Text style={{ color: theme.ok }}>+{file.insertions} </Text> : null}
          {file.deletions ? <Text style={{ color: theme.danger }}>−{file.deletions}</Text> : null}
        </Text>
      ) : (
        <Text style={{ color: theme.muted, fontSize: 12 }}>{status.label}</Text>
      )}
      <Text style={{ color: theme.muted, fontSize: 18, marginLeft: 2 }}>›</Text>
    </Pressable>
  )
}

export default function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const theme = useTheme()
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
        <Message text="找不到这个会话。" theme={theme} />
      ) : (
        <Loading theme={theme} />
      )
  } else if (summary.scratch) {
    body = <Message text="这个会话没有项目，没有可看的改动。" theme={theme} />
  } else if (!status || !files) {
    body = error ? (
      <Message text={error} theme={theme} color={theme.danger} retry={changes.reload} />
    ) : (
      <Loading theme={theme} />
    )
  } else if (!status.repo) {
    body = <Message text="这个文件夹不是 git 仓库。" theme={theme} />
  } else {
    body = (
      <FlatList
        data={files}
        keyExtractor={(file) => file.path}
        renderItem={({ item }) => <FileRow file={item} theme={theme} onPress={() => open(item)} />}
        ItemSeparatorComponent={() => (
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />
        )}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={changes.reload} tintColor={theme.accent} />
        }
        ListHeaderComponent={
          <View style={styles.summary}>
            <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
              ⎇ {branchText(status)}
            </Text>
            <Text style={{ color: theme.muted, fontSize: 13, marginTop: 4 }}>
              {files.length > 0 ? `${files.length} 个文件 · ` : ''}
              {files.length > 0 ? (
                <>
                  <Text style={{ color: theme.ok }}>+{totals.insertions}</Text>{' '}
                  <Text style={{ color: theme.danger }}>−{totals.deletions}</Text>
                </>
              ) : (
                '没有未提交的改动'
              )}
              {status.stale ? ' · 可能不是最新' : ''}
            </Text>
            {error ? (
              <Text style={{ color: theme.danger, fontSize: 12, marginTop: 4 }}>{error}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.muted }]}>没有改动</Text>}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: 'center', maxWidth: 240 }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 16 }}>改动</Text>
              {summary && !summary.scratch ? (
                <Text style={{ color: theme.muted, fontSize: 11 }} numberOfLines={1}>
                  {baseName(summary.projectPath)}
                  {summary.worktree ? ' · 工作树' : ''}
                </Text>
              ) : null}
            </View>
          ),
        }}
      />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  summary: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  mark: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { textAlign: 'center', fontSize: 15, paddingTop: 48 },
})

// The git panel of the folder a session works in, its worktree's or its project's, as the desktop's
// branch popover and git dialogs offer it: the worktree, the branch with Pull and Push (or Publish),
// the commits a pull brings, the pull request, the uncommitted files with Commit and Discard, and
// the branch's commits. A file opens to its diff, a document in the system's viewer; the branch
// opens the branch picker.

import { useMemo, useState, type ReactElement } from 'react'
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { ChangedFile } from '@shared/git'
import {
  CommitSheet,
  CreatePrSheet,
  LogSheet,
  PublishBranchSheet,
  PublishRepoSheet,
} from '../../components/git/GitSheets'
import {
  CommitsPart,
  FileRow,
  FolderFooter,
  IncomingPart,
  PillButton,
  PrPart,
  Separator,
  SyncCard,
} from '../../components/git/GitParts'
import { useGitSteps } from '../../components/git/useGitSteps'
import { WorktreeCard } from '../../components/git/WorktreeCard'
import {
  call,
  sessionFolder,
  useChanges,
  useCurrentPr,
  useGitRunning,
  useGitTools,
} from '../../git'
import { hostErrorText } from '../../hostErrors'
import { opensInViewer } from '../../preview/kinds'
import { previewFile } from '../../preview/preview'
import { SHARE_LABEL } from '../../preview/PreviewSheet'
import { useConnected, useHasSessions, useLink, useProjects, useSession } from '../../host'
import { joinGroups, type MenuNode } from '../../ui/menu'
import { baseName } from '../../ui/session/format'
import { GI } from '../../ui/session/gitIcons'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { RoundButton } from '../../ui/session/Press'
import { StateView } from '../../ui/session/StateView'
import { usePullRefresh } from '../../ui/PullRefresh'
import { Counts } from '../../ui/session/TurnChanges'

export default function ChangesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  const hasSessions = useHasSessions()
  const link = useLink()
  const summary = useSession(id)
  const projectName = useProjects().find((p) => p.path === summary?.projectPath)?.name
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const changes = useChanges(link, folder)
  const { status, files, error } = changes
  const pull = usePullRefresh(changes.reload)
  const connected = useConnected()
  const tools = useGitTools(link, connected)
  const gh = tools?.gh.state ?? null
  const current = useCurrentPr(link, status?.repo ? status : null)
  const running = useGitRunning(folder)
  const steps = useGitSteps(link, folder, status, current.pr !== null)
  // Huli: a review of these changes by the session's agent, whose findings show on each diff.
  const [reviewing, setReviewing] = useState(false)
  const [reviewNote, setReviewNote] = useState<{ text: string; failed: boolean } | null>(null)
  const startReview = async () => {
    setReviewing(true)
    setReviewNote(null)
    try {
      await call(link, 'sessions.reviewStart', { sessionId: id })
      setReviewNote({ text: '已开始审查，发现的问题会标在各文件改动的行上。', failed: false })
    } catch (failure) {
      setReviewNote({ text: hostErrorText(failure, '没能开始审查。'), failed: true })
    } finally {
      setReviewing(false)
    }
  }

  const totals = useMemo(() => {
    let insertions = 0
    let deletions = 0
    for (const file of files ?? []) {
      insertions += file.insertions ?? 0
      deletions += file.deletions ?? 0
    }
    return { insertions, deletions }
  }, [files])

  const openDiff = (file: ChangedFile) =>
    router.push({
      pathname: '/diff',
      params: { id, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) },
    })
  // A document is seen as it is now, which its diff cannot show; the menu still has the diff.
  const open = (file: ChangedFile) => {
    if (file.status !== 'deleted' && opensInViewer(file.path)) {
      previewFile({ sessionId: id, path: file.path })
    } else openDiff(file)
  }

  const discard = (paths: string[]) => {
    const name = paths.length === 1 ? baseName(paths[0]!) : ''
    Alert.alert(
      paths.length === 1 ? `丢弃 ${name} 的更改？` : `丢弃 ${paths.length} 个文件的更改？`,
      paths.length === 1
        ? '文件会恢复到上次提交时的样子；如果是新文件，则会被删除。此操作无法撤销。'
        : '文件会恢复到上次提交时的样子，新文件会被删除。此操作无法撤销。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '丢弃',
          style: 'destructive',
          onPress: () => void steps.run({ kind: 'discard', paths }),
        },
      ],
    )
  }

  const blocked = !status || status.changes.conflicted > 0 || !!status.operation
  const fileMenu = (file: ChangedFile): MenuNode[] =>
    joinGroups([
      [
        ...(file.status === 'deleted'
          ? []
          : [
              {
                key: 'view',
                label: opensInViewer(file.path) ? '预览' : '用系统预览打开',
                icon: 'eye' as const,
                onPress: () => previewFile({ sessionId: id, path: file.path }),
              },
            ]),
        {
          key: 'diff',
          label: '打开差异',
          icon: 'plus.forwardslash.minus',
          onPress: () => openDiff(file),
        },
        ...(file.status === 'deleted'
          ? []
          : [
              {
                key: 'share',
                label: SHARE_LABEL,
                icon: 'square.and.arrow.up' as const,
                onPress: () => previewFile({ sessionId: id, path: file.path }, 'share'),
              },
            ]),
        ...(blocked || file.status === 'conflicted'
          ? []
          : [
              {
                key: 'commit',
                label: '提交…',
                icon: 'checkmark.circle' as const,
                onPress: () => steps.setSheet({ kind: 'commit', paths: [file.path] }),
              },
            ]),
      ],
      running
        ? []
        : [
            {
              key: 'discard',
              label: '丢弃',
              icon: 'arrow.uturn.backward',
              destructive: true,
              onPress: () => discard([file.path]),
            },
          ],
    ])

  let body: ReactElement
  if (!summary) {
    body = connected && hasSessions ? <StateView text="找不到这个会话。" /> : <StateView loading />
  } else if (summary.scratch) {
    body = <StateView text="这个会话没有项目，没有可看的改动。" />
  } else if (!status || !files) {
    body = error ? (
      <StateView text={error} tone="danger" retry={changes.reload} />
    ) : (
      <StateView loading />
    )
  } else if (!status.repo) {
    body = (
      <View style={{ flex: 1 }}>
        {summary.worktree ? (
          <View style={styles.pad}>
            <WorktreeCard sessionId={id} worktree={summary.worktree} />
          </View>
        ) : null}
        <StateView text="这个文件夹不是 git 仓库。" icon={G.folder} />
      </View>
    )
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
            menu={fileMenu(item)}
          />
        )}
        ItemSeparatorComponent={Separator}
        refreshControl={pull}
        ListHeaderComponent={
          <View style={styles.header}>
            {summary.worktree ? <WorktreeCard sessionId={id} worktree={summary.worktree} /> : null}
            <SyncCard
              status={status}
              gh={gh}
              running={running}
              onSwitch={() => router.push({ pathname: '/branches/[id]', params: { id } })}
              onPull={() => void steps.run({ kind: 'pull' })}
              onPush={() => steps.pushNow()}
            />
            <IncomingPart link={link} status={status} />
            <PrPart
              status={status}
              pr={current.pr}
              loading={current.loading}
              error={current.error}
              gh={gh}
              onRetry={current.reload}
              onCreate={() => steps.setSheet({ kind: 'createPr' })}
            />
            <View style={styles.changesHead}>
              <Text style={[styles.changesTitle, { color: c.text }]}>更改</Text>
              {files.length > 0 ? (
                <>
                  <Text style={[styles.total, { color: c.textSecondary }]}>
                    {files.length} 个文件
                  </Text>
                  <Counts insertions={totals.insertions} deletions={totals.deletions} />
                </>
              ) : null}
              <View style={styles.flex} />
              {files.length > 0 ? (
                <>
                  <PillButton
                    label="审查改动"
                    icon={G.eye}
                    disabled={!connected}
                    busy={reviewing}
                    onPress={() => void startReview()}
                  />
                  <PillButton
                    label="全部丢弃"
                    icon={GI.discard}
                    danger
                    disabled={running !== null}
                    busy={running === 'discard'}
                    onPress={() => discard(files.map((f) => f.path))}
                  />
                  <PillButton
                    label="提交…"
                    icon={G.commit}
                    filled
                    disabled={blocked || running !== null}
                    busy={running === 'commit'}
                    onPress={() => steps.setSheet({ kind: 'commit', paths: null })}
                  />
                </>
              ) : null}
            </View>
            {error ? <Text style={[styles.total, { color: c.danger }]}>{error}</Text> : null}
            {reviewNote ? (
              <Text
                style={[styles.total, { color: reviewNote.failed ? c.danger : c.textSecondary }]}
              >
                {reviewNote.text}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon icon={G.done} size={28} color={c.success} />
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>没有未提交的改动</Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <CommitsPart link={link} status={status} sessionId={id} />
            <FolderFooter status={status} />
          </View>
        }
        contentContainerStyle={styles.list}
      />
    )
  }

  const canFetch = !!status?.remote && running === null && connected
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title="改动"
        subtitle={
          summary && !summary.scratch
            ? `${projectName ?? baseName(summary.projectPath)}${summary.worktree ? ' · 工作树' : ''}`
            : null
        }
        right={
          status?.repo ? (
            <RoundButton
              tone="glass"
              size={44}
              {...(running === 'fetch' ? {} : { systemImage: GI.fetch.sf })}
              disabled={!canFetch}
              onPress={() => void steps.run({ kind: 'fetch' })}
              accessibilityLabel={!status.remote ? '此仓库没有远程仓库' : '抓取'}
            >
              {running === 'fetch' ? (
                <ActivityIndicator size="small" color={c.text} />
              ) : (
                <Icon icon={GI.fetch} size={17} color={c.text} weight="semibold" />
              )}
            </RoundButton>
          ) : null
        }
      />
      {body}
      {status?.repo && files ? (
        <>
          <CommitSheet
            visible={steps.sheet?.kind === 'commit'}
            status={status}
            files={files}
            paths={steps.sheet?.kind === 'commit' ? steps.sheet.paths : null}
            steps={steps}
            onClose={() => steps.setSheet(null)}
          />
          <CreatePrSheet
            visible={steps.sheet?.kind === 'createPr'}
            link={link}
            status={status}
            steps={steps}
            onClose={() => steps.setSheet(null)}
            onCreated={current.set}
          />
          <PublishBranchSheet
            visible={steps.sheet?.kind === 'publishBranch'}
            link={link}
            status={status}
            steps={steps}
            onClose={() => steps.setSheet(null)}
          />
          <PublishRepoSheet
            visible={steps.sheet?.kind === 'publishRepo'}
            status={status}
            tools={tools}
            steps={steps}
            onClose={() => steps.setSheet(null)}
          />
          <LogSheet
            visible={steps.sheet?.kind === 'log'}
            title={steps.sheet?.kind === 'log' ? steps.sheet.title : ''}
            log={steps.sheet?.kind === 'log' ? steps.sheet.log : ''}
            onClose={() => steps.setSheet(null)}
          />
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: 16, paddingTop: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  header: { paddingTop: 8, paddingBottom: 10 },
  changesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 6,
    flexWrap: 'wrap',
  },
  changesTitle: { fontSize: 17, fontWeight: '600' },
  total: { fontSize: 13 },
  empty: { alignItems: 'center', gap: 10, paddingTop: 36, paddingBottom: 24 },
  emptyText: { fontSize: 15 },
  footer: { paddingTop: 16 },
})

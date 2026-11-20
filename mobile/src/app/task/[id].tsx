// A task's page: its title and how it stands, the workflow, step n/N, pace, project and branch;
// what was asked; what waits for the user, a card each; the steps as a timeline, each round opening
// its session and each document its artifact; the notes added for the steps, with a field to add
// one; and pin, rename, cancel and delete. The computer's events keep it current.

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { TaskSummary, TaskView } from '@shared/workflow'
import { Markdown } from '../../components/Markdown'
import { RenameDialog } from '../../components/RenameDialog'
import { Sheet, type SheetItem } from '../../components/Sheet'
import { NeedCards, PinSheet } from '../../components/tasks/NeedCards'
import { useRequest } from '../../components/tasks/parts'
import { StepTimeline } from '../../components/tasks/StepTimeline'
import { useConnected, useHostActions, useMaybeLink, useProjects, useSession } from '../../host'
import { clockOf, folder, sessionTitle } from '../../sessions'
import {
  confirmCancel,
  confirmDelete,
  ENDED_TEXT,
  PACE_TEXT,
  progressText,
  spanText,
  taskRequest,
  togglePin,
  useTask,
  useTick,
  workflowTitle,
} from '../../tasks'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon, type IconName } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { NavBar } from '../../ui/NavBar'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { usePullRefresh } from '../../ui/PullRefresh'
import { SectionHeader } from '../../ui/SectionHeader'
import { Clamp } from '../../ui/session/Clamp'
import { Skeleton, SkeletonRows } from '../../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

export default function TaskPage() {
  const { retry } = useHostActions()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(async () => {
    retry()
    await reload()
  }, header)
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { summary, view, missing, error, reload } = useTask(id)
  const [more, setMore] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [pinning, setPinning] = useState<string | null>(null)
  const connected = useConnected()
  const link = useMaybeLink()

  // Shown, it counts as read, as on the desktop.
  const unread = summary?.unread === true
  useEffect(() => {
    if (unread && link && connected) {
      void taskRequest(link, 'tasks.update', { taskId: id, unread: false }).catch(() => {})
    }
  }, [unread, link, connected, id])

  if (!summary || !view) {
    let body
    if (missing) {
      body = (
        <EmptyState
          icon="flow"
          title="这条需求不在了"
          message="它被删除了，或者它所在的电脑不再列出它。"
          action={{ label: '返回', onPress: () => router.back() }}
        />
      )
    } else if (error && !view) {
      body = (
        <EmptyState
          tone="error"
          icon="warning"
          title="打不开这条需求"
          message={error}
          action={{ label: '重试', onPress: () => void reload() }}
        />
      )
    } else if (!connected && !view) {
      body = (
        <EmptyState
          icon="wifi"
          title="打不开这条需求"
          message="它所在的电脑没有连上，连上后会再显示。"
          action={{ label: '立即重连', onPress: () => retry() }}
        />
      )
    } else {
      body = (
        <View style={styles.loading}>
          <Skeleton width="70%" height={30} />
          <Skeleton width="45%" height={14} />
          <SkeletonRows count={4} />
        </View>
      )
    }
    return (
      <Screen>
        <View style={{ paddingTop: header.height + space.lg, paddingHorizontal: space.xl }}>
          {body}
        </View>
        <NavBar header={header} title={summary?.title ?? '需求'} titleAlways />
      </Screen>
    )
  }

  const running = summary.status === 'running'
  const menuItems: SheetItem[] = [
    {
      key: 'pin',
      label: summary.pinnedAt !== null ? '取消置顶' : '置顶',
      disabled: !connected,
      onPress: () => link && togglePin(link, summary),
    },
    { key: 'rename', label: '重命名', disabled: !connected, onPress: () => setRenaming(true) },
    running
      ? {
          key: 'cancel',
          label: '取消需求…',
          destructive: true,
          disabled: !connected,
          onPress: () => link && confirmCancel(link, summary),
        }
      : {
          key: 'delete',
          label: '删除…',
          destructive: true,
          disabled: !connected,
          onPress: () => link && confirmDelete(link, summary, () => router.back()),
        },
  ]

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.ScrollView
          {...header.scrollProps}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            paddingTop: header.contentTop,
            paddingHorizontal: space.lg,
            paddingBottom: insets.bottom + space.xxxl,
            gap: space.lg,
          }}
          refreshControl={pull}
        >
          <Head task={summary} view={view} />
          <Asked view={view} />
          <NeedCards view={view} onPin={setPinning} />
          <View>
            <SectionHeader title="步骤" count={view.workflow.steps.length} />
            <StepTimeline view={view} />
          </View>
          <Notes view={view} />
        </Animated.ScrollView>
      </KeyboardAvoidingView>
      <NavBar
        header={header}
        title={summary.title}
        right={
          <IconButton
            icon="more"
            label="更多操作"
            size={44}
            iconSize={18}
            onPress={() => {
              haptic.tap()
              setMore(true)
            }}
          />
        }
      />
      <Sheet
        visible={more}
        title={summary.title}
        items={menuItems}
        onClose={() => setMore(false)}
      />
      <RenameDialog
        visible={renaming}
        title={summary.title}
        heading="重命名需求"
        placeholder="需求名称"
        noReset
        maxLength={120}
        onClose={() => setRenaming(false)}
        onSave={async (title) => {
          if (!link || !title || title === summary.title) return
          await taskRequest(link, 'tasks.update', { taskId: summary.id, title })
        }}
      />
      <PinSheet view={view} stepId={pinning} onClose={() => setPinning(null)} />
    </Screen>
  )
}

/** The title, how the task stands, and its facts as chips. */
function Head(props: { task: TaskSummary; view: TaskView }) {
  const { task, view } = props
  const { c } = useTokens()
  const projects = useProjects()
  const running = task.status === 'running'
  const now = useTick(running)
  const progress = progressText(task)
  const project =
    projects.find((p) => p.path === task.projectPath)?.name ?? folder(task.projectPath)
  const state = running
    ? task.error
      ? { text: '卡住了', color: c.danger, icon: 'failed' as IconName }
      : task.needsYou
        ? { text: '需要你', color: c.warning, icon: 'hand' as IconName }
        : { text: '进行中', color: c.tint, icon: 'timer' as IconName }
    : {
        text: ENDED_TEXT[task.status],
        color: task.status === 'done' ? c.success : c.textSecondary,
        icon: (task.status === 'done' ? 'succeeded' : 'skipped') as IconName,
      }
  const facts: { icon: IconName; text: string }[] = [
    {
      icon: 'flow',
      text: progress ? `${workflowTitle(task, view)} · ${progress}` : workflowTitle(task, view),
    },
    { icon: 'sparkles', text: `Pace：${PACE_TEXT[view.pace]}` },
    { icon: 'folder', text: project },
    ...(task.branch ? [{ icon: 'branch' as IconName, text: task.branch }] : []),
  ]
  return (
    <View style={styles.head}>
      <Text style={[typeScale.title, { color: c.text }]} accessibilityRole="header">
        {task.title}
      </Text>
      <View style={styles.stateLine}>
        <Icon name={state.icon} size={15} color={state.color} />
        <Text style={[typeScale.subhead, { color: state.color }]}>{state.text}</Text>
        <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
          {running
            ? `· 已进行 ${spanText(now - task.createdAt)}`
            : `· 用时 ${spanText(task.updatedAt - task.createdAt)}`}
        </Text>
      </View>
      <View style={styles.facts}>
        {facts.map((fact) => (
          <View key={fact.icon} style={[styles.fact, { backgroundColor: c.fill }]}>
            <Icon name={fact.icon} size={13} color={c.textSecondary} />
            <Text
              style={[typeScale.caption, styles.shrink, { color: c.textSecondary }]}
              numberOfLines={1}
            >
              {fact.text}
            </Text>
          </View>
        ))}
      </View>
      {view.paceReason ? (
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>{view.paceReason}</Text>
      ) : null}
    </View>
  )
}

/** What was asked, as the message that started it, and where it came from. */
function Asked(props: { view: TaskView }) {
  const { view } = props
  const { c } = useTokens()
  const from = useSession(view.from?.sessionId)
  const workflow = workflowTitle(view, view)
  const line = from
    ? `从“${sessionTitle(from)}”开始 · ${workflow} · ${clockOf(view.createdAt)}`
    : `按 ${workflow} 开始 · ${clockOf(view.createdAt)}`
  return (
    <View style={[styles.asked, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Clamp maxHeight={150} more="展开全部">
        <Markdown markdown={view.text} size="compact" />
      </Clamp>
      {from ? (
        <Press
          onPress={() => router.push(`/session/${from.id}`)}
          scale={false}
          accessibilityRole="link"
          style={styles.from}
        >
          <Icon name="message" size={12} color={c.tint} />
          <Text style={[typeScale.caption, styles.shrink, { color: c.tint }]} numberOfLines={1}>
            {line}
          </Text>
        </Press>
      ) : (
        <View style={styles.from}>
          <Icon name="message" size={12} color={c.textTertiary} />
          <Text style={[typeScale.caption, { color: c.textTertiary }]}>{line}</Text>
        </View>
      )}
    </View>
  )
}

/**
 * The notes added for the steps, then a field to add one: the steps at work and every later one
 * get it, and it moves nothing. An ended task takes no more.
 */
function Notes(props: { view: TaskView }) {
  const { view } = props
  const { c } = useTokens()
  const current = useMaybeLink()
  const connected = useConnected()
  const [text, setText] = useState('')
  const request = useRequest()
  const ended = view.status !== 'running'
  const off = ended || !current || !connected
  const send = () => {
    const note = text.trim()
    if (!note || off || !current) return
    const link = current
    void request
      .run('note', () => taskRequest(link, 'tasks.note', { taskId: view.id, text: note }))
      .then((sent) => {
        if (sent) setText('')
      })
  }
  return (
    <View style={styles.notes}>
      <SectionHeader title="补充需求" count={view.notes.length || undefined} />
      {view.notes.map((note) => (
        <View
          key={note.at}
          style={[styles.note, { backgroundColor: c.tintSoft }]}
          accessibilityLabel={`补充：${note.text}`}
        >
          <Markdown markdown={note.text} size="compact" />
          <Text style={[typeScale.caption, { color: c.textTertiary }]}>
            已补充给各步骤 · {clockOf(note.at)}
          </Text>
        </View>
      ))}
      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!off}
          multiline
          placeholder={ended ? '这条需求已经结束' : '补充需求，交给正在做的步骤和之后的每一步'}
          placeholderTextColor={c.textTertiary}
          accessibilityLabel="补充需求"
          style={[typeScale.callout, styles.composerInput, { color: c.text }]}
        />
        <Press
          onPress={send}
          disabled={off || !text.trim() || request.busy !== null}
          hitSlop={5}
          accessibilityRole="button"
          accessibilityLabel="补充"
          style={[styles.send, { backgroundColor: off || !text.trim() ? c.fillStrong : c.accent }]}
        >
          {request.busy ? (
            <ActivityIndicator color={c.onAccent} size="small" />
          ) : (
            <Icon name="send" size={16} color={c.onAccent} weight="bold" />
          )}
        </Press>
      </View>
      {request.error ? (
        <Text accessibilityRole="alert" style={[typeScale.footnote, { color: c.danger }]}>
          {request.error}
        </Text>
      ) : (
        <Text style={[typeScale.footnote, styles.hint, { color: c.textTertiary }]}>
          补充不推进流程
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  loading: { gap: space.md, paddingTop: space.md },
  head: { gap: space.sm, paddingTop: space.md, paddingHorizontal: space.xs },
  stateLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, marginTop: space.xs },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    maxWidth: '100%',
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
  },
  asked: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
  },
  from: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  notes: { gap: space.sm },
  note: { borderRadius: radius.md, padding: space.md, gap: space.xs },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    paddingLeft: space.md,
  },
  composerInput: { flex: 1, minHeight: 36, maxHeight: 140, paddingVertical: space.sm },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { marginLeft: space.sm },
})

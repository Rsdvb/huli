// Home: a greeting and what needs the user, then every session on the computer, pinned ones first.
// Search is a page of its own (search.tsx), from the top bar. On a wide window (iPad) the list
// keeps a column on the left and the chosen session opens beside it, in the session screen itself.

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { TaskSummary } from '@shared/workflow'
import { useSessionActions } from '../../components/SessionActions'
import { SessionPaneProvider } from '../../components/SessionPane'
import {
  SessionRow,
  SessionRowSkeleton,
  subagentCounts,
  type SubagentCount,
} from '../../components/SessionRow'
import { TaskRow } from '../../components/tasks/TaskRow'
import {
  FilterNote,
  inFilter,
  sessionFilterItem,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { SyncNote } from '../../components/SyncNote'
import { UpdateBanner } from '../../components/UpdateBanner'
import {
  sameFields,
  useActiveHost,
  useAgents,
  useHost,
  useHostActions,
  useHostSelector,
  useProjects,
  useSessions,
  type HostData,
} from '../../host'
import { linkProblem } from '../../linkInfo'
import { greeting, listOrder, needsYou, withChildWaits } from '../../sessions'
import { needsAttention, useTaskList } from '../../tasks'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { LIST_COLUMN, useWide } from '../../ui/layout'
import { Press } from '../../ui/Press'
import { AnimatedFlashList, type FlashListRef } from '../../ui/AnimatedList'
import { Screen } from '../../ui/Screen'
import { countRender } from '../../ui/renders'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { computerName } from '../../store'
import { haptic } from '../../ui/haptics'
import { Pill } from '../../ui/Pill'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'

// The session screen beside the list is for a wide window only; a phone never loads it here, so
// the conversation, the composer and their menus stay off the start's path.
const SessionScreen = lazy(() => import('../session/[id]'))

function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

/** The agents of some sessions as small overlapping avatars, inside a line of the greeting. */
function Inline(props: { agents: SessionSummary[] }) {
  const { c } = useTokens()
  const ids = [...new Set(props.agents.map((s) => s.agentId))].slice(0, 3)
  return (
    <View style={styles.inline}>
      {ids.map((id, i) => (
        <View
          key={id}
          style={[styles.inlineAvatar, { marginLeft: i === 0 ? 0 : -8, borderColor: c.bg }]}
        >
          <AgentAvatar agentId={id} size={24} />
        </View>
      ))}
    </View>
  )
}

type Item =
  | { kind: 'section'; key: string; title: string; count: number; waiting?: boolean }
  | { kind: 'session'; key: string; session: SessionSummary }
  | { kind: 'task'; key: string; task: TaskSummary }

export default function Home() {
  const wide = useWide()
  const { c } = useTokens()
  const [selected, setSelected] = useState<string | null>(null)

  // A session that went away on the computer leaves the pane.
  const gone = useHostSelector(
    useCallback(
      (d: HostData) => selected !== null && d.loaded && !d.sessions.has(selected),
      [selected],
    ),
  )
  useEffect(() => {
    if (gone) setSelected(null)
  }, [gone])
  const close = useCallback(() => setSelected(null), [])

  if (!wide) {
    return <SessionList selected={null} onOpen={openScreen} />
  }
  return (
    <View style={[styles.split, { backgroundColor: c.bg }]}>
      <View style={styles.column}>
        <SessionList selected={selected} onOpen={setSelected} />
      </View>
      <View style={[styles.divider, { backgroundColor: c.border }]} />
      <View style={styles.pane}>
        {selected ? (
          <SessionPaneProvider id={selected} open={setSelected} close={close}>
            <Suspense fallback={<View style={[styles.pane, { backgroundColor: c.bg }]} />}>
              <SessionScreen key={selected} />
            </Suspense>
          </SessionPaneProvider>
        ) : (
          <Screen edges={['top']}>
            <View style={styles.placeholder}>
              <EmptyState
                icon="message"
                title="选一个会话"
                message="左边列表里的会话会在这里打开，列表一直留在旁边。"
              />
            </View>
          </Screen>
        )}
      </View>
    </View>
  )
}

const openScreen = (id: string) => router.push(`/session/${id}`)

/** What a row can do, the same functions for the list's whole life so rows can skip renders. */
interface RowActions {
  open(id: string): void
  more(s: SessionSummary): void
  togglePin(s: SessionSummary): void
  archive(s: SessionSummary): void
}

interface HomeRowProps {
  session: SessionSummary
  taskTitle: string | undefined
  subagents: SubagentCount | undefined
  agentName: string | undefined
  projectName: string | undefined
  selected: boolean
  appear: boolean
  connected: boolean
  actions: RowActions
}

function sameHomeRow(a: HomeRowProps, b: HomeRowProps): boolean {
  return (
    // A parent whose child waits is a copy with the count added; its fields are what matter.
    sameFields(a.session, b.session) &&
    a.taskTitle === b.taskTitle &&
    a.subagents?.count === b.subagents?.count &&
    a.subagents?.running === b.subagents?.running &&
    a.agentName === b.agentName &&
    a.projectName === b.projectName &&
    a.selected === b.selected &&
    a.appear === b.appear &&
    a.connected === b.connected &&
    a.actions === b.actions
  )
}

/** A session's row in the list: redraws only when what it shows changed. */
const HomeRow = memo(function HomeRow(props: HomeRowProps) {
  countRender('HomeRow')
  const { c } = useTokens()
  const s = props.session
  const { actions } = props
  return (
    <SessionRow
      session={s}
      task={s.task ? { id: s.task.taskId, title: props.taskTitle ?? '需求' } : undefined}
      subagents={props.subagents}
      agentName={props.agentName}
      projectName={props.projectName}
      selected={props.selected}
      appear={props.appear}
      onPress={() => actions.open(s.id)}
      onLongPress={() => actions.more(s)}
      start={
        props.connected
          ? {
              label: s.pinnedAt !== null ? '取消置顶' : '置顶',
              icon: s.pinnedAt !== null ? 'unpin' : 'pin',
              color: c.accent,
              onPress: () => actions.togglePin(s),
            }
          : undefined
      }
      end={
        props.connected
          ? { label: '归档', icon: 'archive', color: c.tint, onPress: () => actions.archive(s) }
          : undefined
      }
    />
  )
}, sameHomeRow)

const pickLink = (d: HostData) => ({
  state: d.state,
  loaded: d.loaded,
  unreachable: d.unreachable,
})

const itemType = (item: Item) => item.kind
const itemKey = (item: Item) => item.key

function SessionList(props: { selected: string | null; onOpen(id: string): void }) {
  countRender('SessionList')
  const { c } = useTokens()
  const sessions = useSessions()
  const projects = useProjects()
  const agents = useAgents()
  const host = useHostSelector(pickLink, sameFields)
  const active = useActiveHost()
  const { retry, refresh } = useHostActions()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlashListRef<Item>>(null)
  const [refreshing, setRefreshing] = useState(false)
  const actions = useSessionActions('list')
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  // The rows call through these, so they need not redraw when the list's own state changes.
  const latest = useRef({ actions, onOpen: props.onOpen })
  latest.current = { actions, onOpen: props.onOpen }
  const rowActions = useMemo<RowActions>(
    () => ({
      open: (id) => latest.current.onOpen(id),
      more: (s) => latest.current.actions.open(s),
      togglePin: (s) => latest.current.actions.togglePin(s),
      archive: (s) => latest.current.actions.archive(s),
    }),
    [],
  )

  // A sub-session's or sub-agent's wait counts on the session the list shows, as on the desktop.
  const listed = useMemo(
    () =>
      [...withChildWaits(sessions).values()].filter(
        (s) => s.parentId === null && s.archivedAt === null,
      ),
    [sessions],
  )
  const archivedCount = useMemo(
    () => [...sessions.values()].filter((s) => s.parentId === null && s.archivedAt !== null).length,
    [sessions],
  )
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.path, p.name])), [projects])

  const visible = useMemo(
    () => listed.filter((s) => inFilter(shell.filter, sessionFilterItem(s))).sort(listOrder),
    [listed, shell.filter],
  )

  // Tasks that wait for the user count with the sessions that do, as the desktop's Needs you
  // group lists both; a step's session that asks is counted on its task.
  const { tasks, views: taskViews } = useTaskList()
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks])
  const needingTasks = useMemo(() => tasks.filter(needsAttention), [tasks])
  const needingTaskIds = useMemo(() => new Set(needingTasks.map((t) => t.id)), [needingTasks])
  const ownWait = (s: SessionSummary) =>
    needsYou(s) && !(s.task && needingTaskIds.has(s.task.taskId))

  const connected = host.state.kind === 'connected'
  const waiting = listed.filter(ownWait).length + needingTasks.length
  const runningNow = listed.filter((s) => !needsYou(s) && isRunning(s))
  const subagents = useMemo(() => subagentCounts(sessions.values()), [sessions])
  const problem = linkProblem(host.state)

  const items = useMemo<Item[]>(() => {
    const taskWaits = needingTasks.filter((t) =>
      inFilter(shell.filter, { scratch: false, path: t.projectPath }),
    )
    const needing = visible.filter(
      (s) => needsYou(s) && !(s.task && needingTaskIds.has(s.task.taskId)),
    )
    const running = visible.filter((s) => !needsYou(s) && isRunning(s))
    const rest = visible.filter((s) => !needsYou(s) && !isRunning(s))
    const out: Item[] = []
    if (needing.length + taskWaits.length > 0) {
      out.push({
        kind: 'section',
        key: '__waiting',
        title: '需要你处理',
        count: needing.length + taskWaits.length,
        waiting: true,
      })
      for (const t of taskWaits) out.push({ kind: 'task', key: `task:${t.id}`, task: t })
      for (const s of needing) out.push({ kind: 'session', key: s.id, session: s })
    }
    if (running.length > 0) {
      out.push({ kind: 'section', key: '__running', title: '正在运行', count: running.length })
      for (const s of running) out.push({ kind: 'session', key: s.id, session: s })
    }
    if (rest.length > 0) {
      out.push({ kind: 'section', key: '__recent', title: '最近', count: rest.length })
      for (const s of rest) out.push({ kind: 'session', key: s.id, session: s })
    }
    return out
  }, [visible, needingTasks, needingTaskIds, shell.filter])

  // With the cache's lists the summary still says what they said; the note under it says when.
  const summary =
    !connected && !host.loaded
      ? host.unreachable && host.state.kind !== 'stopped'
        ? `连不上「${computerName(active)}」。`
        : problem
      : null
  // Connected, it says what waits and what runs, each with its agents' avatars, as Kettu's does.
  const counts =
    summary === null ? (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>
        {waiting === 0 && runningNow.length === 0 ? (
          '这里没有需要你处理的。'
        ) : (
          <>
            你有
            {waiting > 0 ? (
              <>
                {' '}
                <Inline agents={listed.filter(needsYou)} />
                <Text style={{ color: c.text }}> {waiting} 个在等你</Text>
              </>
            ) : null}
            {waiting > 0 && runningNow.length > 0 ? '，' : null}
            {runningNow.length > 0 ? (
              <>
                {' '}
                <Inline agents={runningNow} />
                <Text style={{ color: c.text }}> {runningNow.length} 个运行中</Text>
              </>
            ) : null}
            。
          </>
        )}
      </Text>
    ) : (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>{summary}</Text>
    )

  const top = (
    <View style={styles.top}>
      <View style={styles.greeting} accessibilityRole="header">
        <Text style={[typeScale.lead, { color: c.textSecondary }]}>{greeting()}。</Text>
        {counts}
        {host.loaded ? <SyncNote /> : null}
      </View>
      <UpdateBanner />
      <FilterNote what="会话" />
    </View>
  )

  const empty = () => {
    if (!host.loaded) {
      if (!connected && host.unreachable && host.state.kind !== 'stopped') return <Unreachable />
      return <SessionRowSkeleton />
    }
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有会话"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="message"
        title="还没有会话"
        message="在手机上开一个，电脑上的 Agent 就会开始干活。"
        action={
          host.state.kind !== 'stopped'
            ? { label: '新会话', onPress: () => router.push('/new') }
            : undefined
        }
      />
    )
  }

  const footer =
    archivedCount > 0 ? (
      <Press
        onPress={() => router.push('/archived')}
        scale={false}
        accessibilityRole="button"
        style={styles.archived}
      >
        <Icon name="archive" size={18} color={c.textSecondary} />
        <Text style={[typeScale.callout, { color: c.textSecondary, flex: 1 }]}>已归档的会话</Text>
        <Text style={[typeScale.callout, styles.count, { color: c.textTertiary }]}>
          {archivedCount}
        </Text>
        <Icon name="chevronRight" size={13} color={c.textTertiary} weight="semibold" />
      </Press>
    ) : null

  // Sessions new to the list since it first showed come in with an animation; rows the list only
  // mounts again as it scrolls do not.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useRef(new Set<string>())
  const ids = items.flatMap((item) => (item.kind === 'session' ? [item.session.id] : []))
  if (seen.current === null) {
    if (ids.length > 0) seen.current = new Set(ids)
  } else {
    for (const sid of ids) {
      if (!seen.current.has(sid)) {
        seen.current.add(sid)
        fresh.current.add(sid)
      }
    }
  }
  useEffect(() => {
    fresh.current.clear()
  })

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === 'section') {
      return (
        <View style={styles.pad}>
          <SectionHeader
            title={item.title}
            count={item.count}
            color={item.waiting ? c.warning : undefined}
          />
        </View>
      )
    }
    if (item.kind === 'task') {
      const t = item.task
      return (
        <TaskRow
          task={t}
          view={taskViews.get(t.id)}
          projectName={projectNames.get(t.projectPath)}
          onPress={() => router.push(`/task/${t.id}`)}
        />
      )
    }
    const s = item.session
    return (
      <HomeRow
        session={s}
        taskTitle={s.task ? taskTitles.get(s.task.taskId) : undefined}
        subagents={subagents.get(s.id)}
        agentName={agents.get(s.agentId)?.name}
        projectName={projectNames.get(s.projectPath)}
        selected={props.selected === s.id}
        appear={fresh.current.has(s.id)}
        connected={connected}
        actions={rowActions}
      />
    )
  }

  return (
    <Screen>
      <AnimatedFlashList
        ref={list}
        data={items}
        extraData={props.selected}
        keyExtractor={itemKey}
        getItemType={itemType}
        renderItem={renderItem}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.textSecondary}
            progressViewOffset={header.height}
            onRefresh={() => {
              setRefreshing(true)
              retry()
              void refresh()
                .catch(() => {})
                .finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={top}
        ListEmptyComponent={empty()}
        ListFooterComponent={footer ?? undefined}
      />
      <TopBar header={header} />
      {actions.element}
    </Screen>
  )
}

const REASONS = [
  '电脑上的纸鸢没开，或者电脑睡着了',
  '手机和电脑不在同一个网络，或者 Tailscale 没连上',
  '电脑上的「设置 › 远程访问」被关掉了',
]

/** Nothing cached and no link for a while: why that may be, and a way to try again. */
function Unreachable() {
  const { c } = useTokens()
  const host = useHost()
  const several = host.computers.length > 1
  return (
    <View style={styles.pad}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.badge, { backgroundColor: c.fill }]}>
          <Icon name="wifi" size={24} color={c.textSecondary} />
        </View>
        <Text style={[typeScale.headline, { color: c.text }]}>
          连不上「{computerName(host.host)}」
        </Text>
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>可能是：</Text>
        {REASONS.map((reason) => (
          <View key={reason} style={styles.reason}>
            <Text style={[typeScale.callout, { color: c.textSecondary }]}>·</Text>
            <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{reason}</Text>
          </View>
        ))}
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          纸鸢会在后台继续尝试，连上后这里会自动出现会话。
        </Text>
        <View style={styles.buttons}>
          <Pill
            tone="tint"
            label="重试"
            leading={<Icon name="refresh" size={14} color={c.tint} />}
            onPress={() => {
              haptic.tap()
              host.retry()
            }}
          />
          {several ? (
            <Pill
              tone="fill"
              label="换一台电脑"
              onPress={() => router.push('/settings/computers')}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', transform: [{ translateY: 5 }] },
  inlineAvatar: { borderWidth: 2, borderRadius: 14 },
  card: {
    marginTop: space.lg,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  reason: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  split: { flex: 1, flexDirection: 'row' },
  column: { width: LIST_COLUMN },
  divider: { width: StyleSheet.hairlineWidth },
  pane: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center' },
  pad: { paddingHorizontal: space.xl },
  top: { paddingHorizontal: space.xl, paddingTop: space.sm },
  greeting: { gap: space.xs, paddingTop: space.md, paddingBottom: space.sm },
  archived: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  count: { fontVariant: ['tabular-nums'] },
})

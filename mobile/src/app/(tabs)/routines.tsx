// 任务: the work that runs without a conversation, in two halves under a segmented switch. 需求 are
// tasks run through workflows (components/tasks/TasksView.tsx). 定时 are routines: what they are,
// a way to make one, the user's routines (each with its switch, when it last ran and runs next),
// and ready-made examples to start from. A task or a routine opens its page.

import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { Alert, Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { RoutineView } from '@shared/routines'
import { DEFAULT_SCHEDULE, DEFAULT_SCOPE } from '@shared/routines'
import { RoutineEditor, type EditorSeed } from '../../components/RoutineEditor'
import { ListSyncNote, OfflineNote } from '../../components/SyncNote'
import { inFilter, TopBar, useScrollTopOnTabPress, useShell } from '../../components/shell'
import { TasksView } from '../../components/tasks/TasksView'
import {
  useAgents,
  useComputerId,
  useHostActions,
  useHostState,
  useMaybeLink,
  useProjects,
} from '../../host'
import {
  confirmDeleteRoutine,
  routineExamples,
  RUN_TEXT,
  runLook,
  scheduleText,
  scopeText,
  STATE_TEXT,
  useRoutineList,
  whenText,
} from '../../routines'
import { errorText, folder } from '../../sessions'
import { setTasksTabView, useTasksTabView } from '../../tasks'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { usePullRefresh } from '../../ui/PullRefresh'
import { SectionHeader } from '../../ui/SectionHeader'
import { PendingSwitch } from '../../ui/PendingSwitch'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Skeleton } from '../../ui/Skeleton'
import { SwipeRow } from '../../ui/SwipeRow'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'

export default function TasksTab() {
  const view = useTasksTabView()
  // Each computer's lists mount afresh, so none shows another's while its own load.
  const hostId = useComputerId() ?? ''
  const switcher = (
    <SegmentedControl
      segments={[
        { key: 'tasks', label: '需求' },
        { key: 'routines', label: '例程' },
      ]}
      value={view}
      onChange={setTasksTabView}
    />
  )
  return view === 'tasks' ? (
    <TasksView key={hostId} switcher={switcher} />
  ) : (
    <Routines key={hostId} switcher={switcher} />
  )
}

function Routines(props: { switcher: ReactNode }) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const state = useHostState()
  const { retry } = useHostActions()
  const agents = useAgents()
  const projects = useProjects()
  const shell = useShell()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(async () => {
    retry()
    await load()
  }, header)
  const insets = useSafeAreaInsets()
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const { data, error, syncedAt, load } = useRoutineList()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [seed, setSeed] = useState<EditorSeed | null>(null)
  const connected = state.kind === 'connected'
  useScrollTopOnTabPress(
    (offset) => scroll.current?.scrollTo({ y: offset, animated: true }),
    header,
  )

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.path, p.name])), [projects])
  const words = searching ? query.trim().toLowerCase() : ''
  const inProject = useMemo(
    () =>
      (data?.routines ?? []).filter((r) =>
        inFilter(shell.filter, { scratch: r.projectPath === null, path: r.projectPath ?? '' }),
      ),
    [data, shell.filter],
  )
  const visible = useMemo(() => {
    const rank = { on: 0, paused: 1, off: 2, done: 3 }
    return inProject
      .filter(
        (r) =>
          !words || r.name.toLowerCase().includes(words) || r.prompt.toLowerCase().includes(words),
      )
      .sort(
        (a, b) =>
          rank[a.state] - rank[b.state] ||
          (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) ||
          a.name.localeCompare(b.name),
      )
  }, [inProject, words])

  // A new routine starts in the project the tabs are filtered to.
  const filterProject =
    shell.filter.kind === 'project'
      ? shell.filter.path
      : shell.filter.kind === 'scratch'
        ? null
        : undefined

  const startNew = (from?: Partial<EditorSeed>) => {
    haptic.tap()
    setSeed({
      name: '',
      prompt: '',
      schedule: DEFAULT_SCHEDULE,
      scope: DEFAULT_SCOPE,
      ...(filterProject !== undefined ? { projectPath: filterProject } : {}),
      ...from,
    })
  }

  const toggle = async (r: RoutineView, enabled: boolean): Promise<boolean> => {
    if (!link) return false
    haptic.select()
    try {
      await link.request('routines.update', { routineId: r.id, changes: { enabled } })
      return true
    } catch (failure) {
      Alert.alert(enabled ? '没能开启' : '没能关闭', errorText(failure))
      return false
    }
  }

  const place = (r: RoutineView) =>
    r.projectPath === null ? '无项目' : (projectNames.get(r.projectPath) ?? folder(r.projectPath))

  const routineRow = (r: RoutineView, index: number) => {
    const run = r.activeRun ?? r.lastRun
    const look = run ? runLook(c, run.status) : null
    const quiet = r.state === 'off' || r.state === 'done'
    const agent = agents.get(r.agentId)
    return (
      <View key={r.id}>
        {index > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
        <SwipeRow
          start={
            connected && r.state !== 'done'
              ? {
                  label: r.enabled ? '关闭' : '开启',
                  icon: r.enabled ? 'pause' : 'play',
                  color: r.enabled ? c.warning : c.success,
                  onPress: () => toggle(r, !r.enabled),
                }
              : undefined
          }
          end={
            connected
              ? {
                  label: '删除',
                  icon: 'trash',
                  color: c.danger,
                  onPress: () => link && confirmDeleteRoutine((m, p) => link!.request(m, p), r),
                }
              : undefined
          }
        >
          <Press
            onPress={() => router.push(`/routine/${r.id}`)}
            scale={false}
            accessibilityRole="button"
            accessibilityLabel={`${r.name}，${scheduleText(r.trigger.schedule)}，${STATE_TEXT[r.state]}`}
            accessibilityHint="查看运行记录和设置"
            style={[styles.routine, { backgroundColor: c.surface }]}
          >
            <View style={{ opacity: quiet ? 0.5 : 1 }}>
              <AgentAvatar
                agentId={r.agentId}
                name={agent?.name}
                size={36}
                badge={r.activeRun ? 'live' : r.unseen.failed > 0 ? 'error' : null}
                ring={c.surface}
              />
            </View>
            <View style={styles.body}>
              <Text
                style={[typeScale.rowTitle, { color: quiet ? c.textSecondary : c.text }]}
                numberOfLines={1}
              >
                {r.name}
              </Text>
              <Text
                style={[typeScale.footnote, styles.tabular, { color: c.textSecondary }]}
                numberOfLines={1}
              >
                {scheduleText(r.trigger.schedule)} · {place(r)}
              </Text>
              <View style={styles.meta}>
                {run && look ? (
                  <>
                    <Icon name={look.icon} size={13} color={look.color} />
                    <Text
                      style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
                      numberOfLines={1}
                    >
                      {RUN_TEXT[run.status]}
                      {r.activeRun
                        ? ''
                        : ` · ${whenText(run.endedAt ?? run.startedAt ?? r.updatedAt)}`}
                    </Text>
                  </>
                ) : r.state === 'on' && r.nextRunAt !== null ? (
                  <Text
                    style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
                    numberOfLines={1}
                  >
                    下次 {whenText(r.nextRunAt)}
                  </Text>
                ) : (
                  <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
                    {r.state === 'on' ? '还没有运行过' : STATE_TEXT[r.state]}
                  </Text>
                )}
              </View>
            </View>
            <PendingSwitch
              value={r.enabled}
              disabled={!connected || r.state === 'done'}
              onChange={(on) => toggle(r, on)}
              accessibilityLabel={r.enabled ? `关闭 ${r.name}` : `开启 ${r.name}`}
            />
          </Press>
        </SwipeRow>
      </View>
    )
  }

  const intro = (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.introText}>
        <Text style={[typeScale.headline, { color: c.text }]}>例程按计划运行一条提示词</Text>
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>
          每次运行都会在电脑上开一个会话，只在你给的权限内干活，做完告诉你。
        </Text>
      </View>
      <View style={[styles.line, { backgroundColor: c.border }]} />
      <Press
        onPress={() => startNew()}
        disabled={!connected}
        scale={false}
        accessibilityRole="button"
        style={styles.newRow}
      >
        <Icon name="plus" size={22} color={c.tint} />
        <Text style={[typeScale.body, { color: c.tint }]}>新建例程</Text>
      </Press>
    </View>
  )

  const mine = () => {
    if (!connected && !data) {
      return (
        <EmptyState
          icon="history"
          title="连上电脑后才能看例程"
          message="纸鸢正在连接你的电脑。"
          action={{ label: '立即重连', onPress: () => retry() }}
        />
      )
    }
    if (error && !data) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到例程"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!data) {
      return (
        <View
          style={[
            styles.card,
            styles.skeleton,
            { backgroundColor: c.surface, borderColor: c.border },
          ]}
          accessibilityLabel="正在加载"
        >
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width={36} height={36} radius={18} />
              <View style={styles.body}>
                <Skeleton width="60%" height={15} />
                <Skeleton width="40%" height={12} />
              </View>
            </View>
          ))}
        </View>
      )
    }
    if (visible.length > 0) {
      return (
        <>
          <SectionHeader title="你的例程" count={visible.length} />
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            {visible.map(routineRow)}
          </View>
        </>
      )
    }
    if (words) {
      return <EmptyState icon="search" title={`没有例程包含「${query.trim()}」`} />
    }
    if (shell.filter.kind !== 'all' && data.routines.length > 0) {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有例程"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return null
  }

  const examples = routineExamples()

  return (
    <Screen readable>
      <Animated.ScrollView
        ref={scroll}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
          gap: space.md,
        }}
        refreshControl={pull}
      >
        {props.switcher}
        {data ? <OfflineNote what="开关、新建和运行例程" /> : null}
        {data ? <ListSyncNote error={error} syncedAt={syncedAt} onRetry={load} /> : null}
        {searching ? (
          <View style={[styles.searchBox, { backgroundColor: c.fill }]}>
            <Icon name="search" size={17} color={c.textSecondary} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="搜索名称或提示词"
              placeholderTextColor={c.textTertiary}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
              style={[typeScale.body, styles.searchInput, { color: c.text }]}
            />
          </View>
        ) : (
          intro
        )}
        {data?.problem ? (
          <View style={[styles.problem, { backgroundColor: c.removedBg }]}>
            <Icon name="warning" size={16} color={c.danger} />
            <Text style={[typeScale.footnote, styles.body, { color: c.text }]}>
              例程文件读不了：{data.problem.reason}
              {data.problem.backup ? `。原文件已另存为 ${data.problem.backup}。` : ''}
            </Text>
          </View>
        ) : null}
        {mine()}
        {!searching ? (
          <>
            <SectionHeader title="示例" />
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              {examples.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
                  <Press
                    onPress={() =>
                      startNew({
                        name: e.name,
                        prompt: e.prompt,
                        schedule: e.schedule,
                        scope: e.scope,
                      })
                    }
                    disabled={!connected}
                    scale={false}
                    accessibilityRole="button"
                    accessibilityLabel={`使用示例：${e.name}，${scheduleText(e.schedule)}，${scopeText(e.scope)}`}
                    style={styles.example}
                  >
                    <View style={styles.body}>
                      <Text style={[typeScale.rowTitle, { color: c.tint }]}>{e.name}</Text>
                      <Text
                        style={[typeScale.footnote, styles.tabular, { color: c.textSecondary }]}
                        numberOfLines={1}
                      >
                        {scheduleText(e.schedule)} · {scopeText(e.scope)}
                      </Text>
                    </View>
                    <Text style={[typeScale.body, { color: c.tint, fontWeight: '500' }]}>使用</Text>
                  </Press>
                </View>
              ))}
            </View>
            <Text style={[typeScale.footnote, styles.footnote, { color: c.textTertiary }]}>
              例程在电脑上的纸鸢开着时按电脑的时间运行。Agent
              接近套餐限额时，它会先暂停，或按设置换用有额度的 Agent。
            </Text>
          </>
        ) : null}
      </Animated.ScrollView>
      <TopBar
        header={header}
        compact
        search={{
          active: searching,
          onPress: () => {
            haptic.tap()
            if (searching) setQuery('')
            setSearching(!searching)
          },
        }}
      />
      <RoutineEditor
        seed={seed}
        onClose={() => setSeed(null)}
        onSaved={(r) => router.push(`/routine/${r.id}`)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 3 },
  tabular: { fontVariant: ['tabular-nums'] },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  introText: { padding: space.xl, paddingBottom: space.lg, gap: space.xs },
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.xl },
  routine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  example: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md + 2,
  },
  problem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchInput: { flex: 1, paddingVertical: 0 },
  skeleton: { padding: space.lg, gap: space.lg },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  footnote: { marginHorizontal: space.sm },
})

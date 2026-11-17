// The 需求 half of the 任务 tab: what waits for the user, what runs, what is done and what was
// dropped or cancelled, pinned ones first in each; a way to start one and the workflow library.
// A task opens its page.

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { TaskSummary } from '@shared/workflow'
import { useHostActions, useHostState, useMaybeLink, useProjects } from '../../host'
import { folder } from '../../sessions'
import {
  confirmCancel,
  confirmDelete,
  needsAttention,
  togglePin,
  useTaskList,
  workflowTitle,
} from '../../tasks'
import { AnimatedFlashList, type FlashListRef } from '../../ui/AnimatedList'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { Skeleton } from '../../ui/Skeleton'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'
import { inFilter, TopBar, useScrollTopOnTabPress, useShell } from '../shell'
import { Sheet, type SheetItem } from '../Sheet'
import { TaskRow } from './TaskRow'

type Section = 'waiting' | 'running' | 'done' | 'dropped'

const SECTIONS: { key: Section; title: string }[] = [
  { key: 'waiting', title: '需要你' },
  { key: 'running', title: '进行中' },
  { key: 'done', title: '已完成' },
  { key: 'dropped', title: '放弃或取消' },
]

function sectionOf(task: TaskSummary): Section {
  if (task.status === 'running') return needsAttention(task) ? 'waiting' : 'running'
  return task.status === 'done' ? 'done' : 'dropped'
}

type Item =
  | { kind: 'section'; key: string; title: string; count: number; waiting: boolean }
  | { kind: 'task'; key: string; task: TaskSummary }

const itemKey = (item: Item) => item.key
const itemType = (item: Item) => item.kind

export function TasksView(props: { switcher: ReactNode }) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const state = useHostState()
  const { retry } = useHostActions()
  const projects = useProjects()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlashListRef<Item>>(null)
  const { tasks, views, loaded, error, reload } = useTaskList()
  const [refreshing, setRefreshing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<TaskSummary | null>(null)
  const connected = state.kind === 'connected'
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.path, p.name])),
    [projects],
  )
  const words = searching ? query.trim().toLowerCase() : ''
  const inProject = useMemo(
    () => tasks.filter((t) => inFilter(shell.filter, { scratch: false, path: t.projectPath })),
    [tasks, shell.filter],
  )
  const visible = useMemo(
    () =>
      inProject.filter(
        (t) =>
          !words ||
          t.title.toLowerCase().includes(words) ||
          workflowTitle(t, views.get(t.id)).toLowerCase().includes(words) ||
          (views.get(t.id)?.text.toLowerCase().includes(words) ?? false),
      ),
    [inProject, words, views],
  )

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const section of SECTIONS) {
      const rows = visible
        .filter((t) => sectionOf(t) === section.key)
        .sort(
          (a, b) =>
            Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) ||
            (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) ||
            b.updatedAt - a.updatedAt,
        )
      if (rows.length === 0) continue
      out.push({
        kind: 'section',
        key: `__${section.key}`,
        title: section.title,
        count: rows.length,
        waiting: section.key === 'waiting',
      })
      for (const task of rows) out.push({ kind: 'task', key: task.id, task })
    }
    return out
  }, [visible])

  const place = (t: TaskSummary) =>
    shell.filter.kind === 'project'
      ? undefined
      : (projectNames.get(t.projectPath) ?? folder(t.projectPath))

  const startTask = () => {
    haptic.tap()
    router.push(
      shell.filter.kind === 'project'
        ? { pathname: '/start-task', params: { project: shell.filter.path } }
        : '/start-task',
    )
  }

  const menuItems: SheetItem[] = menu
    ? [
        { key: 'open', label: '打开', onPress: () => router.push(`/task/${menu.id}`) },
        {
          key: 'pin',
          label: menu.pinnedAt !== null ? '取消置顶' : '置顶',
          disabled: !connected,
          onPress: () => link && togglePin(link, menu),
        },
        menu.status === 'running'
          ? {
              key: 'cancel',
              label: '取消需求…',
              destructive: true,
              disabled: !connected,
              onPress: () => link && confirmCancel(link, menu),
            }
          : {
              key: 'delete',
              label: '删除…',
              destructive: true,
              disabled: !connected,
              onPress: () => link && confirmDelete(link, menu),
            },
      ]
    : []

  const top = (
    <View style={styles.top}>
      {props.switcher}
      {searching ? (
        <View style={[styles.searchBox, { backgroundColor: c.fill }]}>
          <Icon name="search" size={17} color={c.textSecondary} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="搜索需求、工作流"
            placeholderTextColor={c.textTertiary}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            style={[typeScale.body, styles.searchInput, { color: c.text }]}
          />
        </View>
      ) : (
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Press
            onPress={startTask}
            disabled={!connected}
            scale={false}
            highlight={c.fill}
            accessibilityRole="button"
            accessibilityHint="选一个工作流，写下需求，交给 Agent 一步步做"
            style={styles.action}
          >
            <Icon name="plus" size={22} color={connected ? c.tint : c.textTertiary} />
            <Text style={[typeScale.body, { color: connected ? c.tint : c.textTertiary }]}>
              开始一个需求
            </Text>
          </Press>
          <View style={[styles.line, { backgroundColor: c.border }]} />
          <Press
            onPress={() => router.push('/workflows')}
            scale={false}
            highlight={c.fill}
            accessibilityRole="button"
            style={styles.action}
          >
            <Icon name="flow" size={20} color={c.textSecondary} />
            <Text style={[typeScale.body, styles.flex, { color: c.text }]}>工作流</Text>
            <Icon name="chevronRight" size={13} color={c.textTertiary} weight="semibold" />
          </Press>
        </View>
      )}
    </View>
  )

  const empty = () => {
    if (!connected && !loaded) {
      return (
        <EmptyState
          icon="flow"
          title="连上电脑后才能看需求"
          message="Huli 正在连接你的电脑。"
          action={{ label: '立即重连', onPress: () => retry() }}
        />
      )
    }
    if (error && tasks.length === 0) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到需求"
          message={error}
          action={{ label: '重试', onPress: () => void reload() }}
        />
      )
    }
    if (!loaded) {
      return (
        <View style={styles.skeleton} accessibilityLabel="正在加载">
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width={30} height={30} radius={15} />
              <View style={styles.flexGap}>
                <Skeleton width={['64%', '48%', '72%', '56%'][i]} height={15} />
                <Skeleton width="40%" height={12} />
              </View>
            </View>
          ))}
        </View>
      )
    }
    if (words) return <EmptyState icon="search" title={`没有需求包含「${query.trim()}」`} />
    if (shell.filter.kind !== 'all' && tasks.length > 0) {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有需求"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="flow"
        title="还没有需求"
        message="选一个工作流，写下要做的事：每一步由一个 Agent 在自己的会话里做，要你拍板时会停下来等你。"
        action={connected ? { label: '开始一个需求', onPress: startTask } : undefined}
      />
    )
  }

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
    const t = item.task
    return (
      <TaskRow
        task={t}
        view={views.get(t.id)}
        projectName={place(t)}
        onPress={() => router.push(`/task/${t.id}`)}
        onLongPress={() => {
          haptic.tap()
          setMenu(t)
        }}
        start={
          connected
            ? {
                label: t.pinnedAt !== null ? '取消置顶' : '置顶',
                icon: t.pinnedAt !== null ? 'unpin' : 'pin',
                color: c.accent,
                onPress: () => link && togglePin(link, t),
              }
            : undefined
        }
        end={
          !connected
            ? undefined
            : t.status === 'running'
              ? {
                  label: '取消',
                  icon: 'stop',
                  color: c.danger,
                  onPress: () => link && confirmCancel(link, t),
                }
              : {
                  label: '删除',
                  icon: 'trash',
                  color: c.danger,
                  onPress: () => link && confirmDelete(link, t),
                }
        }
      />
    )
  }

  return (
    <Screen readable>
      <AnimatedFlashList
        ref={list}
        data={items}
        keyExtractor={itemKey}
        getItemType={itemType}
        renderItem={renderItem}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
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
              void reload().finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={top}
        ListEmptyComponent={empty()}
      />
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
      <Sheet
        visible={menu !== null}
        title={menu?.title}
        message={menu ? workflowTitle(menu, views.get(menu.id)) : undefined}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: space.lg, gap: space.md },
  pad: { paddingHorizontal: space.xl },
  flex: { flex: 1 },
  flexGap: { flex: 1, gap: space.sm },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.xl },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchInput: { flex: 1, paddingVertical: 0 },
  skeleton: { padding: space.xl, gap: space.xl },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
})

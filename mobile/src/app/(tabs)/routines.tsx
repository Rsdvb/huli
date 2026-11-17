// Routines: the prompts the computer sends on a schedule, with when each runs next and how its last
// run went. A routine opens its recent runs; a run opens its session.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { HostEvent, RoutineList } from '@shared/agent-host'
import type { RoutineView, RunPage, RunStatus, RunView, Schedule } from '@shared/routines'
import {
  FilterNote,
  inFilter,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { useHost } from '../../host'
import { duration, errorText, folder, listTime } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { BottomSheet } from '../../ui/BottomSheet'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'
import { LargeTitle } from '../../ui/LargeTitle'
import { Pill } from '../../ui/Pill'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { SkeletonRows } from '../../ui/Skeleton'
import {
  radius,
  space,
  TAB_BAR_CLEARANCE,
  type as typeScale,
  useTokens,
  type Palette,
} from '../../ui/tokens'

const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

function scheduleText(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once': {
      const [date, time] = schedule.at.split('T')
      const [, month, day] = (date ?? '').split('-')
      return `一次 · ${Number(month)}月${Number(day)}日 ${time ?? ''}`
    }
    case 'every':
      return schedule.minutes % 60 === 0
        ? `每 ${schedule.minutes / 60} 小时`
        : `每 ${schedule.minutes} 分钟`
    case 'weekly': {
      const days = [...schedule.days].sort()
      const key = days.join('')
      const when =
        days.length === 7
          ? '每天'
          : key === '12345'
            ? '工作日'
            : key === '06'
              ? '周末'
              : `每周${days.map((d) => DAY_NAMES[d]).join('、')}`
      return `${when} ${schedule.time}`
    }
    case 'cron':
      return `Cron · ${schedule.expression}`
  }
}

const RUN_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  starting: '正在开始',
  running: '运行中',
  waiting: '等你处理',
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已取消',
  interrupted: '已中断',
  skipped: '已跳过',
}

function runLook(c: Palette, status: RunStatus): { icon: IconName; color: string } {
  switch (status) {
    case 'succeeded':
      return { icon: 'succeeded', color: c.success }
    case 'failed':
    case 'timed_out':
      return { icon: 'failed', color: c.danger }
    case 'waiting':
      return { icon: 'warning', color: c.warning }
    case 'queued':
    case 'starting':
    case 'running':
      return { icon: 'timer', color: c.tint }
    default:
      return { icon: 'skipped', color: c.textTertiary }
  }
}

const STATE_TEXT: Record<RoutineView['state'], string> = {
  on: '已开启',
  off: '已关闭',
  done: '已完成',
  paused: '已暂停',
}

export default function Routines() {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<RoutineView>>(null)
  const [data, setData] = useState<RoutineList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const connected = host.state.kind === 'connected'
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  const load = useCallback(async () => {
    if (!host.link) return
    try {
      setData((await host.link.request('routines.list', undefined)) as RoutineList)
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [host.link])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  useEffect(() => {
    if (!host.link) return
    return host.link.onHostEvent((raw: unknown) => {
      const event = raw as HostEvent
      if (event.type === 'routine.changed') {
        setData((current) => {
          if (!current) return current
          const known = current.routines.some((r) => r.id === event.routine.id)
          return {
            ...current,
            routines: known
              ? current.routines.map((r) => (r.id === event.routine.id ? event.routine : r))
              : [...current.routines, event.routine],
          }
        })
      }
      if (event.type === 'routine.removed') {
        setData((current) =>
          current
            ? { ...current, routines: current.routines.filter((r) => r.id !== event.routineId) }
            : current,
        )
      }
    })
  }, [host.link])

  const projectNames = useMemo(
    () => new Map(host.projects.map((p) => [p.path, p.name])),
    [host.projects],
  )
  const visible = useMemo(() => {
    const rank = { on: 0, paused: 1, off: 2, done: 3 }
    return (data?.routines ?? [])
      .filter((r) =>
        inFilter(shell.filter, { scratch: r.projectPath === null, path: r.projectPath ?? '' }),
      )
      .sort(
        (a, b) =>
          rank[a.state] - rank[b.state] ||
          (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) ||
          a.name.localeCompare(b.name),
      )
  }, [data, shell.filter])

  const empty = () => {
    if (!connected && !data) return <EmptyState icon="history" title="连上电脑后才能看定时任务" />
    if (error && !data) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到定时任务"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!data) return <SkeletonRows count={5} />
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有定时任务"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="calendarClock"
        title="还没有定时任务"
        message="在电脑上的 Huli 里新建一个，它会按时把提示词发给智能体。"
      />
    )
  }

  const renderItem = ({ item }: { item: RoutineView }) => {
    const place =
      item.projectPath === null
        ? '无项目'
        : (projectNames.get(item.projectPath) ?? folder(item.projectPath))
    const run = item.activeRun ?? item.lastRun
    const look = run ? runLook(c, run.status) : null
    const quiet = item.state === 'off' || item.state === 'done'
    return (
      <Press
        onPress={() => setOpen(item.id)}
        scale={false}
        accessibilityRole="button"
        accessibilityHint="查看最近的运行"
        style={styles.row}
      >
        <View style={{ opacity: quiet ? 0.5 : 1 }}>
          <AgentAvatar
            agentId={item.agentId}
            name={host.agents.get(item.agentId)?.name}
            badge={item.activeRun ? 'live' : item.state === 'paused' ? 'waiting' : null}
          />
        </View>
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text
              style={[typeScale.rowTitle, styles.flex, { color: quiet ? c.textSecondary : c.text }]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            {item.state !== 'on' && (
              <Pill size="sm" label={STATE_TEXT[item.state]} color={c.textSecondary} />
            )}
          </View>
          <View style={styles.meta}>
            <Icon name="repeat" size={13} color={c.textTertiary} />
            <Text
              style={[typeScale.footnote, styles.tabular, { color: c.textSecondary }]}
              numberOfLines={1}
            >
              {scheduleText(item.trigger.schedule)}
            </Text>
            <Text
              style={[typeScale.footnote, styles.flex, { color: c.textTertiary }]}
              numberOfLines={1}
            >
              · {place}
            </Text>
          </View>
          <View style={styles.meta}>
            {run && look ? (
              <>
                <Icon name={look.icon} size={13} color={look.color} />
                <Text style={[typeScale.footnote, { color: look.color }]}>
                  {RUN_TEXT[run.status]}
                </Text>
                <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
                  {listTime(run.endedAt ?? run.startedAt ?? run.scheduledFor ?? item.updatedAt)}
                </Text>
              </>
            ) : (
              <Text style={[typeScale.footnote, { color: c.textTertiary }]}>还没有运行过</Text>
            )}
            {item.nextRunAt !== null && (
              <Text
                style={[typeScale.footnote, styles.next, { color: c.textTertiary }]}
                numberOfLines={1}
              >
                下次 {listTime(item.nextRunAt)}
              </Text>
            )}
          </View>
        </View>
      </Press>
    )
  }

  const shown = data?.routines.find((r) => r.id === open) ?? null

  return (
    <Screen>
      <Animated.FlatList
        ref={list}
        data={data ? visible : []}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        {...header.scrollProps}
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
              void load().finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.pad}>
            <LargeTitle title="定时任务" subtitle="电脑按时发给智能体的提示词。" />
            <FilterNote what="定时任务" />
            {data?.problem && (
              <View style={[styles.problem, { backgroundColor: c.removedBg }]}>
                <Icon name="warning" size={16} color={c.danger} />
                <Text style={[typeScale.footnote, styles.flex, { color: c.text }]}>
                  定时任务文件读不了：{data.problem.reason}
                </Text>
              </View>
            )}
            {visible.length > 0 && <SectionHeader title="全部" count={visible.length} />}
          </View>
        }
        ListEmptyComponent={<View style={styles.pad}>{empty()}</View>}
      />
      <TopBar header={header} />
      <BottomSheet
        visible={shown !== null}
        onClose={() => setOpen(null)}
        title={shown?.name}
        message={shown ? scheduleText(shown.trigger.schedule) : undefined}
      >
        {shown && <Runs routine={shown} onOpen={() => setOpen(null)} />}
      </BottomSheet>
    </Screen>
  )
}

function Runs(props: { routine: RoutineView; onOpen(): void }) {
  const { c } = useTokens()
  const { link } = useHost()
  const [page, setPage] = useState<RunPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!link) return
    let live = true
    link.request('routines.runs', { routineId: props.routine.id }).then(
      (answer) => live && setPage(answer as RunPage),
      (failure: unknown) => live && setError(errorText(failure)),
    )
    return () => {
      live = false
    }
  }, [link, props.routine.id])

  if (error)
    return <EmptyState tone="error" icon="warning" title="没能读到运行记录" message={error} />
  if (!page) return <ActivityIndicator color={c.textSecondary} style={styles.loading} />
  if (page.runs.length === 0) return <EmptyState icon="history" title="还没有运行过" />

  return (
    <View style={[styles.runs, { backgroundColor: c.fill }]}>
      {page.runs.slice(0, 20).map((run: RunView, i) => {
        const look = runLook(c, run.status)
        const when = run.startedAt ?? run.scheduledFor ?? run.endedAt
        const sessionId = run.sessionId
        const line = (
          <View style={styles.run}>
            <Icon name={look.icon} size={18} color={look.color} />
            <View style={styles.flex}>
              <Text style={[typeScale.callout, { color: c.text }]}>
                {RUN_TEXT[run.status]}
                {run.trigger === 'manual' ? ' · 手动' : run.trigger === 'catch-up' ? ' · 补跑' : ''}
              </Text>
              {run.error ? (
                <Text style={[typeScale.footnote, { color: c.danger }]} numberOfLines={2}>
                  {run.error.message}
                </Text>
              ) : null}
            </View>
            <View style={styles.runRight}>
              <Text style={[typeScale.footnote, styles.tabular, { color: c.textSecondary }]}>
                {when ? listTime(when) : '—'}
              </Text>
              {run.workingMs > 0 && (
                <Text style={[typeScale.caption, styles.tabular, { color: c.textTertiary }]}>
                  {duration(run.workingMs)}
                </Text>
              )}
            </View>
            {sessionId && (
              <Icon name="chevronRight" size={12} color={c.textTertiary} weight="semibold" />
            )}
          </View>
        )
        return (
          <View key={run.id}>
            {i > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
            {sessionId ? (
              <Press
                scale={false}
                accessibilityRole="button"
                onPress={() => {
                  props.onOpen()
                  router.push(`/session/${sessionId}`)
                }}
              >
                {line}
              </Press>
            ) : (
              line
            )}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  next: { marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  problem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    marginTop: space.md,
  },
  loading: { marginVertical: space.xxl },
  runs: { borderRadius: radius.lg, overflow: 'hidden' },
  run: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  runRight: { alignItems: 'flex-end', gap: 2 },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
})

// A routine's page: when it runs and what it may do, its switch, Run now (or Stop while a run
// works), its prompt, its runs (each opens its session), editing and deleting it.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { RoutineView, RunPage, RunSwitch, RunView } from '@shared/routines'
import { RoutineEditor, type EditorSeed } from '../../components/RoutineEditor'
import { useHost } from '../../host'
import {
  confirmDeleteRoutine,
  RUN_TEXT,
  runLook,
  scheduleText,
  scopeText,
  STATE_TEXT,
  useRoutineList,
  whenText,
} from '../../routines'
import { duration, errorText, folder, sessionTitle } from '../../sessions'
import { AgentGlyph } from '../../ui/AgentAvatar'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { LargeTitle } from '../../ui/LargeTitle'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { PendingSwitch } from '../../ui/PendingSwitch'
import { Pill } from '../../ui/Pill'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { usePullRefresh } from '../../ui/PullRefresh'
import { SectionHeader } from '../../ui/SectionHeader'
import { SkeletonRows } from '../../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

function stateLine(r: RoutineView): string {
  if (r.activeRun) return `${RUN_TEXT[r.activeRun.status]}`
  if (r.state === 'paused') return '已暂停：Agent 接近套餐限额'
  if (r.state === 'on' && r.nextRunAt !== null) return `下次运行 ${whenText(r.nextRunAt)}`
  return STATE_TEXT[r.state]
}

export default function RoutinePage() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(() => Promise.all([loadList(), loadRuns()]), header)
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { data, error: listError, load: loadList } = useRoutineList()
  const routine = data?.routines.find((r) => r.id === id) ?? null
  const [runs, setRuns] = useState<RunView[] | null>(null)
  const [older, setOlder] = useState<number | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seed, setSeed] = useState<EditorSeed | null>(null)
  const connected = host.state.kind === 'connected'
  const runKey = `${routine?.activeRun?.id ?? ''}:${routine?.activeRun?.status ?? ''}:${routine?.lastRun?.id ?? ''}`

  const loadRuns = useCallback(async () => {
    if (!host.link || !id) return
    try {
      const page = (await host.link.request('routines.runs', { routineId: id })) as RunPage
      setRuns(page.runs)
      setOlder(page.older)
      setRunsError(null)
    } catch (failure) {
      setRunsError(errorText(failure))
    }
  }, [host.link, id])

  useEffect(() => {
    if (connected) void loadRuns()
  }, [connected, loadRuns, runKey])

  useEffect(() => {
    if (connected && host.link && id) {
      void host.link.request('routines.markSeen', { routineId: id }).catch(() => {})
    }
  }, [connected, host.link, id, runKey])

  const loadOlder = async () => {
    if (!host.link || older === null || more) return
    setMore(true)
    try {
      const page = (await host.link.request('routines.runs', {
        routineId: id,
        before: older,
      })) as RunPage
      setRuns((list) => [...(list ?? []), ...page.runs])
      setOlder(page.older)
    } catch (failure) {
      Alert.alert('没能读到更早的运行', errorText(failure))
    } finally {
      setMore(false)
    }
  }

  if (!routine) {
    return (
      <Screen>
        <View style={[styles.missing, { paddingTop: header.height + space.xl }]}>
          {!data && !listError && !connected ? (
            <EmptyState
              icon="wifi"
              title="打不开这个定时任务"
              message="它所在的电脑没有连上，连上后会再显示。"
              action={{ label: '立即重连', onPress: () => host.retry() }}
            />
          ) : !data && !listError ? (
            <SkeletonRows count={4} />
          ) : listError && !data ? (
            <EmptyState
              tone="error"
              icon="warning"
              title="没能读到定时任务"
              message={listError}
              action={{ label: '重试', onPress: () => void loadList() }}
            />
          ) : (
            <EmptyState
              icon="history"
              title="这个定时任务已经删除了"
              action={{ label: '返回', onPress: () => router.back() }}
            />
          )}
        </View>
        <NavBar header={header} title="定时任务" titleAlways />
      </Screen>
    )
  }

  const agent = host.agents.get(routine.agentId)
  const place =
    routine.projectPath === null
      ? '无项目'
      : (host.projects.find((p) => p.path === routine.projectPath)?.name ??
        folder(routine.projectPath))
  const active = routine.activeRun

  const runNow = async () => {
    if (!host.link) return
    haptic.tap()
    setBusy(true)
    try {
      await host.link.request('routines.runNow', { routineId: routine.id })
      haptic.success()
    } catch (failure) {
      haptic.warning()
      Alert.alert('没能开始运行', errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    if (!host.link || !active) return
    haptic.warning()
    Alert.alert('停止这次运行？', '它的会话会停下，结果留在运行记录里。', [
      { text: '取消', style: 'cancel' },
      {
        text: '停止',
        style: 'destructive',
        onPress: () => {
          host.link
            ?.request('routines.cancelRun', { runId: active.id })
            .catch((failure: unknown) => Alert.alert('没能停止', errorText(failure)))
        },
      },
    ])
  }

  const toggle = async (enabled: boolean): Promise<boolean> => {
    if (!host.link) return false
    haptic.select()
    try {
      await host.link.request('routines.update', { routineId: routine.id, changes: { enabled } })
      return true
    } catch (failure) {
      Alert.alert(enabled ? '没能开启' : '没能关闭', errorText(failure))
      return false
    }
  }

  // Which agent ran it in place of the routine's, and why.
  const switchText = ({ from, to, reason }: RunSwitch): string => {
    const name = (id: string) => host.agents.get(id)?.name ?? id
    return reason === 'plan_limit'
      ? `${name(from)} 额度已用完，换成 ${name(to)} 运行`
      : `${name(from)} 运行中额度用完，换成 ${name(to)} 继续`
  }

  const runRow = (run: RunView, i: number) => {
    const look = runLook(c, run.status)
    const when = run.startedAt ?? run.scheduledFor ?? run.endedAt
    const sessionId = run.sessionId
    const title = run.session ? sessionTitle(run.session) : null
    const line = (
      <View style={styles.run}>
        <Icon name={look.icon} size={20} color={look.color} />
        <View style={styles.flex}>
          <Text style={[typeScale.callout, { color: c.text }]}>
            {RUN_TEXT[run.status]}
            {run.trigger === 'manual' ? ' · 手动' : run.trigger === 'catch-up' ? ' · 补跑' : ''}
            {run.count > 1 ? ` · ${run.count} 次合并` : ''}
          </Text>
          {run.error ? (
            <Text style={[typeScale.footnote, { color: c.danger }]} numberOfLines={2}>
              {run.error.message}
            </Text>
          ) : run.reason ? (
            <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
              {run.reason === 'overlap' ? '上一次还没结束' : '接近套餐限额'}
            </Text>
          ) : title ? (
            <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {run.switched ? (
            <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={2}>
              {switchText(run.switched)}
            </Text>
          ) : null}
        </View>
        <View style={styles.runRight}>
          <Text style={[typeScale.footnote, styles.tabular, { color: c.textSecondary }]}>
            {when ? whenText(when) : '—'}
          </Text>
          {run.workingMs > 0 && (
            <Text style={[typeScale.caption, styles.tabular, { color: c.textTertiary }]}>
              {duration(run.workingMs)}
            </Text>
          )}
        </View>
        {sessionId ? (
          <Icon name="chevronRight" size={12} color={c.textTertiary} weight="semibold" />
        ) : null}
      </View>
    )
    return (
      <View key={run.id}>
        {i > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
        {sessionId ? (
          <Press
            scale={false}
            accessibilityRole="button"
            accessibilityHint="打开这次运行的会话"
            onPress={() => router.push(`/session/${sessionId}`)}
          >
            {line}
          </Press>
        ) : (
          line
        )}
      </View>
    )
  }

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xl,
        }}
        refreshControl={pull}
      >
        <View style={styles.titlePad}>
          <LargeTitle title={routine.name} subtitle={stateLine(routine)} />
        </View>

        <View style={styles.actions}>
          {active ? (
            <Pill
              tone="fill"
              size="lg"
              label="停止运行"
              color={c.danger}
              leading={<Icon name="stop" size={16} color={c.danger} />}
              disabled={!connected}
              onPress={stop}
            />
          ) : (
            <Pill
              tone="accent"
              size="lg"
              label={busy ? '正在开始…' : '立即运行'}
              leading={<Icon name="play" size={16} color={c.onAccent} />}
              disabled={!connected || busy}
              onPress={() => void runNow()}
            />
          )}
        </View>

        <ListGroup>
          <ListRow
            title="开启"
            trailing={
              <PendingSwitch
                value={routine.enabled}
                disabled={!connected}
                onChange={toggle}
                accessibilityLabel="开启这个定时任务"
              />
            }
          />
          <ListRow title="计划" value={scheduleText(routine.trigger.schedule)} />
          <ListRow
            title="Agent"
            value={agent?.name ?? routine.agentId}
            trailing={<AgentGlyph agentId={routine.agentId} name={agent?.name} size={16} />}
          />
          <ListRow title="项目" value={place} />
          <ListRow title="权限" value={scopeText(routine.scope)} />
          <ListRow title="时间限制" value={`${routine.timeLimitMinutes} 分钟`} />
        </ListGroup>

        <View style={[styles.prompt, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[typeScale.footnote, { color: c.textSecondary }]}>提示词</Text>
          <Text selectable style={[typeScale.body, { color: c.text }]}>
            {routine.prompt}
          </Text>
        </View>

        <View>
          <SectionHeader title="运行记录" count={routine.runs} />
          {runsError && !runs ? (
            <EmptyState
              tone="error"
              icon="warning"
              title="没能读到运行记录"
              message={runsError}
              action={{ label: '重试', onPress: () => void loadRuns() }}
            />
          ) : !runs ? (
            <ActivityIndicator color={c.textSecondary} style={styles.loading} />
          ) : runs.length === 0 ? (
            <EmptyState
              icon="history"
              title="还没有运行过"
              message="立即运行可以先试一次。"
              action={
                connected && !active
                  ? { label: '立即运行', onPress: () => void runNow() }
                  : undefined
              }
            />
          ) : (
            <View style={[styles.runs, { backgroundColor: c.surface, borderColor: c.border }]}>
              {runs.map(runRow)}
              {older !== null ? (
                <>
                  <View style={[styles.line, { backgroundColor: c.border }]} />
                  <Press onPress={() => void loadOlder()} scale={false} style={styles.more}>
                    {more ? (
                      <ActivityIndicator color={c.textSecondary} />
                    ) : (
                      <Text style={[typeScale.callout, { color: c.tint }]}>显示更早的运行</Text>
                    )}
                  </Press>
                </>
              ) : null}
            </View>
          )}
        </View>

        <ListGroup>
          <ListRow
            title="删除定时任务"
            destructive
            disabled={!connected}
            leading={<Icon name="trash" size={18} color={c.danger} />}
            onPress={() =>
              host.link &&
              confirmDeleteRoutine(
                (m, p) => host.link!.request(m, p),
                routine,
                () => router.back(),
              )
            }
          />
        </ListGroup>
      </Animated.ScrollView>
      <NavBar
        header={header}
        title={routine.name}
        right={
          <IconButton
            icon="pencil"
            label="编辑"
            size={44}
            iconSize={18}
            disabled={!connected}
            onPress={() =>
              setSeed({
                name: routine.name,
                prompt: routine.prompt,
                schedule: routine.trigger.schedule,
                scope: routine.scope,
                onLimit: routine.onLimit,
                agentId: routine.agentId,
                projectPath: routine.projectPath,
              })
            }
          />
        }
      />
      <RoutineEditor seed={seed} routine={routine} onClose={() => setSeed(null)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  missing: { paddingHorizontal: space.xl },
  titlePad: { paddingHorizontal: space.xs },
  actions: { flexDirection: 'row', gap: space.md },
  prompt: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
  },
  loading: { marginVertical: space.xxl },
  runs: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  run: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  runRight: { alignItems: 'flex-end', gap: 2 },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  more: { alignItems: 'center', paddingVertical: space.md },
})

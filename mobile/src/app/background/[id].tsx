// Huli: 后台任务, a session's background processes as the desktop's board lists them: what holds
// up the turn, which can go to the background, the commands and watchers that run with their
// process, CPU, memory and ports, and those that ended. Read when the page opens, on a pull and
// after an action here, never on a timer.

import { memo, useCallback, useEffect, useState, type ReactElement } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { SessionProcesses, TaskProcess } from '@shared/task-processes'
import type { BackgroundTaskView, ForegroundTaskView, WorkflowView } from '@shared/thread'
import { lastPort, type PortBlock } from '@shared/worktree-ports'
import { call, errorText } from '../../git'
import { useHostState, useLink, useSession } from '../../host'
import { sessionTitle } from '../../sessions'
import { durationText } from '../../ui/session/work'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { useSecond } from '../../ui/session/now'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { StateView } from '../../ui/session/StateView'

type Link = ReturnType<typeof useLink>

function memoryText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function statsText(stats: TaskProcess | undefined): string | null {
  if (!stats) return null
  const parts = [
    stats.pid !== null ? `PID ${stats.pid}` : null,
    stats.cpu !== null ? `CPU ${stats.cpu.toFixed(stats.cpu < 10 ? 1 : 0)}%` : null,
    stats.memory !== null ? memoryText(stats.memory) : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

export default function BackgroundScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c, s } = useSessionTokens()
  const link = useLink()
  const state = useHostState()
  const summary = useSession(id)
  const [data, setData] = useState<SessionProcesses | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [acting, setActing] = useState(false)
  const connected = state.kind === 'connected'

  const load = useCallback(async () => {
    try {
      setData(await call(link, 'sessions.processes', { sessionId: id }))
      setError(null)
    } catch (failed) {
      setError(errorText(failed, '没能读取这个会话的后台任务。'))
    }
  }, [link, id])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  const refresh = () => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }

  /** Runs an action, says why it failed, and reads the list again. */
  const act = useCallback(
    (run: () => Promise<unknown>, failure: string) => {
      setActing(true)
      run()
        .catch((failed: unknown) => Alert.alert(failure, errorText(failed, failure)))
        .finally(() => {
          setActing(false)
          void load()
        })
    },
    [load],
  )

  const clean = () => {
    if (!data?.clean) return
    if (data.clean === 'all') {
      Alert.alert('全部停止？', '这个会话的后台终端都会被结束。', [
        { text: '取消', style: 'cancel' },
        {
          text: '全部停止',
          style: 'destructive',
          onPress: () =>
            act(() => call(link, 'sessions.cleanTasks', { sessionId: id }), '没能全部停止'),
        },
      ])
      return
    }
    act(() => call(link, 'sessions.cleanTasks', { sessionId: id }), '没能清除')
  }

  let body: ReactElement
  if (!data) {
    body = error ? (
      <StateView text={error} tone="danger" retry={() => void load()} />
    ) : connected ? (
      <StateView loading />
    ) : (
      <StateView text="连上电脑后才能看到这个会话的后台任务。" icon={G.wifiOff} />
    )
  } else {
    const stats = new Map(data.processes.map((item) => [item.taskId, item]))
    const running = data.listed.filter((task) => task.status === 'running')
    const ended = data.listed.filter((task) => task.status !== 'running')
    const nothing = running.length === 0 && ended.length === 0 && data.held.length === 0
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.textSecondary} />
        }
      >
        {[error, data.error ?? null].filter(Boolean).map((note) => (
          <Text key={note} style={[styles.note, { color: c.textSecondary }]}>
            {note}
          </Text>
        ))}
        {data.block && data.taken.length > 0 ? (
          <View style={[styles.notice, { backgroundColor: s.warningSoft }]}>
            <Icon icon={G.warning} size={15} color={c.warning} />
            <Text style={[styles.noticeText, { color: c.text }]}>
              {`本会话端口段（${data.block.first}–${lastPort(data.block)}）里的 ${data.taken
                .map((item) =>
                  item.process ? `:${item.port}（${item.process}）` : `:${item.port}`,
                )
                .join('、')} 被会话外的程序占用`}
            </Text>
          </View>
        ) : null}
        {nothing ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            这个会话没有后台任务。Agent 在后台启动的开发服务器、监听和命令会出现在这里。
          </Text>
        ) : null}
        {data.held.length > 0 ? (
          <Text style={[styles.label, { color: c.textTertiary }]}>占着这一轮</Text>
        ) : null}
        {data.held.map((task) => (
          <HeldRow
            key={task.toolCallId}
            task={task}
            disabled={acting}
            onMove={() =>
              act(
                () =>
                  call(link, 'sessions.toBackground', {
                    sessionId: id,
                    toolCallId: task.toolCallId,
                  }),
                '没能转到后台',
              )
            }
          />
        ))}
        {running.length > 0 ? (
          <Text style={[styles.label, { color: c.textTertiary }]}>运行中</Text>
        ) : null}
        {running.map((task) => (
          <TaskRow
            key={task.id}
            link={link}
            sessionId={id}
            task={task}
            stats={stats.get(task.id)}
            block={data.block}
            disabled={acting}
            onStop={() =>
              act(
                () => call(link, 'sessions.stopTask', { sessionId: id, taskId: task.id }),
                '没能停止',
              )
            }
          />
        ))}
        {ended.length > 0 ? (
          <Text style={[styles.label, { color: c.textTertiary }]}>已结束</Text>
        ) : null}
        {ended.map((task) => (
          <TaskRow
            key={task.id}
            link={link}
            sessionId={id}
            task={task}
            stats={undefined}
            block={data.block}
            disabled={acting}
            onStop={null}
          />
        ))}
        {(data.clean === 'ended' && ended.length > 0) ||
        (data.clean === 'all' && running.length > 0) ? (
          <Pressable
            onPress={clean}
            disabled={acting}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.clean,
              { backgroundColor: c.fill, opacity: pressed || acting ? 0.6 : 1 },
            ]}
          >
            <Text
              style={[
                styles.cleanText,
                { color: data.clean === 'all' ? c.danger : c.textSecondary },
              ]}
            >
              {data.clean === 'all' ? '全部停止' : '清除已结束'}
            </Text>
          </Pressable>
        ) : null}
        <Text style={[styles.footnote, { color: c.textTertiary }]}>
          CPU、内存和端口在打开这页和下拉时读取。
        </Text>
      </ScrollView>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="后台任务" subtitle={summary ? sessionTitle(summary) : null} />
      {body}
    </View>
  )
}

function Since(props: { at: number; color: string }) {
  const now = useSecond()
  return (
    <Text style={[styles.time, { color: props.color }]}>
      {durationText(Math.max(0, now - props.at))}
    </Text>
  )
}

const HeldRow = memo(function HeldRow(props: {
  task: ForegroundTaskView
  disabled: boolean
  onMove(): void
}) {
  const { c, s } = useSessionTokens()
  const { task } = props
  return (
    <View style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      <View style={styles.head}>
        <Icon
          icon={task.kind === 'subagent' ? G.subagent : G.terminal}
          size={15}
          color={c.textSecondary}
        />
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {task.title}
        </Text>
        <Since at={task.startedAt} color={c.textTertiary} />
      </View>
      <View style={styles.actions}>
        <Text style={[styles.meta, { flex: 1, color: c.textTertiary }]}>
          在前台运行，这一轮在等它
        </Text>
        <Pressable
          onPress={props.onMove}
          disabled={props.disabled}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: s.accentSoft, opacity: pressed || props.disabled ? 0.6 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: c.accent }]}>转到后台</Text>
        </Pressable>
      </View>
    </View>
  )
})

const TaskRow = memo(function TaskRow(props: {
  link: Link
  sessionId: string
  task: BackgroundTaskView
  stats: TaskProcess | undefined
  block: PortBlock | null
  disabled: boolean
  onStop: (() => void) | null
}) {
  const { c, s } = useSessionTokens()
  const { task, stats, block } = props
  const [open, setOpen] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const read = useCallback(() => {
    setReading(true)
    call(props.link, 'sessions.taskOutput', { sessionId: props.sessionId, taskId: task.id })
      .then((answer) => setOutput(answer.output))
      .catch((failed: unknown) => setOutput(errorText(failed, '没能读取输出。')))
      .finally(() => setReading(false))
  }, [props.link, props.sessionId, task.id])
  const toggle = () => {
    if (!open && output === null) read()
    setOpen(!open)
  }
  const running = task.status === 'running'
  const state =
    task.status === 'failed'
      ? '失败'
      : task.status === 'stopped'
        ? '已停止'
        : running
          ? null
          : '已完成'
  const facts = statsText(stats)
  const range = block ? `${block.first}–${lastPort(block)}` : ''
  return (
    <View style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      <View style={styles.head}>
        <Icon
          icon={
            task.kind === 'monitor'
              ? G.eye
              : task.kind === 'workflow' && running
                ? G.layers
                : running
                  ? G.terminal
                  : task.status === 'failed'
                    ? G.failed
                    : G.done
          }
          size={15}
          color={task.status === 'failed' ? c.danger : c.textSecondary}
        />
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {task.title}
        </Text>
        {running ? (
          <Since at={task.startedAt} color={c.textTertiary} />
        ) : (
          <Text
            style={[styles.time, { color: task.status === 'failed' ? c.danger : c.textTertiary }]}
          >
            {state}
          </Text>
        )}
      </View>
      {task.command ? (
        <Text
          style={[styles.command, { color: c.textSecondary }]}
          numberOfLines={open ? undefined : 1}
        >
          {task.command}
        </Text>
      ) : null}
      {running && task.progress ? (
        <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
          {task.progress}
        </Text>
      ) : null}
      {task.workflow ? <WorkflowAgents view={task.workflow} /> : null}
      {facts || (stats && stats.ports.length > 0) ? (
        <View style={styles.stats}>
          {facts ? <Text style={[styles.meta, { color: c.textTertiary }]}>{facts}</Text> : null}
          {stats?.ports.map((item) => (
            <Text
              key={item.port}
              accessibilityLabel={
                item.collides
                  ? `端口 ${item.port} 不在本会话的端口段（${range}）内，且落在另一个会话的端口段里`
                  : item.outside
                    ? `端口 ${item.port} 不在本会话的端口段（${range}）内`
                    : `监听端口 ${item.port}`
              }
              style={[
                styles.port,
                item.collides
                  ? { color: c.danger, backgroundColor: s.dangerSoft }
                  : item.outside
                    ? { color: c.warning, backgroundColor: s.warningSoft }
                    : { color: c.textSecondary, backgroundColor: c.fill },
              ]}
            >
              {item.outside || item.collides ? `⚠ :${item.port}` : `:${item.port}`}
            </Text>
          ))}
        </View>
      ) : null}
      {stats?.ports.some((item) => item.outside) ? (
        <Text
          style={[styles.meta, { color: c.warning }]}
        >{`有端口不在本会话的端口段（${range}）内`}</Text>
      ) : null}
      {!running && task.summary ? (
        <Text style={[styles.meta, { color: c.textTertiary }]} numberOfLines={2}>
          {task.summary}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {task.kind === 'workflow' ? null : (
          <Pressable onPress={toggle} accessibilityRole="button" style={styles.link}>
            <Text style={[styles.linkText, { color: c.accent }]}>
              {open ? '收起输出' : '查看输出'}
            </Text>
          </Pressable>
        )}
        {open ? (
          <Pressable
            onPress={read}
            disabled={reading}
            accessibilityRole="button"
            style={styles.link}
          >
            <Text style={[styles.linkText, { color: c.textSecondary }]}>
              {reading ? '读取中…' : '刷新'}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        {props.onStop ? (
          <Pressable
            onPress={props.onStop}
            disabled={props.disabled}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: s.dangerSoft, opacity: pressed || props.disabled ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.buttonText, { color: c.danger }]}>停止</Text>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <ScrollView style={[styles.output, { backgroundColor: c.fill }]} nestedScrollEnabled>
          <Text selectable style={[styles.outputText, { color: c.textSecondary }]}>
            {output === null ? '读取中…' : output === '' ? '还没有输出。' : output}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
})

const AGENT_STATE = {
  queued: '排队中',
  running: '进行中',
  done: '完成',
  failed: '失败',
  stopped: '已停止',
} as const

/**
 * A workflow's agents as the board lists them, by phase: each phase with how many of its agents
 * finished, each agent with how it stands and, at work, what it does; read with the list.
 */
const WorkflowAgents = memo(function WorkflowAgents(props: { view: WorkflowView }) {
  const { c } = useSessionTokens()
  const { phases, agents } = props.view
  if (agents.length === 0) {
    return <Text style={[styles.meta, { color: c.textTertiary }]}>还没有子智能体开始。</Text>
  }
  const known = new Set(phases.map((phase) => phase.index))
  const groups = [
    ...phases.map((phase) => ({
      key: String(phase.index),
      title: phase.title as string | null,
      agents: agents.filter((agent) => agent.phase === phase.index),
    })),
    {
      key: 'loose',
      title: phases.length > 0 ? '其他' : null,
      agents: agents.filter((agent) => agent.phase === null || !known.has(agent.phase)),
    },
  ].filter((group) => group.agents.length > 0)
  return (
    <View style={styles.agents}>
      {groups.map((group) => {
        const done = group.agents.filter((agent) => agent.state === 'done').length
        const failed = group.agents.filter((agent) => agent.state === 'failed').length
        return (
          <View key={group.key} style={styles.phase}>
            {group.title !== null ? (
              <Text style={[styles.phaseTitle, { color: c.textSecondary }]} numberOfLines={1}>
                {`${group.title} ${done}/${group.agents.length}`}
                {failed > 0 ? (
                  <Text style={{ color: c.danger }}>{` · ${failed} 个失败`}</Text>
                ) : null}
              </Text>
            ) : null}
            {group.agents.map((agent) => (
              <View key={agent.index} style={styles.agent}>
                <View style={styles.head}>
                  <Icon
                    icon={
                      agent.state === 'done'
                        ? G.done
                        : agent.state === 'failed'
                          ? G.failed
                          : agent.state === 'running'
                            ? G.doing
                            : agent.state === 'stopped'
                              ? G.stopOutline
                              : G.todo
                    }
                    size={13}
                    color={agent.state === 'failed' ? c.danger : c.textTertiary}
                  />
                  <Text style={[styles.agentName, { color: c.text }]} numberOfLines={1}>
                    {agent.label}
                  </Text>
                  <Text
                    style={[
                      styles.time,
                      { color: agent.state === 'failed' ? c.danger : c.textTertiary },
                    ]}
                  >
                    {agent.durationMs !== null && agent.state === 'done'
                      ? durationText(agent.durationMs)
                      : AGENT_STATE[agent.state]}
                  </Text>
                </View>
                {agent.state === 'running' && agent.progress ? (
                  <Text style={[styles.agentWhat, { color: c.textSecondary }]} numberOfLines={1}>
                    {agent.progress}
                  </Text>
                ) : null}
                {agent.state === 'failed' && agent.error ? (
                  <Text style={[styles.agentWhat, { color: c.danger }]} numberOfLines={2}>
                    {agent.error}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )
      })}
    </View>
  )
})

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  label: { fontSize: 13, fontWeight: '600', paddingTop: 8 },
  note: { fontSize: 13, lineHeight: 18 },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  row: {
    gap: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: '500' },
  time: { fontSize: 12.5, fontVariant: ['tabular-nums'] },
  command: { fontFamily: MONO, fontSize: 12.5, lineHeight: 17 },
  meta: { fontSize: 12.5, lineHeight: 17 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  port: {
    fontFamily: MONO,
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 2 },
  link: { paddingVertical: 4 },
  linkText: { fontSize: 13.5, fontWeight: '500' },
  button: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 6 },
  buttonText: { fontSize: 13.5, fontWeight: '600' },
  output: { maxHeight: 220, borderRadius: 10, padding: 10 },
  outputText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  clean: { alignItems: 'center', borderRadius: 12, paddingVertical: 12, marginTop: 6 },
  cleanText: { fontSize: 15, fontWeight: '500' },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: 24, textAlign: 'center' },
  footnote: { fontSize: 12, lineHeight: 17, paddingTop: 6 },
  agents: { gap: 8, paddingTop: 2 },
  phase: { gap: 4 },
  phaseTitle: { fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  agent: { gap: 1, paddingLeft: 2 },
  agentName: { flex: 1, fontSize: 13.5 },
  agentWhat: { fontSize: 12, lineHeight: 16, paddingLeft: 21 },
})

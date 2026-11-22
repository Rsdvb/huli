// Huli: a manager session's workers on the phone: the requests they wait on, answered here, then
// each worker with its role, agent, state, review round and last report line, and 暂停 and
// 全部停止 at the foot. It reads the session list, and a worker's requests only while it waits.

import { memo, useEffect, useMemo, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { CardButton } from '../../components/entries/kit'
import { managerLine } from '../../components/ManagerBanner'
import { call } from '../../git'
import { useAgents, useLink, useSessions } from '../../host'
import { errorText, sessionTitle } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { haptic } from '../../ui/session/feedback'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { PressScale } from '../../ui/session/Press'
import { StateView } from '../../ui/session/StateView'

const ROLE: Record<string, string> = {
  implement: '写代码',
  review: '审阅',
  plan: '规划调研',
  other: '杂活',
}

function stateOf(s: SessionSummary): {
  text: string
  tone: 'warning' | 'accent' | 'danger' | 'success' | 'plain'
} {
  if (s.permissionCount > 0) return { text: '等你批准', tone: 'warning' }
  if (s.status === 'starting' || s.status === 'running' || s.status === 'awaiting_permission') {
    return { text: '运行中', tone: 'accent' }
  }
  const report = s.worker?.status
  if (
    s.status === 'failed' ||
    report === 'failed' ||
    report === 'blocked' ||
    report === 'needs_user'
  ) {
    return { text: '失败', tone: 'danger' }
  }
  if (report === 'stopped' || report === 'interrupted') return { text: '停止了', tone: 'plain' }
  if (report === 'done') return { text: '完成', tone: 'success' }
  return { text: '空闲', tone: 'plain' }
}

export default function WorkersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  const sessions = useSessions()
  const link = useLink()
  const manager = sessions.get(id)
  const [busy, setBusy] = useState<'pause' | 'stop' | null>(null)
  const workers = useMemo(
    () =>
      [...sessions.values()]
        .filter((s) => s.worker?.managerId === id && s.archivedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt),
    [sessions, id],
  )
  const waiting = workers.filter((w) => w.permissionCount > 0)
  const info = manager?.manager

  const act = (kind: 'pause' | 'stop') => {
    if (!info) return
    haptic.firm()
    setBusy(kind)
    const request =
      kind === 'stop'
        ? call(link, 'manager.stopAll', { sessionId: id })
        : call(link, 'manager.pause', { sessionId: id, paused: !info.paused })
    request
      .catch((error: unknown) =>
        Alert.alert(kind === 'stop' ? '没能全部停止' : '没能暂停', errorText(error)),
      )
      .finally(() => setBusy(null))
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title="工人"
        subtitle={
          info
            ? `回合 ${info.turns}/${info.maxTurns} · ${Math.round(info.tokens / 1000)}k 令牌`
            : sessionTitle(manager)
        }
      />
      {!manager ? (
        <StateView loading />
      ) : !info ? (
        <StateView text="这不是总管会话。" icon={G.subagent} />
      ) : (
        <>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 10 }}>
            <Text style={[styles.line, { color: c.textSecondary }]}>{managerLine(info)}</Text>
            {waiting.length > 0 && (
              <Text style={[styles.section, { color: c.textSecondary }]}>等你批准</Text>
            )}
            {waiting.map((worker) => (
              <WorkerRequests key={worker.id} worker={worker} />
            ))}
            <Text style={[styles.section, { color: c.textSecondary }]}>工人</Text>
            {workers.length === 0 ? (
              <Text style={[styles.line, { color: c.textSecondary }]}>还没有派出工人。</Text>
            ) : (
              workers.map((worker) => <WorkerRow key={worker.id} worker={worker} />)
            )}
          </ScrollView>
          <View style={[styles.foot, { borderTopColor: c.border }]}>
            <CardButton
              label={info.paused ? '继续' : '暂停'}
              busy={busy === 'pause'}
              onPress={() => act('pause')}
            />
            <View style={{ flex: 1 }} />
            <CardButton
              label="全部停止"
              tone="danger"
              busy={busy === 'stop'}
              onPress={() => act('stop')}
            />
          </View>
        </>
      )}
    </View>
  )
}

const WorkerRow = memo(function WorkerRow({ worker }: { worker: SessionSummary }) {
  const { c } = useSessionTokens()
  const agents = useAgents()
  const info = worker.worker!
  const state = stateOf(worker)
  const color =
    state.tone === 'warning'
      ? c.warning
      : state.tone === 'accent'
        ? c.accent
        : state.tone === 'danger'
          ? c.danger
          : state.tone === 'success'
            ? c.success
            : c.textSecondary
  const loop =
    info.reviewOf && info.loop === 'fixing'
      ? `等对方修改 · 第 ${info.round} 轮`
      : info.loop === 'reviewing'
        ? `审阅中 · 第 ${info.round} 轮`
        : info.loop === 'fixing'
          ? `按审阅意见修改 · 第 ${info.round} 轮`
          : info.loop === 'approved'
            ? `审阅通过（第 ${info.round} 轮）`
            : info.loop === 'out_of_rounds'
              ? '审阅到轮数上限仍未通过'
              : null
  return (
    <PressScale
      scale={0.98}
      onPress={() => router.push(`/session/${worker.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${info.name}，${state.text}`}
      style={[styles.row, info.reviewOf ? { marginLeft: 22 } : null]}
    >
      <AgentAvatar agentId={worker.agentId} size={32} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
            {info.name}
            <Text style={{ color: c.textSecondary, fontWeight: '400' }}>
              {' '}
              · {ROLE[info.kind] ?? info.kind}
            </Text>
          </Text>
          <Text style={[styles.state, { color }]}>{info.detached ? '你接管了' : state.text}</Text>
        </View>
        <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
          {[info.title || sessionTitle(worker), agents.get(worker.agentId)?.name, worker.model]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {loop && <Text style={[styles.meta, { color: c.accent }]}>{loop}</Text>}
        {info.line && (
          <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={2}>
            “{info.line}”
          </Text>
        )}
      </View>
    </PressScale>
  )
})

/** A worker's waiting requests, each with its one-time answers. */
function WorkerRequests({ worker }: { worker: SessionSummary }) {
  const { c, s } = useSessionTokens()
  const link = useLink()
  const [entries, setEntries] = useState<ToolEntry[]>([])
  const [answering, setAnswering] = useState<string | null>(null)
  const { id, permissionCount } = worker
  useEffect(() => {
    let live = true
    call(link, 'sessions.requests', { sessionId: id })
      .then(({ entries: all }) => {
        if (live) {
          setEntries(
            all.filter(
              (entry: ThreadEntry): entry is ToolEntry =>
                entry.kind === 'tool' && !!entry.permission,
            ),
          )
        }
      })
      .catch(() => live && setEntries([]))
    return () => {
      live = false
    }
  }, [link, id, permissionCount])
  const answer = (entry: ToolEntry, kind: 'allow_once' | 'reject_once') => {
    const permission = entry.permission
    const option = permission?.options.find((o) => o.kind === kind)
    if (!permission || !option) {
      router.push(`/session/${id}`)
      return
    }
    haptic.tap()
    setAnswering(entry.id)
    call(link, 'permissions.respond', {
      sessionId: id,
      requestId: permission.requestId,
      optionId: option.id,
    })
      .catch((error: unknown) => Alert.alert('没能回答', errorText(error)))
      .finally(() => setAnswering(null))
  }
  return (
    <>
      {entries.map((entry) => (
        <View
          key={entry.id}
          style={[styles.ask, { backgroundColor: s.dockCard, borderColor: c.borderStrong }]}
        >
          <Text style={[styles.name, { color: c.text }]}>{worker.worker?.name} 想要</Text>
          <Text style={[styles.command, { color: c.text }]} numberOfLines={3}>
            {(entry.rawInput ?? entry.title).split('\n')[0]}
          </Text>
          {entry.permission?.risk && (
            <Text
              style={[
                styles.meta,
                { color: entry.permission.risk.level === 'low' ? c.textSecondary : c.warning },
              ]}
            >
              {entry.permission.risk.level === 'low'
                ? '低风险'
                : entry.permission.risk.level === 'medium'
                  ? '中风险'
                  : '高风险'}
              {' · '}
              {entry.permission.risk.reason}
            </Text>
          )}
          <View style={styles.askButtons}>
            <CardButton
              label="拒绝"
              tone="danger"
              disabled={answering !== null}
              onPress={() => answer(entry, 'reject_once')}
            />
            <CardButton
              label="允许一次"
              tone="primary"
              busy={answering === entry.id}
              disabled={answering !== null}
              onPress={() => answer(entry, 'allow_once')}
            />
          </View>
        </View>
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  line: { fontSize: 14, lineHeight: 20, paddingTop: 6 },
  section: { fontSize: 15, fontWeight: '500', paddingTop: 12 },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  state: { fontSize: 13.5, fontWeight: '500' },
  meta: { fontSize: 13.5, lineHeight: 19 },
  ask: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 12, gap: 6 },
  command: { fontSize: 14, fontFamily: 'Menlo', lineHeight: 19 },
  askButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, paddingTop: 4 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
})

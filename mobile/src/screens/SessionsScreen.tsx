// Every session on the computer, the ones that need the user first, kept current by the host's
// events while the link is up.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { AgentStatus, HostEvent, SessionSummary } from '@shared/agent-host'
import type { LinkState } from '@shared/remote/link'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { linkTo } from '../connection'
import type { SavedHost } from '../store'
import { useTheme, type Theme } from '../theme'

function needsYou(s: SessionSummary): boolean {
  return s.status === 'awaiting_permission' || s.permissionCount > 0 || s.attention === 'permission'
}

function busy(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

function order(a: SessionSummary, b: SessionSummary): number {
  const rankOf = (s: SessionSummary) =>
    needsYou(s) ? 0 : s.status === 'failed' || s.attention === 'error' ? 1 : busy(s) ? 2 : 3
  return rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function folder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function badge(s: SessionSummary, theme: Theme): { text: string; color: string } | null {
  if (needsYou(s)) {
    return { text: s.permissionCount > 1 ? `等你处理 ${s.permissionCount}` : '等你处理', color: theme.warn }
  }
  if (s.status === 'failed' || s.attention === 'error') return { text: '出错', color: theme.danger }
  if (busy(s)) return { text: '运行中', color: theme.ok }
  if (s.status === 'auth_required') return { text: '需要登录', color: theme.warn }
  if (s.attention === 'unread') return { text: '有新回复', color: theme.accent }
  return null
}

function linkText(state: LinkState): string | null {
  switch (state.kind) {
    case 'connected':
      return null
    case 'connecting':
      return '正在连接电脑…'
    case 'reconnecting':
      return '连接断开，正在重连…'
    case 'stopped':
      return state.reason === 'update_client'
        ? '这个 App 版本太旧，请更新。'
        : state.reason === 'update_host'
          ? '电脑上的 Huli 版本太旧，请先更新电脑端。'
          : '这台手机已被电脑移除。'
  }
}

export function SessionsScreen(props: {
  host: SavedHost
  deviceKey: KeyPair
  paired: Paired | null
  onHostChanged(host: SavedHost): void
  onForget(notice: string | null): void
}) {
  const theme = useTheme()
  const [state, setState] = useState<LinkState>({ kind: 'connecting' })
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(new Map())
  const [agents, setAgents] = useState<Map<string, string>>(new Map())
  const [refreshing, setRefreshing] = useState(false)
  const [hostName, setHostName] = useState(props.host.name)
  const hostRef = useRef(props.host)
  const { onHostChanged, onForget } = props

  const link = useMemo(
    () => linkTo(props.host, props.deviceKey, props.paired ?? undefined),
    // One link for the screen's life; the host's later addresses are saved for the next start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const load = useCallback(async () => {
    const [list, agentList] = await Promise.all([
      link.request('sessions.list', {}) as Promise<SessionSummary[]>,
      link.request('agents.list', undefined) as Promise<AgentStatus[]>,
    ])
    setSessions(new Map(list.map((s) => [s.id, s])))
    setAgents(new Map(agentList.map((a) => [a.id, a.name])))
  }, [link])

  useEffect(() => {
    const offState = link.onState((next) => {
      setState(next)
      if (next.kind === 'connected') {
        const { welcome } = next
        setHostName(welcome.host.name)
        const saved = hostRef.current
        const changed =
          saved.name !== welcome.host.name ||
          saved.deviceName !== welcome.device.name ||
          (welcome.addresses.length > 0 &&
            JSON.stringify(saved.addresses) !== JSON.stringify(welcome.addresses))
        if (changed) {
          hostRef.current = {
            ...saved,
            name: welcome.host.name,
            deviceName: welcome.device.name,
            addresses: welcome.addresses.length > 0 ? welcome.addresses : saved.addresses,
          }
          onHostChanged(hostRef.current)
        }
        void load().catch(() => {})
      }
      if (next.kind === 'stopped' && next.reason === 'removed') {
        onForget('这台手机已在电脑上被移除，请重新配对。')
      }
    })
    const offEvents = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'session.summary') {
        setSessions((map) => new Map(map).set(event.summary.id, event.summary))
      } else if (event.type === 'session.removed') {
        setSessions((map) => {
          const next = new Map(map)
          next.delete(event.sessionId)
          return next
        })
      } else if (event.type === 'agent.status') {
        setAgents((map) => new Map(map).set(event.status.id, event.status.name))
      }
    })
    const offApp = AppState.addEventListener('change', (status) => {
      if (status === 'active') link.wake()
    })
    link.start()
    return () => {
      offState()
      offEvents()
      offApp.remove()
      link.stop()
    }
  }, [link, load, onForget, onHostChanged])

  const visible = useMemo(
    () =>
      [...sessions.values()]
        .filter((s) => s.parentId === null && s.archivedAt === null && s.status !== 'closed')
        .sort(order),
    [sessions],
  )
  const waiting = visible.filter(needsYou).length
  const banner = linkText(state)

  const menu = () =>
    Alert.alert(hostName, `这台手机在电脑上叫「${hostRef.current.deviceName}」。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '断开配对',
        style: 'destructive',
        onPress: () => {
          link.stop()
          onForget(null)
        },
      },
    ])

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.hostName, { color: theme.text }]} numberOfLines={1}>
            {hostName}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }}>
            {state.kind === 'connected'
              ? waiting > 0
                ? `${waiting} 个会话在等你`
                : `${visible.length} 个会话`
              : '未连接'}
          </Text>
        </View>
        <Pressable onPress={menu} hitSlop={12} style={[styles.menu, { borderColor: theme.line }]}>
          <Text style={{ color: theme.text, fontSize: 18, lineHeight: 20 }}>⋯</Text>
        </Pressable>
      </View>

      {banner && (
        <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.line }]}>
          <Text style={{ color: theme.muted, fontSize: 14 }}>{banner}</Text>
        </View>
      )}

      <FlatList
        data={visible}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.accent}
            onRefresh={() => {
              setRefreshing(true)
              link.wake()
              void load()
                .catch(() => {})
                .finally(() => setRefreshing(false))
            }}
          />
        }
        ListEmptyComponent={
          state.kind === 'connected' ? (
            <Text style={[styles.empty, { color: theme.muted }]}>电脑上还没有会话。</Text>
          ) : undefined
        }
        renderItem={({ item }) => {
          const tag = badge(item, theme)
          return (
            <View style={[styles.row, { backgroundColor: theme.card, borderColor: theme.line }]}>
              <View style={styles.rowTop}>
                <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                  {item.title ?? '新会话'}
                </Text>
                {tag && (
                  <View style={[styles.tag, { borderColor: tag.color }]}>
                    <Text style={{ color: tag.color, fontSize: 12, fontWeight: '600' }}>{tag.text}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
                {agents.get(item.agentId) ?? item.agentId} · {item.scratch ? '无项目' : folder(item.projectPath)} ·{' '}
                {ago(item.updatedAt)}
              </Text>
              {item.plan && item.plan.total > 0 && (
                <Text style={[styles.meta, { color: theme.muted }]}>
                  计划 {item.plan.done}/{item.plan.total}
                </Text>
              )}
            </View>
          )
        }}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  hostName: { fontSize: 26, fontWeight: '700' },
  menu: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1 },
  row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginTop: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  meta: { fontSize: 13, marginTop: 6 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 15 },
})

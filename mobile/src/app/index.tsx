// Home: pairing until the phone has a computer, then every session on it, the ones that need the
// user first.

import { useMemo, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { LinkState } from '@shared/remote/link'
import { useHost } from '../host'
import { pushStatusText, usePushStatus } from '../push/sync'
import { PairScreen } from '../screens/PairScreen'
import { ago, folder, needsYou, sessionBadge } from '../sessions'
import { useTheme } from '../theme'

function order(a: SessionSummary, b: SessionSummary): number {
  const rankOf = (s: SessionSummary) =>
    needsYou(s)
      ? 0
      : s.status === 'failed' || s.attention === 'error'
        ? 1
        : s.status === 'running' || s.status === 'starting'
          ? 2
          : 3
  return rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt
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

export default function Home() {
  const theme = useTheme()
  const host = useHost()
  const [refreshing, setRefreshing] = useState(false)
  const pushText = pushStatusText(usePushStatus())

  const visible = useMemo(
    () =>
      [...host.sessions.values()]
        .filter((s) => s.parentId === null && s.archivedAt === null && s.status !== 'closed')
        .sort(order),
    [host.sessions],
  )

  if (host.phase === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  if (host.phase === 'pair') {
    return <PairScreen notice={host.notice} onPaired={(saved, key, paired) => void host.paired(saved, key, paired)} />
  }

  const waiting = visible.filter(needsYou).length
  const banner = linkText(host.state)
  const name = host.host?.name ?? '电脑'

  const menu = () =>
    Alert.alert(name, [`这台手机在电脑上叫「${host.host?.deviceName ?? ''}」。`, pushText].filter(Boolean).join('\n'), [
      { text: '取消', style: 'cancel' },
      { text: '断开配对', style: 'destructive', onPress: () => void host.forget(null) },
    ])

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.hostName, { color: theme.text }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }}>
            {host.state.kind === 'connected'
              ? waiting > 0
                ? `${waiting} 个会话在等你`
                : `${visible.length} 个会话`
              : '未连接'}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/new')}
          disabled={host.state.kind !== 'connected'}
          hitSlop={8}
          style={[styles.round, { backgroundColor: theme.accent, opacity: host.state.kind === 'connected' ? 1 : 0.4 }]}
        >
          <Text style={{ color: theme.accentText, fontSize: 22, lineHeight: 24, fontWeight: '600' }}>＋</Text>
        </Pressable>
        <Pressable onPress={menu} hitSlop={8} style={[styles.round, { borderColor: theme.line, borderWidth: 1 }]}>
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
              host.link?.wake()
              void host
                .refresh()
                .catch(() => {})
                .finally(() => setRefreshing(false))
            }}
          />
        }
        ListEmptyComponent={
          host.state.kind === 'connected' ? (
            <Text style={[styles.empty, { color: theme.muted }]}>电脑上还没有会话。点右上角 ＋ 新建一个。</Text>
          ) : undefined
        }
        renderItem={({ item }) => {
          const tag = sessionBadge(item, theme)
          return (
            <Pressable
              onPress={() => router.push(`/session/${item.id}`)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: theme.card, borderColor: theme.line, opacity: pressed ? 0.7 : 1 },
              ]}
            >
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
                {host.agents.get(item.agentId)?.name ?? item.agentId} ·{' '}
                {item.scratch ? '无项目' : folder(item.projectPath)} · {ago(item.updatedAt)}
              </Text>
              {item.plan && item.plan.total > 0 && (
                <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
                  计划 {item.plan.done}/{item.plan.total}
                  {item.plan.current ? ` · ${item.plan.current.text}` : ''}
                </Text>
              )}
            </Pressable>
          )
        }}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  hostName: { fontSize: 26, fontWeight: '700' },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1 },
  row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginTop: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  meta: { fontSize: 13, marginTop: 6 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 15, paddingHorizontal: 24 },
})

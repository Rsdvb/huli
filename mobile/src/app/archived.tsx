// Archived sessions, the latest archived first, to open, restore or delete.

import { useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { useSessionActions } from '../components/SessionActions'
import { useHost } from '../host'
import { ago, errorText, folder, sessionTitle } from '../sessions'
import { useTheme } from '../theme'

export default function Archived() {
  const theme = useTheme()
  const host = useHost()
  const actions = useSessionActions('archive')
  const [restoring, setRestoring] = useState<Set<string>>(new Set())

  const archived = useMemo(
    () =>
      [...host.sessions.values()]
        .filter((s) => s.parentId === null && s.archivedAt !== null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [host.sessions],
  )

  const restore = (sessionId: string) => {
    if (!host.link) return
    setRestoring((set) => new Set(set).add(sessionId))
    host.link
      .request('sessions.unarchive', { sessionId })
      .catch((error: unknown) => Alert.alert('没能恢复', errorText(error)))
      .finally(() =>
        setRestoring((set) => {
          const next = new Set(set)
          next.delete(sessionId)
          return next
        }),
      )
  }

  const connected = host.state.kind === 'connected'

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ title: '已归档' }} />
      <FlatList
        data={archived}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        ListHeaderComponent={
          archived.length > 0 ? (
            <Text style={{ color: theme.muted, fontSize: 13, marginTop: 4 }}>
              长按可以重命名或删除。
            </Text>
          ) : undefined
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.muted }]}>
            {connected ? '没有归档的会话。' : '连上电脑后才能看到归档的会话。'}
          </Text>
        }
        renderItem={({ item }) => {
          const busy = restoring.has(item.id)
          return (
            <Pressable
              onPress={() => router.push(`/session/${item.id}`)}
              onLongPress={() => actions.open(item)}
              delayLongPress={350}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.line,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                  {sessionTitle(item)}
                </Text>
                <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
                  {host.agents.get(item.agentId)?.name ?? item.agentId} ·{' '}
                  {item.scratch ? '无项目' : folder(item.projectPath)} · 归档于{' '}
                  {ago(item.archivedAt ?? item.updatedAt)}
                </Text>
              </View>
              <Pressable
                onPress={() => restore(item.id)}
                disabled={busy || !connected}
                hitSlop={8}
                style={[styles.restore, { borderColor: theme.accent, opacity: busy ? 0.5 : 1 }]}
              >
                <Text style={{ color: theme.accent, fontSize: 13, fontWeight: '600' }}>
                  {busy ? '恢复中' : '恢复'}
                </Text>
              </Pressable>
            </Pressable>
          )
        }}
      />
      {actions.element}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginTop: 10,
  },
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13, marginTop: 6 },
  restore: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 15, paddingHorizontal: 24 },
})

// One session: its conversation, newest at the bottom, what waits for the user above the
// composer, and the composer, which sends now or queues behind the running turn.

import { useMemo } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { Composer } from '../../components/Composer'
import { EntryView } from '../../components/EntryView'
import { PermissionCard } from '../../components/PermissionCard'
import { useHost, useLink } from '../../host'
import { folder } from '../../sessions'
import { useThread } from '../../thread'
import { useTheme } from '../../theme'

function waiting(entry: ThreadEntry): entry is ToolEntry {
  return entry.kind === 'tool' && entry.permission !== null && entry.permissionResult === null
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const host = useHost()
  const link = useLink()
  const view = useThread(link, id, host.state)
  const summary = host.sessions.get(id)
  const session = view.thread?.session
  const running = (session?.status ?? summary?.status) === 'running' || session?.status === 'awaiting_permission'

  const entries = useMemo(() => {
    const thread = view.thread
    if (!thread) return []
    return thread.order.map((entryId) => thread.byId[entryId]!).reverse()
  }, [view.thread])

  // What waits: the thread's own cards, and those on pages not read yet.
  const requests = useMemo(() => {
    const seen = new Map<string, ToolEntry>()
    for (const entry of view.requests) if (waiting(entry)) seen.set(entry.id, entry)
    for (const entry of entries) if (waiting(entry)) seen.set(entry.id, entry)
    return [...seen.values()]
  }, [view.requests, entries])

  const stop = () => {
    void link.request('sessions.cancel', { sessionId: id }).catch((error: { message?: string }) => {
      Alert.alert('没能停止', error.message ?? '')
    })
  }

  const title = session?.title ?? summary?.title ?? '会话'
  const agent = host.agents.get(session?.agentId ?? summary?.agentId ?? '')?.name
  const project = summary ? (summary.scratch ? '无项目' : folder(summary.projectPath)) : ''

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: 'center', maxWidth: 240 }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 16 }} numberOfLines={1}>
                {title}
              </Text>
              <Text style={{ color: theme.muted, fontSize: 11 }} numberOfLines={1}>
                {[agent, project].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ),
          headerRight: () =>
            running ? (
              <Pressable onPress={stop} hitSlop={8}>
                <Text style={{ color: theme.danger, fontSize: 16, fontWeight: '600' }}>停止</Text>
              </Pressable>
            ) : null,
        }}
      />

      {view.error ? (
        <Text style={[styles.center, { color: theme.danger }]}>{view.error}</Text>
      ) : !view.thread ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <FlatList
          inverted
          data={entries}
          keyExtractor={(entry) => entry.id}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          renderItem={({ item }) => <EntryView entry={item} theme={theme} />}
          onEndReached={view.loadOlder}
          onEndReachedThreshold={0.4}
          ListFooterComponent={view.loadingOlder ? <ActivityIndicator color={theme.accent} /> : undefined}
          keyboardDismissMode="interactive"
        />
      )}

      {requests.length > 0 && (
        <ScrollView style={{ maxHeight: '55%' }} contentContainerStyle={{ padding: 12, gap: 10 }}>
          {requests.map((entry) => (
            <PermissionCard key={entry.id} entry={entry} sessionId={id} link={link} theme={theme} />
          ))}
        </ScrollView>
      )}

      <Composer
        placeholder={running ? '排队发送，或者先停止' : '回复…'}
        onSend={(content) => link.request('sessions.queue', { sessionId: id, content })}
        failTitle="没有发出去"
        bottomInset={insets.bottom}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24 },
})

// One session: its conversation, newest at the bottom, what waits for the user above the
// composer, and the composer, which sends now or queues behind the running turn.

import { useMemo, useState } from 'react'
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
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { EntryView } from '../../components/EntryView'
import { PermissionCard } from '../../components/PermissionCard'
import { useSessionActions } from '../../components/SessionActions'
import { SessionDock } from '../../components/SessionDock'
import { SessionHeaderButtons } from '../../components/SessionHeaderButtons'
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
  const actions = useSessionActions('session', () => router.back())
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
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

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setSending(true)
    try {
      await link.request('sessions.queue', { sessionId: id, content: [{ type: 'text', text }] })
      setDraft('')
    } catch (error) {
      Alert.alert('没有发出去', (error as { message?: string }).message ?? '请稍后再试。')
    } finally {
      setSending(false)
    }
  }

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
          headerRight: () => (
            <SessionHeaderButtons
              sessionId={id}
              running={running}
              onStop={stop}
              onMenu={summary ? () => actions.open(summary) : undefined}
            />

          ),
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
      <SessionDock sessionId={id} session={session} />
      {actions.element}

      <View style={[styles.composer, { borderTopColor: theme.line, paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={running ? '排队发送，或者先停止' : '回复…'}
          placeholderTextColor={theme.muted}
          multiline
          style={[styles.input, { color: theme.text, backgroundColor: theme.card, borderColor: theme.line }]}
        />
        <Pressable
          onPress={() => void send()}
          disabled={!draft.trim() || sending || host.state.kind !== 'connected'}
          style={({ pressed }) => [
            styles.send,
            {
              backgroundColor: theme.accent,
              opacity: !draft.trim() || sending || host.state.kind !== 'connected' ? 0.4 : pressed ? 0.75 : 1,
            },
          ]}
        >
          {sending ? (
            <ActivityIndicator color={theme.accentText} />
          ) : (
            <Text style={{ color: theme.accentText, fontSize: 18, fontWeight: '700' }}>↑</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, maxHeight: 140, minHeight: 40, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
})

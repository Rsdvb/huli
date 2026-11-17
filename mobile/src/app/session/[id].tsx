// One session: its conversation, newest at the bottom, under a glass header; what waits for the
// user above the composer; and the composer, which sends now or queues behind the running turn,
// with the session's mode and model and the computer's status under it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { useSessionChanges } from '../../components/ChangesButton'
import { Composer } from '../../components/Composer'
import { ThreadRow } from '../../components/EntryView'
import { PermissionCard } from '../../components/PermissionCard'
import { useSessionActions } from '../../components/SessionActions'
import { ModeButton, ModelChip, QueueStack, useSessionConfig } from '../../components/SessionDock'
import { useHost, useLink } from '../../host'
import { errorText, folder } from '../../sessions'
import { useThread } from '../../thread'
import { useComputer } from '../../ui/session/computer'
import { SessionRows, type SessionRowsContext } from '../../ui/session/context'
import { haptic } from '../../ui/session/feedback'
import { G } from '../../ui/session/icons'
import { GlassHeader, useHeaderHeight } from '../../ui/session/GlassHeader'
import { useSessionTokens } from '../../ui/session/palette'
import { RoundButton } from '../../ui/session/Press'
import { Icon } from '../../ui/session/Icon'
import { SelectText } from '../../ui/session/SelectText'
import { StateView } from '../../ui/session/StateView'
import { StatusLine } from '../../ui/session/StatusLine'
import { threadRows, type Row } from '../../ui/session/turns'
import { ToBottomButton, WorkingRow } from '../../ui/session/Working'

function waiting(entry: ThreadEntry): entry is ToolEntry {
  return entry.kind === 'tool' && entry.permission !== null && entry.permissionResult === null
}

// How far up the conversation may be scrolled before the way back to its end shows.
const AWAY = 280

const renderRow: ListRenderItem<Row> = ({ item }) => <ThreadRow row={item} />

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const host = useHost()
  const link = useLink()
  const computer = useComputer()
  const view = useThread(link, id, host.state)
  const changes = useSessionChanges(id)
  const actions = useSessionActions(
    'session',
    () => router.back(),
    () =>
      changes.folder && changes.repo !== false
        ? [
            {
              key: 'changes',
              label: changes.count > 0 ? `查看改动（${changes.count}）` : '查看改动',
              onPress: changes.open,
            },
          ]
        : [],
  )
  const summary = host.sessions.get(id)
  const session = view.thread?.session
  const config = useSessionConfig(id, session)
  const status = session?.status ?? summary?.status
  const running = status === 'running' || status === 'awaiting_permission'
  const agentId = session?.agentId ?? summary?.agentId ?? ''
  const agent = host.agents.get(agentId)
  const list = useRef<FlatList<Row>>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)

  const rows = useMemo(() => (view.thread ? threadRows(view.thread).reverse() : []), [view.thread])

  // What waits: the thread's own cards, and those on pages not read yet.
  const requests = useMemo(() => {
    const seen = new Map<string, ToolEntry>()
    for (const entry of view.requests) if (waiting(entry)) seen.set(entry.id, entry)
    for (const row of rows)
      if (row.type === 'entry' && waiting(row.entry)) seen.set(row.entry.id, row.entry)
    return [...seen.values()]
  }, [view.requests, rows])

  // New rows while the user reads further up mark the way back down.
  const newest = rows[0]?.key
  const seenNewest = useRef(newest)
  useEffect(() => {
    if (newest !== seenNewest.current && away) setFresh(true)
    seenNewest.current = newest
  }, [newest, away])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > AWAY
    setAway((was) => (was === next ? was : next))
    if (!next) setFresh(false)
  }, [])

  const toBottom = () => {
    haptic.tap()
    list.current?.scrollToOffset({ offset: 0, animated: true })
  }

  const stop = () => {
    void link.request('sessions.cancel', { sessionId: id }).catch((error: { message?: string }) => {
      Alert.alert('没能停止', error.message ?? '')
    })
  }

  const forkAtMessage = !!agent?.capabilities.forkAtMessage
  const canFork = forkAtMessage || !!agent?.capabilities.forkSession
  const fork = useCallback(
    (entryId: string | null) => {
      const atMessage = forkAtMessage && entryId !== null
      Alert.alert(
        atMessage ? '从这里分叉？' : '分叉这个会话？',
        atMessage
          ? '新会话会带上到这条回复为止的对话，原来的会话不受影响。'
          : '新会话会带上目前的整个对话，原来的会话不受影响。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '分叉',
            onPress: () => {
              link
                .request('sessions.fork', {
                  sessionId: id,
                  ...(atMessage ? { entryId: entryId! } : {}),
                })
                .then((made) => {
                  haptic.success()
                  router.push(`/session/${(made as SessionSummary).id}`)
                })
                .catch((error: unknown) => Alert.alert('没能分叉', errorText(error)))
            },
          },
        ],
      )
    },
    [forkAtMessage, link, id],
  )

  const context = useMemo<SessionRowsContext>(
    () => ({
      sessionId: id,
      root: changes.folder,
      fork: canFork ? fork : null,
      forkAtMessage,
      selectText: setSelecting,
    }),
    [id, changes.folder, canFork, fork, forkAtMessage],
  )

  const title = session?.title ?? summary?.title ?? '会话'
  const project = summary ? (summary.scratch ? '无项目' : folder(summary.projectPath)) : null
  const openMenu = summary ? () => actions.open(summary) : undefined

  // The turn runs and nothing is being written: a line says it works.
  const newestEntry = rows.find((row) => row.type === 'entry')
  const writing =
    newestEntry?.type === 'entry' &&
    (newestEntry.entry.kind === 'agent' || newestEntry.entry.kind === 'thought') &&
    newestEntry.entry.streaming
  const replied = (() => {
    for (const row of rows) {
      if (row.type !== 'entry') break
      if (row.entry.kind === 'user' && !row.entry.steered) return false
      if (row.entry.kind === 'agent' || row.entry.kind === 'tool') return true
    }
    return false
  })()
  const working =
    running && !writing ? (
      <View style={styles.working}>
        <WorkingRow
          since={session?.turnStartedAt ?? summary?.turnStartedAt ?? null}
          label={status === 'awaiting_permission' ? '等你回答…' : replied ? '正在工作…' : '思考中…'}
          harness={agent?.harnessId}
        />
      </View>
    ) : undefined

  let body
  if (view.error) {
    body = <StateView text={view.error} tone="danger" />
  } else if (!view.thread) {
    body = <StateView loading />
  } else {
    body = (
      <FlatList
        ref={list}
        inverted
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        onEndReached={view.loadOlder}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={64}
        ListHeaderComponent={working}
        ListFooterComponent={
          view.loadingOlder ? <StateView loading /> : <View style={{ height: 4 }} />
        }
        contentContainerStyle={[styles.content, { paddingBottom: headerHeight + 12 }]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        windowSize={15}
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 40 }}
      />
    )
  }

  return (
    <SessionRows.Provider value={context}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={[styles.root, { backgroundColor: c.bg }]} behavior="padding">
        <View style={{ flex: 1 }}>
          {body}
          <ToBottomButton visible={away} fresh={fresh} onPress={toBottom} />
        </View>

        {(requests.length > 0 || (session?.queue.length ?? 0) > 0) && (
          <ScrollView
            style={styles.waiting}
            contentContainerStyle={styles.waitingContent}
            keyboardShouldPersistTaps="handled"
          >
            {requests.map((entry) => (
              <PermissionCard key={entry.id} entry={entry} sessionId={id} link={link} />
            ))}
            <QueueStack sessionId={id} session={session} />
          </ScrollView>
        )}

        <Composer
          placeholder={running ? '排队发送，或者先停止' : '回复…'}
          onSend={(content) => link.request('sessions.queue', { sessionId: id, content })}
          failTitle="没有发出去"
          bottomInset={insets.bottom}
          running={running}
          onStop={stop}
          left={<ModeButton config={config} />}
          right={<ModelChip config={config} />}
          footer={
            <StatusLine
              hostName={computer.name}
              platform={computer.platform}
              state={host.state}
              folder={project}
              changed={changes.count}
              {...(changes.folder && changes.repo !== false ? { onFolderPress: changes.open } : {})}
              limits={agent?.limits ?? []}
            />
          }
        />
      </KeyboardAvoidingView>

      <GlassHeader
        floating
        title={title}
        subtitle={[agent?.name, project].filter(Boolean).join(' · ')}
        {...(openMenu ? { onTitlePress: openMenu } : {})}
        right={
          <RoundButton
            tone="glass"
            size={44}
            onPress={openMenu}
            disabled={!openMenu}
            accessibilityLabel="会话菜单"
          >
            <Icon icon={G.more} size={18} color={c.text} weight="bold" />
          </RoundButton>
        }
      />
      {config.element}
      {actions.element}
      <SelectText text={selecting} onClose={() => setSelecting(null)} />
    </SessionRows.Provider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 18, paddingTop: 12 },
  working: { paddingTop: 2 },
  waiting: { maxHeight: '55%', flexGrow: 0 },
  waitingContent: { paddingHorizontal: 10, paddingTop: 8, gap: 10 },
})

// One session: its conversation, newest at the bottom, under a glass header whose title opens the
// session's actions and whose ⋯ opens what it made (files, changes, artifacts, terminals and
// sub-sessions); what waits for the user above the composer; and the composer, which sends now or
// queues behind the running turn, with its add menu, the session's mode and model menus, and the
// computer's status under it, whose ring opens what fills the context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { ThreadEntry, ToolEntry, UserContent } from '@shared/thread'
import { useAgentOptions } from '../../agentOptions'
import { AttachPages, useAttachPages } from '../../components/AttachMenu'
import { useSessionChanges } from '../../components/ChangesButton'
import { Composer, type ComposerHandle } from '../../components/Composer'
import {
  agentsPage,
  modePage,
  modelPage,
  moreModelsPage,
  usableAgents,
} from '../../components/ConfigMenus'
import { ContextSheet } from '../../components/ContextSheet'
import { ThreadRow } from '../../components/EntryView'
import { PermissionCard } from '../../components/PermissionCard'
import { useSessionActions } from '../../components/SessionActions'
import { ModeButton, ModelChip, QueueStack, useSessionConfig } from '../../components/SessionDock'
import { call } from '../../git'
import { useHost, useLink } from '../../host'
import { setMuted, useMuted } from '../../push/muted'
import { errorText, folder } from '../../sessions'
import { sessionTerminals, useTerminalAllowed } from '../../terminals'
import { useThread } from '../../thread'
import { useComputer } from '../../ui/session/computer'
import { SessionRows, type SessionRowsContext } from '../../ui/session/context'
import { haptic } from '../../ui/session/feedback'
import { baseName, relativePath } from '../../ui/session/format'
import { G } from '../../ui/session/icons'
import { GlassHeader, useHeaderHeight } from '../../ui/session/GlassHeader'
import { toneColor, usageTone } from '../../ui/session/limits'
import { useSessionTokens } from '../../ui/session/palette'
import {
  usePopover,
  type MenuEntry,
  type MenuPage,
  type ViewHandle,
} from '../../ui/session/Popover'
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

const live = (status: string | undefined) =>
  status === 'running' || status === 'awaiting_permission' || status === 'starting'

/** What the running turn does now, from its newest entries: 「正在运行 2 个命令」. */
function activity(rows: Row[], awaiting: boolean, root: string | null): string {
  if (awaiting) return '等你回答'
  let commands = 0
  let tool: ToolEntry | null = null
  let replied = false
  const first = rows[0]
  if (first?.type === 'entry') {
    if (first.entry.kind === 'thought' && first.entry.streaming) return '正在思考'
    if (first.entry.kind === 'agent' && first.entry.streaming) return '正在回复'
  }
  for (const row of rows) {
    if (row.type !== 'entry') break
    const entry = row.entry
    if (entry.kind === 'user' && !entry.steered) break
    if (entry.kind === 'agent') replied = true
    if (entry.kind === 'tool' && (entry.status === 'pending' || entry.status === 'in_progress')) {
      if (entry.toolKind === 'execute') commands++
      else tool ??= entry
    }
  }
  if (commands > 0) return `正在运行 ${commands} 个命令`
  if (tool) {
    const path = tool.locations[0]?.path
    const where = path ? baseName(relativePath(path, root)) : null
    switch (tool.toolKind) {
      case 'edit':
        return where ? `正在编辑 ${where}` : '正在编辑'
      case 'read':
        return where ? `正在读取 ${where}` : '正在读取'
      case 'search':
        return '正在搜索'
      case 'fetch':
        return '正在获取网页'
      default:
        return `正在使用 ${tool.title}`
    }
  }
  return replied ? '正在工作' : '正在思考'
}

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
  const actions = useSessionActions('session', () => router.back())
  const summary = host.sessions.get(id)
  const session = view.thread?.session
  const config = useSessionConfig(id, session)
  const status = session?.status ?? summary?.status
  const running = status === 'running' || status === 'awaiting_permission'
  const agentId = session?.agentId ?? summary?.agentId ?? ''
  const agent = host.agents.get(agentId)
  const connected = host.state.kind === 'connected'
  const menu = usePopover()
  const composer = useRef<ComposerHandle>(null)
  const titleAnchor = useRef<ViewHandle>(null)
  const moreAnchor = useRef<ViewHandle>(null)
  const modeAnchor = useRef<ViewHandle>(null)
  const modelAnchor = useRef<ViewHandle>(null)
  const list = useRef<FlatList<Row>>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [contextOpen, setContextOpen] = useState(false)
  const [pending, setPending] = useState<AgentStatus | null>(null)
  const [counts, setCounts] = useState<{ artifacts: number | null; terminals: number | null }>({
    artifacts: null,
    terminals: null,
  })
  const muted = useMuted(id)
  const terminalAllowed = useTerminalAllowed(link, host.state)
  const agentOptions = useAgentOptions(link, menu.openId === 'model')

  const rows = useMemo(() => (view.thread ? threadRows(view.thread).reverse() : []), [view.thread])

  // What waits: the thread's own cards, and those on pages not read yet.
  const requests = useMemo(() => {
    const seen = new Map<string, ToolEntry>()
    for (const entry of view.requests) if (waiting(entry)) seen.set(entry.id, entry)
    for (const row of rows)
      if (row.type === 'entry' && waiting(row.entry)) seen.set(row.entry.id, row.entry)
    return [...seen.values()]
  }, [view.requests, rows])

  // The files of the folder the session's tools read or edited, newest first.
  const touched = useMemo(() => {
    const root = changes.folder
    if (!root) return []
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.type !== 'entry' || row.entry.kind !== 'tool') continue
      if (row.entry.toolKind !== 'read' && row.entry.toolKind !== 'edit') continue
      for (const location of row.entry.locations) {
        const inside = relativePath(location.path, root)
        if (inside !== location.path) seen.add(inside.replace(/\\/g, '/'))
      }
    }
    return [...seen]
  }, [rows, changes.folder])

  const children = useMemo(
    () => [...host.sessions.values()].filter((s) => s.parentId === id),
    [host.sessions, id],
  )
  const childrenRunning = children.filter((s) => live(s.status)).length

  // New rows while the user reads further up mark the way back down.
  const newest = rows[0]?.key
  const seenNewest = useRef(newest)
  useEffect(() => {
    if (newest !== seenNewest.current && away) setFresh(true)
    seenNewest.current = newest
  }, [newest, away])

  // What the ⋯ menu counts is read as it opens.
  const moreOpen = menu.openId === 'more-menu'
  useEffect(() => {
    if (!moreOpen || !connected) return
    let alive = true
    call(link, 'artifacts.list', {}).then(
      (all) =>
        alive &&
        setCounts((was) => ({
          ...was,
          artifacts: all.filter((a) => a.sessionId === id && a.deletedAt === null).length,
        })),
      () => {},
    )
    if (terminalAllowed && summary) {
      sessionTerminals(link, summary.projectPath, id).then(
        (found) => alive && setCounts((was) => ({ ...was, terminals: found.length })),
        () => {},
      )
    }
    return () => {
      alive = false
    }
  }, [moreOpen, connected, link, id, terminalAllowed, summary])

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

  const newChild = () => {
    if (!summary) return
    call(link, 'sessions.create', {
      agentId: summary.agentId,
      projectPath: summary.scratch ? null : summary.projectPath,
      parentId: id,
    })
      .then((made) => {
        haptic.success()
        router.push(`/session/${made.id}`)
      })
      .catch((error: unknown) => Alert.alert('没能新建子会话', errorText(error)))
  }

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

  const send = async (content: UserContent[]) => {
    if (pending) {
      await call(link, 'sessions.switchAgent', { sessionId: id, agentId: pending.id, content })
      setPending(null)
      return
    }
    await link.request('sessions.queue', { sessionId: id, content })
  }

  // The turn runs: a line says what it does now, for how long, and what it has added.
  const usage = session?.usage ?? null
  const startUsed = session?.turnStartUsed ?? null
  const working = running ? (
    <View style={styles.working}>
      <WorkingRow
        since={session?.turnStartedAt ?? summary?.turnStartedAt ?? null}
        label={activity(rows, status === 'awaiting_permission', changes.folder)}
        tokens={usage && startUsed !== null ? usage.used - startUsed : null}
      />
    </View>
  ) : undefined

  // How full the context is, for the status line's ring.
  const breakdown = session?.context?.breakdown ?? null
  const used = usage && usage.used > 0 ? usage.used : (breakdown?.used ?? 0)
  const size = usage && usage.size > 0 ? usage.size : (breakdown?.size ?? 0)
  const share = size > 0 ? used / size : null

  const attachPages: AttachPages = useAttachPages({
    link,
    folder: changes.folder,
    mentioning: menu.page === 'mention',
    composer,
    commands: session?.commands ?? [],
    touched,
  })

  const others = usableAgents(host.agents)
  const switchable = others.length > 1 || (others.length === 1 && others[0]!.id !== agentId)

  const titleMenu = (): MenuPage | null => {
    if (!summary) return null
    const archived = summary.archivedAt !== null
    const entries: MenuEntry[] = [
      { key: 'rename', label: '重命名', icon: G.pencil, onPress: () => actions.rename(summary) },
      ...(summary.parentId === null
        ? [
            {
              key: 'pin',
              label: summary.pinnedAt !== null ? '取消置顶' : '置顶',
              icon: summary.pinnedAt !== null ? G.unpin : G.pin,
              onPress: () => actions.togglePin(summary),
            },
          ]
        : []),
      {
        key: 'unread',
        label: summary.attention === 'unread' ? '标为已读' : '标为未读',
        icon: summary.attention === 'unread' ? G.read : G.unread,
        onPress: () => actions.toggleUnread(summary),
      },
      {
        key: 'mute',
        label: muted ? '取消静音' : '静音',
        icon: muted ? G.unmute : G.mute,
        onPress: () => void setMuted(id, !muted).then(() => haptic.success()),
      },
      ...(canFork ? [{ key: 'fork', label: '分叉', icon: G.fork, onPress: () => fork(null) }] : []),
      { key: 'child', label: '新建子会话', icon: G.child, onPress: newChild },
      ...(running ? [{ key: 'stop', label: '停止', icon: G.stopOutline, onPress: stop }] : []),
      archived
        ? {
            key: 'restore',
            label: '恢复到会话列表',
            icon: G.archive,
            onPress: () => actions.restore(summary),
          }
        : {
            key: 'archive',
            label: '归档',
            icon: G.archive,
            onPress: () => actions.archive(summary),
          },
      { kind: 'divider', key: 'rule' },
      {
        key: 'delete',
        label: '删除',
        icon: G.trash,
        destructive: true,
        onPress: () => actions.remove(summary),
      },
    ]
    return { entries }
  }

  const moreMenu = (): MenuPage => {
    const repo = !!changes.folder && changes.repo !== false
    return {
      entries: [
        ...(changes.folder
          ? [
              {
                key: 'files',
                label: '文件',
                icon: G.folderOpen,
                ...(touched.length > 0 ? { detail: String(touched.length) } : {}),
                onPress: () => router.push({ pathname: '/files/[id]', params: { id } }),
              },
            ]
          : []),
        ...(repo
          ? [
              {
                key: 'changes',
                label: '改动',
                icon: G.changes,
                detail: changes.count > 0 ? String(changes.count) : '没有改动',
                onPress: changes.open,
              },
            ]
          : []),
        {
          key: 'artifacts',
          label: 'Artifacts',
          icon: G.artifacts,
          ...(counts.artifacts !== null ? { detail: String(counts.artifacts) } : {}),
          onPress: () => router.push({ pathname: '/session-artifacts/[id]', params: { id } }),
        },
        {
          key: 'terminals',
          label: '终端',
          icon: G.terminal,
          ...(terminalAllowed
            ? counts.terminals !== null
              ? { detail: String(counts.terminals) }
              : {}
            : { detail: '未开放', disabled: true }),
          onPress: () => router.push({ pathname: '/terminals/[id]', params: { id } }),
        },
        { kind: 'divider', key: 'rule' },
        {
          key: 'children',
          label: '子会话',
          icon: G.child,
          detail:
            childrenRunning > 0
              ? `${childrenRunning} 个运行中`
              : children.length > 0
                ? `${children.length} 个`
                : '没有',
          onPress: () => router.push({ pathname: '/subagents/[id]', params: { id } }),
        },
      ],
    }
  }

  const pages = (page: string): MenuPage | null => {
    switch (page) {
      case 'title':
        return titleMenu()
      case 'more-menu':
        return moreMenu()
      case 'attach':
        return attachPages.attach
      case 'mention':
        return attachPages.mention
      case 'slash':
        return attachPages.slash
      case 'mode':
        return modePage(config.control)
      case 'model':
        return modelPage(config.control, {
          agentId,
          agent,
          c,
          switchAgent: switchable
            ? running
              ? { disabled: true, hint: '这一轮结束后才能换' }
              : { disabled: false }
            : null,
        })
      case 'more':
        return moreModelsPage(config.control, agentId)
      case 'agents':
        return agentsPage({
          agents: others,
          current: pending?.id ?? agentId,
          options: agentOptions.options,
          error: agentOptions.error,
          onRetry: agentOptions.reload,
          onChoose: (chosen) => setPending(chosen.id === agentId ? null : chosen),
          footer: '从你的下一条消息起接手',
          c,
        })
      default:
        return null
    }
  }

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
          view.loadingOlder ? (
            <View style={styles.older}>
              <ActivityIndicator size="small" color={c.textTertiary} />
            </View>
          ) : (
            <View style={{ height: 4 }} />
          )
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

  const linkDown = host.state.kind === 'reconnecting' || host.state.kind === 'stopped'

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
          ref={composer}
          placeholder={
            pending
              ? `交给 ${pending.name}，写下第一条消息`
              : running
                ? '加入队列，或者先停止'
                : '回复'
          }
          onSend={send}
          failTitle={pending ? '没能换 Agent' : '没有发出去'}
          bottomInset={insets.bottom}
          running={running}
          onStop={stop}
          onAttach={(anchor) => menu.open('attach', anchor, { placement: 'above', align: 'start' })}
          left={
            <ModeButton
              mode={config.mode}
              busy={config.setting !== null && config.setting === config.mode?.option.id}
              disabled={!connected || config.setting !== null}
              anchor={modeAnchor}
              onPress={() => menu.open('mode', modeAnchor, { placement: 'above', align: 'start' })}
            />
          }
          right={
            config.model || config.effort || switchable ? (
              <ModelChip
                agentId={pending?.id ?? agentId}
                harness={pending?.harnessId ?? config.harness}
                model={config.model?.name ?? (config.model ? null : (agent?.name ?? null))}
                effort={config.effort?.name ?? null}
                pending={pending?.name ?? null}
                busy={
                  config.setting !== null &&
                  (config.setting === config.model?.option.id ||
                    config.setting === config.effort?.option.id)
                }
                disabled={!connected}
                anchor={modelAnchor}
                onPress={() =>
                  menu.open('model', modelAnchor, { placement: 'above', align: 'end', width: 300 })
                }
              />
            ) : null
          }
          footer={
            <StatusLine
              hostName={computer.name}
              platform={computer.platform}
              state={host.state}
              folder={project}
              changed={changes.count}
              {...(changes.folder && changes.repo !== false ? { onFolderPress: changes.open } : {})}
              limits={agent?.limits ?? []}
              context={
                share !== null
                  ? {
                      share,
                      color: toneColor(usageTone({ usedPercent: share * 100, state: 'ok' }), c),
                      approximate: !!session?.context?.error,
                      onPress: () => {
                        haptic.tap()
                        setContextOpen(true)
                      },
                    }
                  : null
              }
            />
          }
        />
      </KeyboardAvoidingView>

      <GlassHeader
        floating
        title={title}
        subtitle={[agent?.name, project].filter(Boolean).join(' · ')}
        titleAnchor={titleAnchor}
        {...(summary
          ? {
              onTitlePress: () =>
                menu.open('title', titleAnchor, {
                  placement: 'below',
                  align: 'center',
                  width: 250,
                }),
            }
          : {})}
        right={
          <View ref={moreAnchor} collapsable={false}>
            <RoundButton
              tone="glass"
              size={44}
              onPress={() =>
                menu.open('more-menu', moreAnchor, { placement: 'below', align: 'end', width: 290 })
              }
              disabled={!summary}
              accessibilityLabel="文件、改动、Artifacts、终端和子会话"
            >
              <Icon icon={G.more} size={18} color={c.text} weight="bold" />
            </RoundButton>
          </View>
        }
      />
      {linkDown && view.thread && (
        <View
          pointerEvents="none"
          style={[styles.banner, { top: headerHeight + 8 }]}
          accessibilityLiveRegion="polite"
        >
          <View style={[styles.bannerPill, { backgroundColor: c.glass, borderColor: c.border }]}>
            {host.state.kind === 'reconnecting' ? (
              <ActivityIndicator size="small" color={c.textSecondary} />
            ) : (
              <Icon icon={G.wifiOff} size={14} color={c.danger} />
            )}
            <Text style={[styles.bannerText, { color: c.textSecondary }]}>
              {host.state.kind === 'reconnecting' ? '和电脑的连接断了，正在重连…' : '已和电脑断开'}
            </Text>
          </View>
        </View>
      )}
      <ContextSheet
        visible={contextOpen}
        onClose={() => setContextOpen(false)}
        link={link}
        sessionId={id}
        session={session}
        agent={agent}
        hostName={computer.name}
        connected={connected}
      />
      {actions.element}
      <SelectText text={selecting} onClose={() => setSelecting(null)} />
      {menu.render(pages)}
    </SessionRows.Provider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 18, paddingTop: 12 },
  working: { paddingTop: 2, paddingBottom: 4 },
  older: { paddingVertical: 14, alignItems: 'center' },
  waiting: { maxHeight: '55%', flexGrow: 0 },
  waitingContent: { paddingHorizontal: 10, paddingTop: 8, gap: 10 },
  banner: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
  bannerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    height: 34,
  },
  bannerText: { fontSize: 13, fontWeight: '500' },
})

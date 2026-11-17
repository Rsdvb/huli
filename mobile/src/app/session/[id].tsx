// One session: its conversation, newest at the bottom, under a glass header whose title opens the
// session's actions and whose ⋯ opens what it made (files, changes, artifacts, terminals and
// sub-sessions); what waits for the user above the composer; and the composer, which sends now or
// queues behind the running turn, with its add menu, the session's mode and model menus, and the
// computer's status under it, whose rings open the plan's usage and what fills the context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { KeyboardAvoidingView, KeyboardGestureArea } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { limitsForModel } from '@shared/plan-limits'
import { harnessOf, type ThreadEntry, type UserContent } from '@shared/thread'
import { useAgentOptions } from '../../agentOptions'
import {
  backgroundWork,
  readPendingSwitch,
  setPendingSwitch,
  updatePendingSwitch,
  usePendingSwitch,
} from '../../agentSwitch'
import { AttachPages, useAttachPages } from '../../components/AttachMenu'
import { useSessionChanges } from '../../components/ChangesButton'
import {
  Composer,
  keyboardOverlap,
  SendCancelled,
  type ComposerHandle,
} from '../../components/Composer'
import { CacheNotice, SwitchStrip } from '../../components/ComposerNotes'
import {
  agentModelsPage,
  agentsPage,
  modeLook,
  modePage,
  modelPage,
  moreModelsPage,
  optionPage,
  startConfig,
  usableAgents,
  type AgentMenuProps,
  type ConfigControl,
} from '../../components/ConfigMenus'
import { ContextSheet } from '../../components/ContextSheet'
import { ThreadRow } from '../../components/EntryView'
import { SubSessionStart } from '../../components/entries/NoteEntries'
import { PlanChip } from '../../components/entries/PlanCards'
import {
  cutNoticeOf,
  OutOfCreditStrip,
  outOfCreditOf,
  retryNoticeOf,
} from '../../components/entries/TurnEnd'
import {
  HandBackCard,
  WaitingCard,
  WaitingChildren,
  waitingBelow,
  waitsForUser,
} from '../../components/entries/Waiting'
import { PlanUsageSheet } from '../../components/PlanUsageSheet'
import { useSessionActions } from '../../components/SessionActions'
import { useSessionPane } from '../../components/SessionPane'
import {
  ModeButton,
  ModelChip,
  QueueStack,
  slotOf,
  useSessionConfig,
} from '../../components/SessionDock'
import { useProjectFiles } from '../../files'
import { call } from '../../git'
import { useHost, useLink } from '../../host'
import { setMuted, useMuted } from '../../push/muted'
import { errorText, folder } from '../../sessions'
import { sessionTerminals, useTerminalAllowed } from '../../terminals'
import { useThread } from '../../thread'
import { useComputer } from '../../ui/session/computer'
import { SessionRows, type SessionRowsContext } from '../../ui/session/context'
import { haptic } from '../../ui/session/feedback'
import { FileRefs } from '../../ui/session/fileRefs'
import { relativePath } from '../../ui/session/format'
import { G } from '../../ui/session/icons'
import { GlassCapsule } from '../../ui/Glass'
import { NATIVE_MENUS, NativeMenu } from '../../ui/session/NativeMenu'
import { GlassHeader, useHeaderHeight } from '../../ui/session/GlassHeader'
import { tokensText, toneColor, usageTone } from '../../ui/session/limits'
import { endedOnRejection, sessionPlaceholder } from '../../ui/session/placeholder'
import {
  CACHE_NOTICE_MIN_TOKENS,
  useCacheExpiry,
  useCachePhase,
} from '../../ui/session/promptCache'
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
import { latestPlan, threadRows, type Row } from '../../ui/session/turns'
import {
  askedText,
  forgetTools,
  observeTools,
  phaseText,
  turnPhase,
  writingId,
} from '../../ui/session/work'
import { ToBottomButton, WorkingRow } from '../../ui/session/Working'

// How far up the conversation may be scrolled before the way back to its end shows.
const AWAY = 280

const renderRow: ListRenderItem<Row> = ({ item }) => <ThreadRow row={item} />

const live = (status: string | undefined) =>
  status === 'running' || status === 'awaiting_permission' || status === 'starting'

// Phases in which the agent thinks or writes rather than works in the app it uses.
const QUIET_PHASES = new Set(['thinking', 'writing', 'compacting', 'approval'])

export default function SessionScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  // On iPad the same screen shows as the pane beside the session list (SessionPane.tsx).
  const pane = useSessionPane()
  const id = pane?.id ?? params.id
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const host = useHost()
  const link = useLink()
  const computer = useComputer()
  const view = useThread(link, id, host.state)
  const changes = useSessionChanges(id)
  const actions = useSessionActions('session', () => (pane ? pane.close() : router.back()))
  const summary = host.sessions.get(id)
  const session = view.thread?.session
  const config = useSessionConfig(id, session)
  const status = session?.status ?? summary?.status
  const running = status === 'running' || status === 'awaiting_permission'
  const agentId = session?.agentId ?? summary?.agentId ?? ''
  const agent = host.agents.get(agentId)
  const connected = host.state.kind === 'connected'
  // The session's agent is gone from the computer: a message goes only once another is picked.
  const mustSwitch =
    host.loaded &&
    !host.fromCache &&
    agentId !== '' &&
    (!agent || !!agent.uninstalled || !!agent.disabled || agent.registered === false)
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
  const [usageOpen, setUsageOpen] = useState(false)
  // Another agent picked to take over with the next message, and the options it starts with.
  const pendingSwitch = usePendingSwitch(id)
  const pending = pendingSwitch ? (host.agents.get(pendingSwitch.agentId) ?? null) : null
  const [attachCount, setAttachCount] = useState(0)
  // The cache write the notice was closed for, so it stays closed until the next one expires.
  const [noticeClosedFor, setNoticeClosedFor] = useState<number | null>(null)
  const [counts, setCounts] = useState<{ artifacts: number | null; terminals: number | null }>({
    artifacts: null,
    terminals: null,
  })
  const muted = useMuted(id)
  const terminalAllowed = useTerminalAllowed(link, host.state)
  // A system menu says nothing as it opens, so what it shows is read beforehand there.
  const agentOptions = useAgentOptions(
    link,
    NATIVE_MENUS || menu.openId === 'model' || pendingSwitch !== null,
  )
  const pendingEntry = pendingSwitch
    ? agentOptions.options?.find((o) => o.agentId === pendingSwitch.agentId)
    : undefined
  // While a switch waits, the menus set the options the new agent starts with.
  const pendingConfig = pendingSwitch
    ? pendingEntry
      ? startConfig(pendingEntry, pendingSwitch.values)
      : []
    : null
  const control: ConfigControl = pendingConfig
    ? {
        config: pendingConfig,
        running: false,
        set: (option, value) => {
          const now = readPendingSwitch(id)
          if (now) updatePendingSwitch(id, { values: { ...now.values, [option.id]: value } })
        },
      }
    : config.control
  const shownMode = pendingConfig ? slotOf(pendingConfig, 'mode', false) : config.mode
  const shownModel = pendingConfig ? slotOf(pendingConfig, 'model', false) : config.model
  const shownEffort = pendingConfig ? slotOf(pendingConfig, 'thought_level', false) : config.effort

  const rows = useMemo(() => {
    if (!view.thread) return []
    observeTools(id, view.thread)
    return threadRows(view.thread, running).reverse()
  }, [view.thread, id, running])
  useEffect(() => () => forgetTools(id), [id])

  // The folder's files, for the references in replies and prompts that open them.
  const projectFiles = useProjectFiles(link, changes.folder, connected)
  const known = useMemo(
    () => (projectFiles.list ? new Set(projectFiles.list.paths) : null),
    [projectFiles.list],
  )
  const fileRefs = useMemo(
    () => ({ sessionId: id, root: changes.folder, known }),
    [id, changes.folder, known],
  )
  const { plan, ownTurn } = useMemo(
    () => latestPlan(view.thread, view.plan),
    [view.thread, view.plan],
  )

  // What waits: the thread's own cards, and those on pages not read yet, oldest first.
  const requests = useMemo(() => {
    const seen = new Map<string, ThreadEntry>()
    for (const entry of view.requests) if (waitsForUser(entry)) seen.set(entry.id, entry)
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.type === 'entry' && waitsForUser(row.entry)) seen.set(row.entry.id, row.entry)
    }
    return [...seen.values()]
  }, [view.requests, rows])
  const credit = useMemo(() => outOfCreditOf(view.thread), [view.thread])
  const retryNotice = useMemo(() => retryNoticeOf(view.thread), [view.thread])
  const cutNotice = useMemo(() => cutNoticeOf(view.thread), [view.thread])
  const childWaiting = waitingBelow(id, host.sessions).length > 0
  const handBack = session?.computer?.control === 'you'

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
  const moreOpen = NATIVE_MENUS || menu.openId === 'more-menu'
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
                  const madeId = (made as SessionSummary).id
                  if (pane) pane.open(madeId)
                  else router.push(`/session/${madeId}`)
                })
                .catch((error: unknown) => Alert.alert('没能分叉', errorText(error)))
            },
          },
        ],
      )
    },
    [forkAtMessage, link, id, pane],
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

  const commandNames = useMemo(
    () => (session?.commands ?? []).map((command) => command.name),
    [session?.commands],
  )
  const putCommand = useCallback(
    (name: string) => composer.current?.command(name, commandNames),
    [commandNames],
  )
  const context = useMemo<SessionRowsContext>(
    () => ({
      sessionId: id,
      root: changes.folder,
      fork: canFork ? fork : null,
      forkAtMessage,
      selectText: setSelecting,
      retryNotice,
      cutNotice,
      config: session?.config ?? [],
      commands: commandNames,
      command: putCommand,
    }),
    [
      id,
      changes.folder,
      canFork,
      fork,
      forkAtMessage,
      retryNotice,
      cutNotice,
      session?.config,
      commandNames,
      putCommand,
    ],
  )

  const title = session?.title ?? summary?.title ?? '会话'
  const project = summary ? (summary.scratch ? '无项目' : folder(summary.projectPath)) : null

  /** Asks before a switch stops background work the session's own agent runs. */
  const confirmSwitch = async (to: string): Promise<boolean> => {
    const work = await backgroundWork(link, id)
    if (work.length === 0) return true
    return new Promise((resolve) =>
      Alert.alert(
        `停止后台工作并换成 ${to}？`,
        `这些在 ${agent?.name ?? '当前 Agent'} 里运行，换 Agent 时会停止：\n${work.join('\n')}`,
        [
          { text: '取消', style: 'cancel', onPress: () => resolve(false) },
          { text: '停止并切换', style: 'destructive', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    )
  }

  // A message that hands the session to another agent goes as that agent's first turn; any other
  // goes through the host's queue, which sends at once when the session is free.
  const send = async (content: UserContent[]) => {
    if (pendingSwitch) {
      if (!(await confirmSwitch(pending?.name ?? 'Agent'))) throw new SendCancelled()
      // Read again: the switch may have changed while the user was asked.
      const now = readPendingSwitch(id)
      if (!now) throw new SendCancelled()
      await call(link, 'sessions.switchAgent', {
        sessionId: id,
        agentId: now.agentId,
        content,
        ...(Object.keys(now.values).length > 0 ? { options: now.values } : {}),
        ...(now.summarize ? { summarize: true } : {}),
      })
      setPendingSwitch(id, null)
      return
    }
    await link.request('sessions.queue', { sessionId: id, content })
  }

  // Into the running turn now: queued, then steered in, or the turn stopped and it sent next.
  const sendNow = async (content: UserContent[]) => {
    const { itemId } = (await link.request('sessions.queue', { sessionId: id, content })) as {
      itemId: string | null
    }
    if (!itemId) return
    // Once queued, a failed send-now leaves the message in the queue, not lost.
    link
      .request('sessions.sendNow', { sessionId: id, itemId })
      .catch((error: unknown) => Alert.alert('没能立即发送', errorText(error)))
  }

  // Picking the session's own agent undoes a switch; another's model makes it the pending one.
  const chooseAgent = (chosen: AgentStatus, model: string | null) => {
    if (chosen.id === agentId && !mustSwitch) {
      setPendingSwitch(id, null)
      const own = config.model?.option
      if (own && model !== null && model !== own.value) config.control.set(own, model)
      return
    }
    const entry = agentOptions.options?.find((o) => o.agentId === chosen.id)
    const modelId = entry?.config.find((o) => o.category === 'model')?.id
    setPendingSwitch(id, {
      agentId: chosen.id,
      values: modelId && model !== null ? { [modelId]: model } : {},
      summarize: pendingSwitch?.summarize ?? false,
    })
  }

  // The turn runs: a line says for how long, what it has added and what it does now, with the
  // attention dot while it waits for the user. While the agent writes its reply, the reply's
  // caret carries the turn, so the line steps aside.
  const usage = session?.usage ?? null
  const startUsed = session?.turnStartUsed ?? null
  const turn = useMemo(() => {
    const thread = view.thread
    const phase = turnPhase(thread)
    return { ...phase, asked: askedText(thread), writing: writingId(thread) !== null }
  }, [view.thread])
  const app = session?.computer?.app ?? null
  const waitingYou = turn.phase === 'approval' || requests.length > 0
  const workingText =
    turn.asked ??
    (handBack
      ? `等你交还 ${app ?? '电脑'}`
      : waitingYou && turn.phase !== 'approval'
        ? phaseText('approval', 1)
        : app && !QUIET_PHASES.has(turn.phase)
          ? `正在使用 ${app}`
          : phaseText(turn.phase, turn.count))
  const added =
    usage && startUsed !== null && usage.used > startUsed ? usage.used - startUsed : null
  const working =
    running && !turn.writing ? (
      <View style={styles.working}>
        <WorkingRow
          since={session?.turnStartedAt ?? summary?.turnStartedAt ?? null}
          label={workingText}
          tokens={added}
          waiting={waitingYou || handBack || turn.asked !== null}
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
    count: attachCount,
  })

  const others = usableAgents(host.agents)
  const switchable = others.length > 1 || (others.length === 1 && others[0]!.id !== agentId)
  const agentMenu: AgentMenuProps = {
    agents: others,
    current: pendingSwitch?.agentId ?? agentId,
    currentModel: pendingConfig
      ? (shownModel?.option.value as string | undefined)
      : (config.model?.option.value as string | undefined),
    options: agentOptions.options,
    error: agentOptions.error,
    onRetry: agentOptions.reload,
    onChoose: chooseAgent,
    footer: '从你的下一条消息起接手',
    title: '换 Agent',
    c,
  }

  // The prompt cache: its countdown under the box, a warning on a change that rewrites it while
  // warm, and a notice when a message is begun on one that has expired.
  const cacheExpiry = useCacheExpiry(session, agent?.account ?? null)
  const cachePhase = useCachePhase(cacheExpiry)
  const reread = session?.usage?.used ?? 0
  // Shown once the box holds a message, which the composer tells its notes alone.
  const cacheNoticeShown =
    cacheExpiry !== null &&
    cachePhase === 'expired' &&
    !running &&
    status !== 'starting' &&
    pendingSwitch === null &&
    reread >= CACHE_NOTICE_MIN_TOKENS &&
    noticeClosedFor !== cacheExpiry.lastRequestAt
  // Claude Code's model, effort and fast mode are part of what its cache was written for.
  const cacheNote =
    agentId !== '' &&
    harnessOf(agentId) === 'claude-code' &&
    !running &&
    pendingSwitch === null &&
    (cachePhase === 'warm' || cachePhase === 'ending')
      ? `在这里改动会重写约 ${tokensText(reread)} token 的 prompt cache`
      : null

  const starting = status === 'starting'
  const awaiting = status === 'awaiting_permission'
  const steering = !!agent?.capabilities.steering
  const reached = useMemo(
    () =>
      limitsForModel(agent?.limits ?? [], config.model?.option).find(
        (l) => l.state === 'reached',
      ) ?? null,
    [agent?.limits, config.model?.option],
  )
  const rejected = useMemo(() => endedOnRejection(view.thread), [view.thread])
  const shownName = pending?.name ?? agent?.name ?? 'Agent'
  const placeholder = sessionPlaceholder({
    agent: shownName,
    starting,
    pickAgent: mustSwitch && !pendingSwitch,
    awaiting,
    running,
    steering,
    reached,
    rejected,
  })
  // Why Send does nothing now, for the line over the text.
  const unsendable =
    mustSwitch && !pendingSwitch ? '先选择 Agent' : starting ? `等 ${shownName} 启动后再发送` : null

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
        return modePage(control)
      case 'model': {
        // An agent picked to take over, or one that must be picked, shows its own menu.
        if (pendingSwitch || mustSwitch) {
          const own = pendingConfig
            ? modelPage(control, {
                agentId: pendingSwitch?.agentId ?? agentId,
                agent: pending ?? undefined,
                c,
                switchAgent: { disabled: false },
              })
            : null
          return own ?? agentsPage(agentMenu)
        }
        return modelPage(control, {
          agentId,
          agent,
          c,
          switchAgent: switchable
            ? status === 'ready' || status === 'closed'
              ? { disabled: false }
              : { disabled: true, hint: '在两轮之间才能换' }
            : null,
          onUsage: () => {
            menu.close()
            setUsageOpen(true)
          },
          cacheNote,
        })
      }
      case 'more':
        return moreModelsPage(control, pendingSwitch?.agentId ?? agentId)
      case 'agents':
        return agentsPage(agentMenu)
      default:
        if (page.startsWith('option:')) return optionPage(control, page.slice('option:'.length))
        if (page.startsWith('agent:'))
          return agentModelsPage(agentMenu, page.slice('agent:'.length))
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
          ) : !view.hasOlder && summary?.origin === 'user' && summary.parentId ? (
            <SubSessionStart sessionId={id} />
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
    // The rows' file references open the folder's files.
    body = <FileRefs.Provider value={fileRefs}>{body}</FileRefs.Provider>
  }

  const linkDown = host.state.kind === 'reconnecting' || host.state.kind === 'stopped'

  return (
    <SessionRows.Provider value={context}>
      {pane ? null : <Stack.Screen options={{ headerShown: false }} />}
      {/* Moved up with the keyboard on the UI thread, and laid out again once it settles, so the
          conversation is not laid out on each frame of the keyboard's animation. */}
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: c.bg }]}
        behavior="translate-with-padding"
        automaticOffset
        keyboardVerticalOffset={-keyboardOverlap(insets.bottom)}
      >
        <KeyboardGestureArea interpolator="ios" style={{ flex: 1 }}>
          {body}
          <ToBottomButton visible={away} fresh={fresh} onPress={toBottom} />
        </KeyboardGestureArea>

        <PlanChip plan={plan} running={ownTurn && running} />

        {(requests.length > 0 ||
          handBack ||
          credit !== null ||
          childWaiting ||
          (session?.queue.length ?? 0) > 0) && (
          <ScrollView
            style={styles.waiting}
            contentContainerStyle={styles.waitingContent}
            keyboardShouldPersistTaps="handled"
          >
            <HandBackCard sessionId={id} session={session} />
            {requests.map((entry) => (
              <WaitingCard key={entry.id} entry={entry} sessionId={id} link={link} />
            ))}
            {credit && (
              <OutOfCreditStrip
                sessionId={id}
                notice={credit}
                config={session?.config ?? []}
                onSwitchModel={
                  connected
                    ? () =>
                        menu.open('model', modelAnchor, {
                          placement: 'above',
                          align: 'end',
                          width: 300,
                        })
                    : null
                }
              />
            )}
            <WaitingChildren sessionId={id} />
            <QueueStack
              sessionId={id}
              session={session}
              onEdit={(content) => composer.current?.restore(content)}
            />
          </ScrollView>
        )}

        <Composer
          key={id}
          ref={composer}
          draft={id}
          agentName={shownName}
          placeholder={placeholder}
          onSend={send}
          onSendNow={sendNow}
          steering={steering}
          failTitle={pendingSwitch ? '没能换 Agent' : '没有发出去'}
          blocked={unsendable}
          addBlocked={starting ? `等 ${shownName} 启动后再添加` : null}
          commands={session?.commands ?? []}
          folder={changes.folder}
          usedFiles={touched}
          sessionId={id}
          takes={
            (pending ?? agent)?.capabilities.prompt
              ? {
                  images: !!(pending ?? agent)!.capabilities.prompt!.image,
                  text: !!(pending ?? agent)!.capabilities.prompt!.embeddedContext,
                }
              : null
          }
          onCountChange={setAttachCount}
          top={(holds) =>
            pendingSwitch || (cacheNoticeShown && holds) ? (
              <>
                {cacheNoticeShown && holds && (
                  <CacheNotice
                    estimate={cacheExpiry.estimate}
                    used={reread}
                    onDismiss={() => setNoticeClosedFor(cacheExpiry.lastRequestAt)}
                  />
                )}
                {pendingSwitch && (
                  <SwitchStrip
                    agentName={shownName}
                    config={pendingConfig ?? []}
                    summarize={pendingSwitch.summarize}
                    onSummarize={(on) => updatePendingSwitch(id, { summarize: on })}
                    onUndo={() => setPendingSwitch(id, null)}
                  />
                )}
              </>
            ) : undefined
          }
          bottomInset={insets.bottom}
          running={running}
          onStop={stop}
          onAttach={(anchor) => menu.open('attach', anchor, { placement: 'above', align: 'start' })}
          attachMenu={(anchor) => ({
            root: 'attach',
            pages,
            popover: {
              pages: ['mention'],
              open: (page) => menu.open(page, anchor, { placement: 'above', align: 'start' }),
            },
          })}
          left={
            <NativeMenu source={{ root: 'mode', pages }} disabled={!connected}>
              <ModeButton
                mode={
                  shownMode
                    ? { ...shownMode, look: modeLook(String(shownMode.option.value)) }
                    : null
                }
                busy={config.setting !== null && config.setting === config.mode?.option.id}
                disabled={!connected || config.setting !== null || starting}
                anchor={modeAnchor}
                onPress={() =>
                  menu.open('mode', modeAnchor, { placement: 'above', align: 'start' })
                }
              />
            </NativeMenu>
          }
          right={
            !starting && (shownModel || shownEffort || switchable || mustSwitch) ? (
              <NativeMenu source={{ root: 'model', pages }} disabled={!connected}>
                <ModelChip
                  agentId={pending?.id ?? agentId}
                  harness={pending?.harnessId ?? config.harness}
                  model={
                    shownModel?.name ??
                    (shownModel
                      ? null
                      : (pending?.name ?? (mustSwitch ? '选择 Agent' : (agent?.name ?? null))))
                  }
                  effort={shownEffort?.name ?? null}
                  pending={pending && !shownModel ? pending.name : null}
                  busy={
                    !pendingSwitch &&
                    config.setting !== null &&
                    (config.setting === config.model?.option.id ||
                      config.setting === config.effort?.option.id)
                  }
                  disabled={!connected}
                  anchor={modelAnchor}
                  onPress={() =>
                    menu.open('model', modelAnchor, {
                      placement: 'above',
                      align: 'end',
                      width: 340,
                    })
                  }
                />
              </NativeMenu>
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
              limits={limitsForModel(agent?.limits ?? [], config.model?.option)}
              onLimitPress={() => {
                haptic.tap()
                setUsageOpen(true)
              }}
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
              cache={
                cacheExpiry && !running
                  ? {
                      expiry: cacheExpiry,
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
        {...(summary ? { titleMenu: { root: 'title', pages } } : {})}
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
            <NativeMenu source={{ root: 'more-menu', pages }} disabled={!summary}>
              <RoundButton
                tone="glass"
                size={44}
                onPress={() =>
                  menu.open('more-menu', moreAnchor, {
                    placement: 'below',
                    align: 'end',
                    width: 290,
                  })
                }
                disabled={!summary}
                accessibilityLabel="文件、改动、Artifacts、终端和子会话"
              >
                <Icon icon={G.more} size={18} color={c.text} weight="bold" />
              </RoundButton>
            </NativeMenu>
          </View>
        }
      />
      {linkDown && view.thread && (
        <View
          pointerEvents="none"
          style={[styles.banner, { top: headerHeight + 8 }]}
          accessibilityLiveRegion="polite"
        >
          <GlassCapsule height={34} elevated style={styles.bannerPill}>
            {host.state.kind === 'reconnecting' ? (
              <ActivityIndicator size="small" color={c.textSecondary} />
            ) : (
              <Icon icon={G.wifiOff} size={14} color={c.danger} />
            )}
            <Text style={[styles.bannerText, { color: c.textSecondary }]}>
              {host.state.kind === 'reconnecting' ? '和电脑的连接断了，正在重连…' : '已和电脑断开'}
            </Text>
          </GlassCapsule>
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
      <PlanUsageSheet
        visible={usageOpen}
        onClose={() => setUsageOpen(false)}
        agentId={agentId || null}
        usage={usage}
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
  bannerPill: { gap: 8 },
  bannerText: { fontSize: 13, fontWeight: '500' },
})

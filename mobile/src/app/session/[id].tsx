// One session: its conversation, newest at the bottom, under a glass header whose title opens the
// session's actions (by the desktop's menu model, SessionMenu.ts) and whose ⋯ opens what it made
// (files, changes, artifacts, terminals and sub-sessions), with chips under it for its parent,
// routine, task, worktree and pull requests; what waits for the user above the composer, a worktree
// that is not ready among it; and the composer, which sends now or queues behind the running turn,
// with its add menu, the session's mode and model menus, and the computer's status under it, whose
// rings open the plan's usage and what fills the context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import { useSharedValue } from 'react-native-reanimated'
import { hideNotice, showNotice } from '../../ui/NoticeBar'
import {
  KeyboardGestureArea,
  KeyboardStickyView,
  useKeyboardState,
} from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { limitsForModel } from '@shared/plan-limits'
import { fallbackAgent, planQuota } from '@shared/plan-quota'
import {
  harnessOf,
  turnText,
  type ThreadEntry,
  type ThreadState,
  type ToolEntry,
  type UserContent,
} from '@shared/thread'
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
import {
  CacheNotice,
  PromptSuggestionChip,
  QuotaSuggestion,
  SwitchStrip,
} from '../../components/ComposerNotes'
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
import { Conversation } from '../../components/Conversation'
import {
  PLAN_PILL_ROOM,
  PlanApprovalCard,
  PlanPill,
  pinnedPlan,
  planPage,
} from '../../components/entries/PlanCards'
import { createStore } from '../../select'
import {
  cutNoticeOf,
  OutOfCreditStrip,
  outOfCreditOf,
  planLimitStopOf,
  retryNoticeOf,
} from '../../components/entries/TurnEnd'
import {
  HandBackCard,
  WaitingCard,
  WaitingChildren,
  useWaitingBelow,
  waitsForUser,
} from '../../components/entries/Waiting'
import { PlanUsageSheet } from '../../components/PlanUsageSheet'
import { WorktreeLine } from '../../components/git/WorktreeCard'
import { useSessionActions } from '../../components/SessionActions'
import { CHIPS_HEIGHT, hasChips, SessionChips } from '../../components/SessionChips'
import { sessionMenuPages } from '../../components/SessionMenu'
import { useSessionPane } from '../../components/SessionPane'
import {
  HeldStrip,
  heldConfirmText,
  ModeButton,
  ModelChip,
  QueueStack,
  slotOf,
  useSessionConfig,
} from '../../components/SessionDock'
import { useProjectFiles } from '../../files'
import { confirm } from '../../manage/kit'
import { call } from '../../git'
import {
  sameFields,
  sameItems,
  useAgents,
  useComputerId,
  useHostSelector,
  useHostState,
  useLink,
  useLinkDown,
  useSession,
  type HostData,
} from '../../host'
import { setMuted, useMuted } from '../../push/muted'
import { folder, sessionTitle } from '../../sessions'
import { hostErrorText } from '../../hostErrors'
import { sessionTerminals, useTerminalAllowed } from '../../terminals'
import { useThread, useThreadSelector } from '../../thread'
import { useComputer } from '../../ui/session/computer'
import { countRender } from '../../ui/renders'
import { SessionRows, type SessionRowsContext } from '../../ui/session/context'
import { copyText, haptic } from '../../ui/session/feedback'
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
import { OutboxRows, useHasOutbox } from '../../components/OutboxRows'
import { queueMessage, withdrawItem, type OutboxMessage } from '../../outbox'
import { useSessionTokens } from '../../ui/session/palette'
import { usePopover, type MenuPage, type ViewHandle } from '../../ui/session/Popover'
import { PressScale, RoundButton } from '../../ui/session/Press'
import { Icon } from '../../ui/session/Icon'
import { StateView } from '../../ui/session/StateView'
import { StatusLine } from '../../ui/session/StatusLine'
import { SubagentBar } from '../../components/SubagentBar'
import { foldsIntoRun, latestPlan, latestTurn } from '../../ui/session/turns'
import {
  askedText,
  doingText,
  forgetTools,
  phaseText,
  turnDoing,
  writingId,
} from '../../ui/session/work'
import { WorkingRow } from '../../ui/session/Working'
import { devMode } from '../../dev/devMode'
import { FrameMeter } from '../../dev/FrameMeter'

const pickLists = (d: HostData) => ({ loaded: d.loaded, fromCache: d.fromCache })

// The developer's frame meter over the real screen, for the simulator flows that measure it.
const DEV = devMode()

// What the screen reads of the thread, each apart, so a token appended to a reply changes none.
const selectSession = (thread: ThreadState | null) => thread?.session
const selectHasThread = (thread: ThreadState | null) => thread !== null
const selectTurn = (thread: ThreadState | null) => ({
  ...turnDoing(thread),
  asked: askedText(thread),
  writing: writingId(thread) !== null,
})

// These read the whole thread, on every patch the screen applies while a turn streams, so what
// they work out of an entry is kept by the entry, which a patch replaces only when it changes.
const folds = new WeakMap<ThreadEntry, boolean>()
const foldsKept = (entry: ThreadEntry): boolean => {
  let known = folds.get(entry)
  if (known === undefined) folds.set(entry, (known = foldsIntoRun(entry)))
  return known
}

/** The thread's own cards that wait for the user, as rows of their own, oldest first. */
function threadWaits(thread: ThreadState | null): ThreadEntry[] {
  if (!thread) return []
  const out: ThreadEntry[] = []
  for (const id of thread.order) {
    const entry = thread.byId[id]
    if (entry && !foldsKept(entry) && waitsForUser(entry)) out.push(entry)
  }
  return out
}

const touchedBy = new WeakMap<ThreadEntry, { root: string; paths: string[] }>()

/** The files under `root` a tool row read or edited. */
function touchedOf(entry: ThreadEntry, root: string): string[] {
  const known = touchedBy.get(entry)
  if (known?.root === root) return known.paths
  const paths: string[] = []
  if (
    entry.kind === 'tool' &&
    (entry.toolKind === 'read' || entry.toolKind === 'edit') &&
    !foldsKept(entry)
  ) {
    for (const location of entry.locations) {
      const inside = relativePath(location.path, root)
      if (inside !== location.path) paths.push(inside.replace(/\\/g, '/'))
    }
  }
  touchedBy.set(entry, { root, paths })
  return paths
}

/** The files under `root` that the thread's own tool rows read or edited, newest first. */
function touchedFiles(thread: ThreadState | null, root: string | null): string[] {
  if (!thread || !root) return []
  const seen = new Set<string>()
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind !== 'tool') continue
    for (const path of touchedOf(entry, root)) seen.add(path)
  }
  return [...seen]
}

/** A plan that waits for approval: its card stands below the others, its buttons in view. */
const isPlanAsk = (entry: ThreadEntry): entry is ToolEntry =>
  entry.kind === 'tool' && !!entry.permission?.plan && !entry.permission.elicitation

const pickKeyboard = (state: { isVisible: boolean; height: number }) =>
  state.isVisible ? state.height : 0

// The sessions whose user agreed to go on here while a program outside has them open, once each.
const outsideAgreed = new Set<string>()

// When, after the screen settles, the folder's files are read, and how long they are kept.
const FILES_AFTER = 1500
const FILES_KEPT = 10 * 60_000

// How long Stop waits for the turn to end before it can be asked again.
const STOP_WAIT = 15_000

const live = (status: string | undefined) =>
  status === 'running' || status === 'awaiting_permission' || status === 'starting'

// Phases in which the agent thinks or writes rather than works in the app it uses.
const QUIET_PHASES = new Set(['thinking', 'writing', 'compacting', 'approval'])

export default function SessionScreen() {
  countRender('SessionScreen')
  const params = useLocalSearchParams<{ id: string }>()
  // On iPad the same screen shows as the pane beside the session list (SessionPane.tsx).
  const pane = useSessionPane()
  const id = pane?.id ?? params.id
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const window = useWindowDimensions()
  const overlap = keyboardOverlap(insets.bottom)
  // The dock's height: the conversation's end inset, and room under what shows without one.
  const dock = useSharedValue(0)
  const [dockHeight, setDockHeight] = useState(0)
  const onDockLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height
      dock.value = height
      setDockHeight(height)
    },
    [dock],
  )
  const hostState = useHostState()
  const lists = useHostSelector(pickLists, sameFields)
  const agents = useAgents()
  const link = useLink()
  const computer = useComputer()
  const view = useThread(link, id, hostState)
  const changes = useSessionChanges(id)
  const actions = useSessionActions('session', () => (pane ? pane.close() : router.back()))
  const summary = useSession(id)
  const session = useThreadSelector(view, selectSession)
  const hasThread = useThreadSelector(view, selectHasThread)
  const config = useSessionConfig(id, session)
  const status = session?.status ?? summary?.status
  const running = status === 'running' || status === 'awaiting_permission'
  const agentId = session?.agentId ?? summary?.agentId ?? ''
  const agent = agents.get(agentId)
  const connected = hostState.kind === 'connected'
  // The session's agent is gone from the computer: a message goes only once another is picked.
  const mustSwitch =
    lists.loaded &&
    !lists.fromCache &&
    agentId !== '' &&
    (!agent || !!agent.uninstalled || !!agent.disabled || agent.registered === false)
  const menu = usePopover()
  const composer = useRef<ComposerHandle>(null)
  const titleAnchor = useRef<ViewHandle>(null)
  const moreAnchor = useRef<ViewHandle>(null)
  const modeAnchor = useRef<ViewHandle>(null)
  const modelAnchor = useRef<ViewHandle>(null)
  const planAnchor = useRef<ViewHandle>(null)
  // Whether the conversation is flung, which only the plan's pill reads.
  const scrolling = useMemo(() => createStore(false), [])
  const [contextOpen, setContextOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  // Another agent picked to take over with the next message, and the options it starts with.
  const pendingSwitch = usePendingSwitch(id)
  const pending = pendingSwitch ? (agents.get(pendingSwitch.agentId) ?? null) : null
  const [attachCount, setAttachCount] = useState(0)
  // The cache write the notice was closed for, so it stays closed until the next one expires.
  const [noticeClosedFor, setNoticeClosedFor] = useState<number | null>(null)
  const [counts, setCounts] = useState<{ artifacts: number | null; terminals: number | null }>({
    artifacts: null,
    terminals: null,
  })
  const muted = useMuted(id)
  const terminalAllowed = useTerminalAllowed(link, hostState)
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

  useEffect(() => () => forgetTools(id), [id])

  // The folder's files, for the references in replies and prompts that open them. A project
  // lists up to 50,000, read only once the screen has opened and settled, and kept ten minutes
  // for the next session in the folder, as only whether a file is there matters here.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), FILES_AFTER)
    return () => clearTimeout(timer)
  }, [])
  const projectFiles = useProjectFiles(link, changes.folder, connected && settled, FILES_KEPT)
  const known = useMemo(
    () => (projectFiles.list ? new Set(projectFiles.list.paths) : null),
    [projectFiles.list],
  )
  const fileRefs = useMemo(
    () => ({ sessionId: id, root: changes.folder, known }),
    [id, changes.folder, known],
  )
  const { plan, ownTurn } = useThreadSelector(
    view,
    useCallback((thread: ThreadState | null) => latestPlan(thread, view.plan), [view.plan]),
    sameFields,
  )
  const planRunning = ownTurn && running
  const pinned = pinnedPlan(plan, planRunning)

  // What waits: the thread's own cards, and those on pages not read yet, oldest first.
  const waits = useThreadSelector(view, threadWaits, sameItems)
  const requests = useMemo(() => {
    const seen = new Map<string, ThreadEntry>()
    for (const entry of view.requests) if (waitsForUser(entry)) seen.set(entry.id, entry)
    for (const entry of waits) seen.set(entry.id, entry)
    return [...seen.values()]
  }, [view.requests, waits])
  const plansWaiting = requests.filter(isPlanAsk)
  const othersWaiting = plansWaiting.length > 0 ? requests.filter((e) => !isPlanAsk(e)) : requests
  const credit = useThreadSelector(view, outOfCreditOf)
  const retryNotice = useThreadSelector(view, retryNoticeOf)
  const cutNotice = useThreadSelector(view, cutNoticeOf)
  const childWaiting = useWaitingBelow(id).length > 0
  // A question of the agent's waits: the working line and the composer say it waits for an answer.
  const asking = requests.some(
    (entry) => entry.kind === 'tool' && !!entry.permission?.questions?.length,
  )
  const handBack = session?.computer?.control === 'you'
  // A worktree that is not ready says so above the composer, as the desktop's does.
  const worktreeWaits = !!summary?.worktree && summary.worktree.state !== 'ready'
  const parentKnown = !!useSession(summary?.parentId)
  const chips = hasChips(summary, parentKnown)

  // The files of the folder the session's tools read or edited, newest first.
  const touched = useThreadSelector(
    view,
    useCallback(
      (thread: ThreadState | null) => touchedFiles(thread, changes.folder),
      [changes.folder],
    ),
    sameItems,
  )

  const children = useHostSelector(
    useCallback((d: HostData) => [...d.sessions.values()].filter((s) => s.parentId === id), [id]),
    sameItems,
  )
  const childrenRunning = children.filter((s) => live(s.status)).length

  // What the ⋯ menu counts is read as it opens, and again as the session changes while it is
  // open, once those changes pause. It is always our popover, so nothing is read while it is shut.
  const moreOpen = menu.openId === 'more-menu'
  const countsRead = useRef(false)
  const projectPath = summary?.projectPath ?? null
  useEffect(() => {
    if (!moreOpen || !connected) {
      countsRead.current = false
      return
    }
    let alive = true
    const read = () => {
      countsRead.current = true
      call(link, 'artifacts.list', {}).then(
        (all) =>
          alive &&
          setCounts((was) => ({
            ...was,
            artifacts: all.filter((a) => a.sessionId === id && a.deletedAt === null).length,
          })),
        () => {},
      )
      if (terminalAllowed && projectPath !== null) {
        sessionTerminals(link, projectPath, id).then(
          (found) => alive && setCounts((was) => ({ ...was, terminals: found.length })),
          () => {},
        )
      }
    }
    const timer = setTimeout(read, countsRead.current ? 1000 : 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [moreOpen, connected, link, id, terminalAllowed, projectPath, summary])

  // Stop asks once: the button turns until the turn ends, rather than cancel it again with each
  // tap while the agent winds down.
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!running) setStopping(false)
  }, [running])
  useEffect(() => {
    if (!stopping) return
    // An agent that never ends its turn leaves Stop to be asked again.
    const timer = setTimeout(() => setStopping(false), STOP_WAIT)
    return () => clearTimeout(timer)
  }, [stopping])
  const stop = () => {
    if (stopping) return
    setStopping(true)
    link.request('sessions.cancel', { sessionId: id }).catch((error: unknown) => {
      setStopping(false)
      Alert.alert('没能停止', hostErrorText(error))
    })
  }

  const forkAtMessage = !!agent?.capabilities.forkAtMessage
  const canFork = forkAtMessage || !!agent?.capabilities.forkSession
  const forking = useRef(false)
  const fork = useCallback(
    (entryId: string | null, worktree?: 'same') => {
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
              if (forking.current) return
              forking.current = true
              // Forking copies the session on the computer, which takes a moment.
              showNotice({ text: '正在分叉…' })
              link
                .request('sessions.fork', {
                  sessionId: id,
                  ...(atMessage ? { entryId: entryId! } : {}),
                  ...(worktree ? { worktree } : {}),
                })
                .then((made) => {
                  haptic.success()
                  hideNotice()
                  const madeId = (made as SessionSummary).id
                  if (pane) pane.open(madeId)
                  else router.push(`/session/${madeId}`)
                })
                .catch((error: unknown) => {
                  hideNotice()
                  Alert.alert('没能分叉', hostErrorText(error))
                })
                .finally(() => {
                  forking.current = false
                })
            },
          },
        ],
      )
    },
    [forkAtMessage, link, id, pane],
  )

  // Undo takes the latest turn out of the session, as the desktop's does, where the agent can; its
  // message goes back to the composer to edit, unless the user is writing another there.
  const lastTurn = useThreadSelector(view, latestTurn, sameFields)
  const canRevert = !!agent?.capabilities.revertTurns && summary?.origin === 'user'
  const [reverting, setReverting] = useState(false)
  const revertStart = lastTurn.start
  const revert = useCallback(async () => {
    if (revertStart === null) return
    const go = await confirm({
      title: '撤销最近一轮？',
      message:
        '你的上一条消息和这条回复会从对话里移除，Agent 也会忘掉它们。这一轮改过的文件保持原样。',
      confirm: '撤销这一轮',
    })
    if (!go) return
    // Read before the turn's entries leave the thread.
    const thread = view.store.get()
    const text = thread ? turnText(thread, revertStart) : ''
    setReverting(true)
    try {
      await link.request('sessions.revert', { sessionId: id, entryId: revertStart })
      haptic.success()
      const back = !!text.trim() && !!composer.current?.putBack(text)
      if (!text.trim() || back) {
        showNotice({
          text: back ? '已撤销这一轮，消息放回了输入框' : '已撤销这一轮',
          tone: 'success',
        })
      } else {
        Alert.alert('输入框里已有草稿', '撤销的消息没有放回去。', [
          { text: '复制消息', onPress: () => void copyText(text) },
          { text: '好', style: 'cancel' },
        ])
      }
    } catch (error) {
      Alert.alert('没能撤销', hostErrorText(error))
    } finally {
      setReverting(false)
    }
  }, [revertStart, view.store, link, id])
  const undoEnd = canRevert ? lastTurn.end : null
  const undoBlocked = reverting || (status !== 'ready' && status !== 'closed')
  const undo = useMemo(
    () =>
      undoEnd === null
        ? null
        : { end: undoEnd, blocked: undoBlocked, busy: reverting, run: () => void revert() },
    [undoEnd, undoBlocked, reverting, revert],
  )

  // New session opens under this one, in its project, as the desktop's 新建子会话 does.
  const newChild = () => router.push({ pathname: '/new', params: { parent: id } })
  const openSession = (sessionId: string) =>
    pane ? pane.open(sessionId) : router.push(`/session/${sessionId}`)

  const commandNames = useMemo(
    () => (session?.commands ?? []).map((command) => command.name),
    [session?.commands],
  )
  // After a turn the plan limit stopped, the agent with the most room may carry the task on: it
  // takes the session over and is asked to go on from the conversation so far.
  const limitStopped = useThreadSelector(view, planLimitStopOf)
  const carryTo =
    limitStopped && agent ? fallbackAgent(usableAgents(agents), agent.id, Date.now()) : null
  const carryAgent = carryTo?.agentId ?? null
  const carryName = carryTo?.name ?? ''
  const carryUsed = carryTo?.usedPercent ?? 0
  const carryOn = useMemo(
    () =>
      carryAgent
        ? {
            name: carryName,
            usedPercent: carryUsed,
            go: () =>
              call(link, 'sessions.switchAgent', {
                sessionId: id,
                agentId: carryAgent,
                content: [{ type: 'text' as const, text: '继续刚才的任务。' }],
              }),
          }
        : null,
    [carryAgent, carryName, carryUsed, link, id],
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
      undo,
      retryNotice,
      cutNotice,
      carryOn,
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
      undo,
      retryNotice,
      cutNotice,
      carryOn,
      session?.config,
      commandNames,
      putCommand,
    ],
  )

  // Named as the session list names it: an untitled one is 新会话 there and here.
  const title = sessionTitle({ title: session?.title ?? summary?.title ?? null })
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
    if (openOutside && !heldOutside && !outsideAgreed.has(id)) {
      const go = await new Promise<boolean>((resolve) =>
        Alert.alert(
          '在这里继续？',
          heldConfirmText(openOutside),
          [
            { text: '取消', style: 'cancel', onPress: () => resolve(false) },
            { text: '在这里继续', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      )
      if (!go) throw new SendCancelled()
      outsideAgreed.add(id)
    }
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

  // Out of the computer's reach a message waits on the phone, shown as the newest, and goes through
  // the same queue once the link is back. Handing the session to another agent needs the computer.
  const computerId = useComputerId()
  const queue = (message: OutboxMessage) => {
    if (computerId) queueMessage(computerId, { sessionId: id }, message)
  }
  const withdraw = useCallback(
    (itemId: string) => {
      if (!computerId) return
      void withdrawItem(computerId, itemId).then((back) => {
        if (back) composer.current?.restore(back.content, back.picked)
      })
    },
    [computerId],
  )
  const hasOutbox = useHasOutbox(id)
  const down = useLinkDown()

  // Into the running turn now: queued, then steered in, or the turn stopped and it sent next.
  const sendNow = async (content: UserContent[]) => {
    const { itemId } = (await link.request('sessions.queue', { sessionId: id, content })) as {
      itemId: string | null
    }
    if (!itemId) return
    // Once queued, a failed send-now leaves the message in the queue, not lost.
    link
      .request('sessions.sendNow', { sessionId: id, itemId })
      .catch((error: unknown) => Alert.alert('没能立即发送', hostErrorText(error)))
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
  const turn = useThreadSelector(view, selectTurn, sameFields)
  const app = session?.computer?.app ?? null
  const waitingYou = turn.phase === 'approval' || requests.length > 0
  const workingText =
    turn.asked ??
    (handBack
      ? `等你交还 ${app ?? '电脑'}`
      : asking
        ? '等待你的回答'
        : waitingYou && turn.phase !== 'approval'
          ? phaseText('approval', 1)
          : app && !QUIET_PHASES.has(turn.phase)
            ? `正在使用 ${app}`
            : doingText(turn))
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
          phase={turn.phase}
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

  const others = usableAgents(agents)
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
  // Between turns, a used-up plan suggests an agent with room; picking it waits for the message.
  const quota =
    agent && !pendingSwitch && !mustSwitch
      ? planQuota(
          { ...agent, limits: limitsForModel(agent.limits, config.model?.option) },
          Date.now(),
        )
      : null
  const fallback =
    agent && quota?.kind === 'out' && (status === 'ready' || status === 'closed')
      ? fallbackAgent(others, agent.id, Date.now())
      : null
  const [keptQuota, setKeptQuota] = useState(false)
  const suggestion = quota?.kind === 'out' && fallback && !keptQuota ? { quota, fallback } : null
  // The agent's predicted next prompt, over the empty box between turns until it is put away.
  const [promptDismissed, setPromptDismissed] = useState<string | null>(null)
  const predicted =
    session?.suggestion &&
    session.suggestion.id !== promptDismissed &&
    (status === 'ready' || status === 'closed') &&
    !pendingSwitch &&
    !mustSwitch
      ? session.suggestion
      : null
  const rejected = useThreadSelector(view, endedOnRejection)
  const shownName = pending?.name ?? agent?.name ?? 'Agent'
  const placeholder = sessionPlaceholder({
    agent: shownName,
    starting,
    pickAgent: mustSwitch && !pendingSwitch,
    awaiting,
    asking,
    running,
    steering,
    reached,
    rejected,
  })
  // A program outside that has the session open and at work writes to it, so nothing goes from
  // here until it is done; one that has it open but idle lets a message go once the user agrees.
  const heldOutside = session?.heldOutside === true
  const openOutside = session?.openOutside ?? null
  // Why Send does nothing now, for the line over the text.
  const unsendable =
    mustSwitch && !pendingSwitch
      ? '先选择 Agent'
      : starting
        ? `等 ${shownName} 启动后再发送`
        : heldOutside
          ? '等那边运行完再发送'
          : null

  const titlePages = summary
    ? sessionMenuPages({
        summary,
        session,
        agent,
        actions,
        canFork,
        muted,
        onMute: () => void setMuted(id, !muted).then(() => haptic.success()),
        onFork: (worktree) => fork(null, worktree),
        onNewSubSession: newChild,
        onShowParent: () => summary.parentId && openSession(summary.parentId),
        onOpenUrl: (url) => void Linking.openURL(url),
      })
    : null

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
      case 'title-prs':
        return titlePages?.(page) ?? null
      case 'more-menu':
        return moreMenu()
      case 'plan':
        return planPage(pinned, planRunning)
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

  const outbox = useMemo(() => <OutboxRows sessionId={id} onWithdraw={withdraw} />, [id, withdraw])
  let body
  if (view.error && !hasThread) {
    // A read that failed with nothing kept to show: why, and a way to try again, which it also
    // does by itself a while later.
    body = (
      <View style={{ flex: 1, paddingBottom: dockHeight }}>
        <StateView text={view.error} tone="danger" retry={view.retry} />
      </View>
    )
  } else if (!hasThread && hasOutbox && !connected) {
    // Nothing of the conversation kept on the phone: what waits to go shows alone.
    body = (
      <ScrollView
        contentContainerStyle={[
          styles.outboxOnly,
          {
            paddingTop:
              headerHeight + 12 + (chips ? CHIPS_HEIGHT : 0) + (pinned ? PLAN_PILL_ROOM : 0),
            paddingBottom: dockHeight + 12,
          },
        ]}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
      >
        {outbox}
      </ScrollView>
    )
  } else if (!hasThread) {
    // Away from the computer with nothing kept of it, it says so rather than spin until it is back.
    body = (
      <View style={{ flex: 1, paddingBottom: dockHeight }}>
        {connected || !view.cacheRead ? (
          <StateView loading />
        ) : (
          <StateView
            icon={G.wifiOff}
            text={
              hostState.kind === 'reconnecting'
                ? '正在重新连接电脑，连上后就能打开这个会话。'
                : '和电脑断开了。手机上没有这个会话的记录，连上电脑后才能打开。'
            }
          />
        )}
      </View>
    )
  } else {
    body = (
      <Conversation
        view={view}
        sessionId={id}
        running={running}
        working={working}
        pending={outbox}
        fromParent={summary?.origin === 'user' && !!summary.parentId}
        paddingTop={headerHeight + 12 + (chips ? CHIPS_HEIGHT : 0) + (pinned ? PLAN_PILL_ROOM : 0)}
        scrolling={scrolling}
        waiting={running && (waitingYou || handBack || turn.asked !== null)}
        phase={turn.phase}
        dock={dock}
        keyboardOverlap={overlap}
      />
    )
    // The rows' file references open the folder's files.
    body = <FileRefs.Provider value={fileRefs}>{body}</FileRefs.Provider>
  }

  const linkDown = down && (hostState.kind === 'reconnecting' || hostState.kind === 'stopped')

  return (
    <SessionRows.Provider value={context}>
      {pane ? null : <Stack.Screen options={{ headerShown: false }} />}
      <View style={[styles.root, { backgroundColor: c.bg }]}>
        <KeyboardGestureArea interpolator="ios" style={{ flex: 1 }}>
          {body}
        </KeyboardGestureArea>

        {/* The dock floats over the conversation's end and rides the keyboard frame by frame on
            the UI thread; nothing under it is laid out again as the keyboard comes and goes. */}
        <KeyboardStickyView
          offset={{ closed: 0, opened: overlap }}
          style={[styles.dock, { backgroundColor: c.bg }]}
          onLayout={onDockLayout}
        >
          {(othersWaiting.length > 0 ||
            handBack ||
            credit !== null ||
            childWaiting ||
            worktreeWaits ||
            (session?.queue.length ?? 0) > 0) && (
            <ScrollView
              style={[
                styles.waiting,
                { maxHeight: window.height * (plansWaiting.length > 0 ? 0.2 : 0.55) },
              ]}
              contentContainerStyle={styles.waitingContent}
              keyboardShouldPersistTaps="handled"
            >
              {worktreeWaits && summary?.worktree ? (
                <WorktreeLine sessionId={id} worktree={summary.worktree} />
              ) : null}
              <HandBackCard sessionId={id} session={session} />
              {othersWaiting.map((entry) => (
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

          {plansWaiting.length > 0 && <PinnedPlans entries={plansWaiting} sessionId={id} />}

          {summary?.origin === 'subagent' && (
            <SubagentBar
              summary={summary}
              session={session}
              agentName={agent?.name ?? 'Agent'}
              bottomInset={insets.bottom}
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
              onOpenParent={openSession}
            />
          )}
          <Composer
            key={id}
            hidden={summary?.origin === 'subagent'}
            ref={composer}
            draft={id}
            agentName={shownName}
            placeholder={placeholder}
            onSend={send}
            {...(pendingSwitch ? {} : { onQueue: queue })}
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
              pendingSwitch ||
              heldOutside ||
              openOutside ||
              suggestion ||
              (cacheNoticeShown && holds) ||
              (predicted && !holds) ? (
                <>
                  {heldOutside || openOutside ? (
                    <HeldStrip by={openOutside ?? 'terminal'} busy={heldOutside} />
                  ) : null}
                  {predicted && !holds && (
                    <PromptSuggestionChip
                      text={predicted.text}
                      onUse={() => composer.current?.putBack(predicted.text)}
                      onDismiss={() => setPromptDismissed(predicted.id)}
                    />
                  )}
                  {suggestion && agent && (
                    <QuotaSuggestion
                      agentName={agent.name}
                      quota={suggestion.quota}
                      fallback={suggestion.fallback}
                      onSwitch={() => {
                        const next = agents.get(suggestion.fallback.agentId)
                        if (next) chooseAgent(next, null)
                      }}
                      onDismiss={() => setKeptQuota(true)}
                    />
                  )}
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
            stopping={stopping}
            onAttach={(anchor) =>
              menu.open('attach', anchor, { placement: 'above', align: 'start' })
            }
            attachMenu={(anchor) => ({
              root: 'attach',
              pages,
              popover: {
                pages: ['mention'],
                open: (page) => menu.open(page, anchor, { placement: 'above', align: 'start' }),
              },
            })}
            left={
              // The button and its menu are disabled alike: it looked disabled while setting
              // an option or starting, and still opened.
              <NativeMenu
                source={{ root: 'mode', pages }}
                disabled={!connected || config.setting !== null || starting}
              >
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
                <NativeMenu
                  source={{ root: 'model', pages }}
                  disabled={!connected}
                  align="trailing"
                >
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
                state={hostState}
                folder={project}
                path={changes.folder}
                changed={changes.count}
                branch={changes.branch}
                worktree={changes.worktree}
                {...(changes.folder && changes.repo !== false
                  ? { onFolderPress: changes.open }
                  : {})}
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
        </KeyboardStickyView>
      </View>

      <GlassHeader
        floating
        below={
          (chips ? CHIPS_HEIGHT : 0) +
          (pinned && hasThread ? PLAN_PILL_ROOM + (linkDown ? 42 : 0) : 0)
        }
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
            {/* Our popover, not the system's menu: a system menu cannot hold each row's count on
                its right, as 文件 1 and 改动 没有改动 read in Kettu. */}
            <RoundButton
              tone="glass"
              size={44}
              systemImage={G.more.sf}
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
          </View>
        }
      />
      {summary && chips ? (
        <SessionChips summary={summary} top={headerHeight} onOpenSession={openSession} />
      ) : null}
      {pinned && hasThread ? (
        <PlanPill
          items={pinned}
          running={planRunning}
          top={headerHeight + 6 + (chips ? CHIPS_HEIGHT : 0) + (linkDown ? 42 : 0)}
          anchor={planAnchor}
          scrolling={scrolling}
          onPress={() =>
            menu.open('plan', planAnchor, { placement: 'below', align: 'center', width: 340 })
          }
        />
      ) : null}
      {hasThread && view.error && !linkDown ? (
        <View style={[styles.banner, { top: headerHeight + 8 + (chips ? CHIPS_HEIGHT : 0) }]}>
          <PressScale
            onPress={view.retry}
            accessibilityRole="button"
            accessibilityLabel={`${view.error}，重试`}
            accessibilityLiveRegion="polite"
          >
            <GlassCapsule height={34} elevated style={styles.bannerPill}>
              <Icon icon={G.warning} size={14} color={c.warning} />
              <Text style={[styles.bannerText, { color: c.textSecondary }]} numberOfLines={1}>
                没能读到最新内容
              </Text>
              <Text style={[styles.bannerText, { color: c.tint }]}>重试</Text>
            </GlassCapsule>
          </PressScale>
        </View>
      ) : null}
      {linkDown && (hasThread || hasOutbox) && (
        <View
          pointerEvents="none"
          style={[styles.banner, { top: headerHeight + 8 + (chips ? CHIPS_HEIGHT : 0) }]}
          accessibilityLiveRegion="polite"
        >
          <GlassCapsule height={34} elevated style={styles.bannerPill}>
            {hostState.kind === 'reconnecting' ? (
              <ActivityIndicator size="small" color={c.textSecondary} />
            ) : (
              <Icon icon={G.wifiOff} size={14} color={c.danger} />
            )}
            <Text style={[styles.bannerText, { color: c.textSecondary }]}>
              {hostState.kind === 'reconnecting' ? '正在重新连接…' : '已和电脑断开'}
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
      {menu.render(pages)}
      {DEV ? <FrameMeter label="session" top={headerHeight + 4} /> : null}
    </SessionRows.Provider>
  )
}

/**
 * Plans that wait for approval, under the other cards and outside their scroll: a plan card is
 * long, and its buttons must stay in view on a short phone, with the keyboard up for its note.
 */
function PinnedPlans(props: { entries: ToolEntry[]; sessionId: string }) {
  const window = useWindowDimensions()
  const keyboard = useKeyboardState(pickKeyboard)
  const room = (window.height - keyboard) * 0.55
  return props.entries.map((entry) => (
    <View key={entry.id} style={styles.pinnedCard}>
      <PlanApprovalCard entry={entry} sessionId={props.sessionId} maxHeight={room} />
    </View>
  ))
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  working: { paddingTop: 2, paddingBottom: 4 },
  waiting: { flexGrow: 0 },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  waitingContent: { paddingHorizontal: 10, paddingTop: 8, gap: 10 },
  pinnedCard: { paddingHorizontal: 10, paddingTop: 8 },
  banner: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
  outboxOnly: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 12 },
  bannerPill: { gap: 8 },
  bannerText: { fontSize: 13, fontWeight: '500' },
})

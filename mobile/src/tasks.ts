// Tasks: a requirement run through a workflow, one session per step (src/shared/workflow.ts). The
// phone keeps the active computer's task list in one store per link, current by the computer's
// `task.changed` and `task.removed` events, which carry a task's full view; words and states follow
// the desktop's (src/renderer/src/features/tasks/model.ts, src/shared/locales/zh-CN/tasks.json),
// where a task is a 需求.

import { binnedOne, linkHasBin } from './recycleBin'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import type { HostEvent, HostParams } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import {
  LEGACY_OFFICIAL,
  usableWorkflow,
  type BlockedReason,
  type Pace,
  type StuckReason,
  type TaskStepSummary,
  type TaskSummary,
  type TaskView,
  type WireWorkflowEntry,
  type Workflow,
} from '@shared/workflow'
import { call } from './git'
import { useConnected, useMaybeLink, withinRefreshLimit } from './host'
import { clockOf, errorText } from './sessions'
import { haptic } from './ui/haptics'
import { elapsedText } from './ui/session/format'
import { useQuarterMinute } from './ui/session/now'

export const LANG = 'zh-CN'

/** Only these harnesses' agents can do a step. */
export const STEP_HARNESSES: readonly string[] = ['claude-code', 'codex']

export const PACES: { key: Pace; label: string }[] = [
  { key: 'quick', label: '快速' },
  { key: 'balanced', label: '均衡' },
  { key: 'thorough', label: '周全' },
]

export const PACE_TEXT: Record<Pace, string> = { quick: '快速', balanced: '均衡', thorough: '周全' }

export const ENDED_TEXT: Record<TaskSummary['status'], string> = {
  running: '进行中',
  done: '已完成',
  dropped: '不值得做',
  cancelled: '已取消',
}

/** A step's state in a word, as a card or a node says it. */
export type Word =
  | 'done'
  | 'running'
  | 'review'
  | 'yourTurn'
  | 'asking'
  | 'blocked'
  | 'needsYou'
  | 'failed'
  | 'waiting'

export const WORD_TEXT: Record<Word, string> = {
  done: '完成',
  running: '进行中',
  review: '等你审阅',
  yourTurn: '轮到你',
  asking: '等你回答',
  blocked: '开不了工',
  needsYou: '需要你',
  failed: '卡住了',
  waiting: '等待中',
}

export const STUCK_TEXT: Record<StuckReason, (step: string) => string> = {
  send_back_limit: (step) => `${step} 已经退回了工作流允许的次数。`,
  no_report: () => '提醒过一次之后，它的会话还是没上报就停了。',
  no_pick: () => '提醒过一次之后，它的会话还是没给下一步选人就停了。',
  picks_refused: () => '连续三次选人都不成立。',
  session_gone: () => '它的会话被删除了。',
  start_failed: () => '它的会话启动失败。',
  merge_failed: () => '汇合时合并分支失败。',
}

const UNUSABLE_TEXT: Record<
  Extract<BlockedReason, { kind: 'unusable' }>['why'],
  (agent: string) => string
> = {
  disabled: (agent) => `${agent} 已关闭。`,
  removed: (agent) => `${agent} 已被移除。`,
  harness: (agent) => `${agent} 不能做步骤，只有 Claude Code 和 Codex 能做。`,
  model: (agent) => `${agent} 不再列出固定时选的模型。`,
  effort: (agent) => `${agent} 不再提供固定时选的推理强度。`,
  no_kettu: (agent) => `${agent} 没有纸鸢的工具，步骤要用它上报。`,
  not_ready: (agent) => `${agent} 还没准备好。`,
}

/** Why a step cannot start, in words. */
export function blockedText(reason: BlockedReason, agentName: (id: string) => string): string {
  switch (reason.kind) {
    case 'limit': {
      const agent = agentName(reason.agentId)
      return reason.resetsAt
        ? `${agent} 的套餐额度用完了。到 ${clockOf(reason.resetsAt)} 自动开始，除非你固定别的 Agent。`
        : `${agent} 的套餐额度用完了。`
    }
    case 'unusable':
      return UNUSABLE_TEXT[reason.why](agentName(reason.agentId))
    case 'tools':
      return `它要用 ${reason.missing.join('、')}，这台电脑上没装或已关掉。在市场里装好后重试。`
    case 'no_agent':
      return '没有允许 Auto 选的 Agent。去 设置 › Agent 打开一个，或者固定一个。'
    case 'no_picker':
      return '没有步骤交棒给它，需要你固定一个 Agent。'
    case 'picking':
      return '它在等前一步选人。'
  }
}

/** A step's name in Chinese when the workflow has one. */
export function stepTitle(
  workflow: Workflow | undefined,
  stepId: string,
  fallback?: string,
): string {
  return (
    workflow?.locales[LANG]?.steps?.[stepId] ??
    workflow?.steps.find((s) => s.id === stepId)?.name ??
    fallback ??
    stepId
  )
}

export function workflowTitle(task: TaskSummary, view?: TaskView): string {
  return view?.workflow.locales[LANG]?.name ?? task.workflowName
}

export function entryName(entry: WireWorkflowEntry): string {
  return entry.workflow?.locales[LANG]?.name ?? entry.name
}

export function entryDescription(entry: WireWorkflowEntry): string {
  return entry.workflow?.locales[LANG]?.description ?? entry.workflow?.description ?? ''
}

/** Step n of N: the furthest that started, while the task runs. */
export function progressText(task: TaskSummary): string | null {
  if (task.status !== 'running' || task.at === null) return null
  return `${task.at}/${task.steps.length}`
}

export function needsAttention(task: TaskSummary): boolean {
  return task.status === 'running' && task.needsYou && task.archivedAt === null
}

/** The step the row speaks of: what waits for you, what is stuck, what works, else the furthest. */
export function frontStep(task: TaskSummary): TaskStepSummary | null {
  return (
    task.steps.find((s) => s.state === 'needs_you') ??
    task.steps.find((s) => s.state === 'error') ??
    task.steps.find((s) => s.state === 'running') ??
    (task.at !== null ? task.steps[task.at - 1] : undefined) ??
    null
  )
}

/** The word for a step's state, from its round when the view is read; null for one not reached. */
export function stepWord(step: TaskStepSummary, view: TaskView | undefined): Word | null {
  switch (step.state) {
    case 'done':
      return 'done'
    case 'running':
      return 'running'
    case 'error':
      return 'failed'
    case 'waiting':
      return 'waiting'
    case 'not_reached':
      return null
    case 'needs_you': {
      if (!view) return 'needsYou'
      const round = view.rounds.findLast((r) => r.stepId === step.id)
      if (round?.state === 'reviewing') return 'review'
      if (round?.state === 'person') return 'yourTurn'
      if (round?.asking) return 'asking'
      if (view.waiting.some((w) => w.stepId === step.id && w.blocked)) return 'blocked'
      return 'needsYou'
    }
  }
}

export function canDoSteps(harnessId: string): boolean {
  return STEP_HARNESSES.includes(harnessId)
}

/** The library's state of an entry, for its badge: null when it can start tasks. */
export function entryProblem(
  entry: WireWorkflowEntry,
): 'pending' | 'changed' | 'problems' | 'unreadable' | null {
  if (!entry.workflow) return 'unreadable'
  if (entry.problems.length > 0) return 'problems'
  if (entry.approval === 'pending') return 'pending'
  if (entry.approval === 'changed') return 'changed'
  return null
}

export const ENTRY_STATE_TEXT = {
  pending: '等你批准',
  changed: '已改动',
  problems: '有问题',
  unreadable: '无法读取',
} as const

export const ENTRY_STATE_TITLE = {
  pending: '你批准之后，它才能开始需求。',
  changed: '批准之后它又被改过；再批准一次才能使用。',
  problems: '修好它的问题之后，它才能开始需求。',
  unreadable: '它的文件读不出一个工作流。',
} as const

export function isApproved(entry: WireWorkflowEntry): boolean {
  return entry.approval === 'approved' || entry.approval === LEGACY_OFFICIAL
}

/** Who a workflow came from, as the library says it. */
export function sourceText(entry: WireWorkflowEntry): string {
  const origin = entry.origin
  if (origin?.kind === 'community') return `${origin.handle} · 社区`
  if (origin?.kind === 'github') {
    const owner = /github\.com\/([^/]+)/i.exec(origin.url)?.[1]
    return owner ? `${owner} · 社区` : '社区'
  }
  switch (entry.source) {
    case 'file':
      return '来自文件'
    case 'agent':
      return '由 Agent 创建'
    case 'user':
      return '由你编写'
    case LEGACY_OFFICIAL:
      // eslint-disable-next-line kettu/no-upstream-name -- the upstream's own listings, as the desktop names them
      return 'Kettu'
    default:
      return '社区'
  }
}

export { usableWorkflow }

/** How long a task or a step has gone, on the clock that ticks every 15 seconds. */
export const spanText = elapsedText

/** The time every 15 seconds while `on`, for a clock that counts up, on the screen's shared clock. */
export function useTick(on: boolean): number {
  return useQuarterMinute(on)
}

// The list, one store per link.

interface Snapshot {
  summaries: ReadonlyMap<string, TaskSummary>
  views: ReadonlyMap<string, TaskView>
  loaded: boolean
  error: string | null
  /** When the list was last read from the computer; null before. */
  syncedAt: number | null
}

interface Store {
  link: HostLink
  snapshot: Snapshot
  listeners: Set<() => void>
  reading: Promise<void> | null
}

const stores = new WeakMap<HostLink, Store>()

const EMPTY: Snapshot = {
  summaries: new Map(),
  views: new Map(),
  loaded: false,
  error: null,
  syncedAt: null,
}

function publish(store: Store, change: Partial<Snapshot>): void {
  store.snapshot = { ...store.snapshot, ...change }
  for (const listener of store.listeners) listener()
}

function receive(store: Store, view: TaskView): void {
  publish(store, {
    summaries: new Map(store.snapshot.summaries).set(view.id, view),
    views: new Map(store.snapshot.views).set(view.id, view),
  })
}

function drop(store: Store, taskId: string): void {
  const summaries = new Map(store.snapshot.summaries)
  const views = new Map(store.snapshot.views)
  summaries.delete(taskId)
  views.delete(taskId)
  publish(store, { summaries, views })
}

function readList(store: Store): Promise<void> {
  if (store.reading) return store.reading
  store.reading = withinRefreshLimit((signal) => call(store.link, 'tasks.list', undefined, signal))
    .then(
      (list) => {
        // A view read before keeps its detail; the list's summary is newer for the rest.
        const views = new Map<string, TaskView>()
        for (const summary of list) {
          const view = store.snapshot.views.get(summary.id)
          if (view && view.updatedAt >= summary.updatedAt) views.set(summary.id, view)
        }
        publish(store, {
          summaries: new Map(list.map((s) => [s.id, views.get(s.id) ?? s])),
          views,
          loaded: true,
          error: null,
          syncedAt: Date.now(),
        })
      },
      (failure: unknown) => publish(store, { loaded: true, error: errorText(failure) }),
    )
    .finally(() => {
      store.reading = null
    })
  return store.reading
}

function storeFor(link: HostLink): Store {
  const known = stores.get(link)
  if (known) return known
  const store: Store = { link, snapshot: EMPTY, listeners: new Set(), reading: null }
  stores.set(link, store)
  // The store lives as long as its link: switching computers makes a new link and a new store.
  link.onHostEvent((raw) => {
    const event = raw as HostEvent
    if (event.type === 'task.changed') receive(store, event.task)
    else if (event.type === 'task.removed') drop(store, event.taskId)
  })
  // A new connection may have missed events: the list is read again.
  let connected = false
  link.onState((state) => {
    const now = state.kind === 'connected'
    if (now && !connected) void readList(store)
    connected = now
  })
  if (link.state.kind === 'connected') void readList(store)
  return store
}

function useStore(): { store: Store | null; snapshot: Snapshot } {
  const link = useMaybeLink()
  const store = link ? storeFor(link) : null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!store) return () => {}
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    },
    [store],
  )
  const snapshot = useSyncExternalStore(subscribe, () => store?.snapshot ?? EMPTY)
  return { store, snapshot }
}

export interface TaskList {
  /** Not archived, newest change first. */
  tasks: TaskSummary[]
  views: ReadonlyMap<string, TaskView>
  loaded: boolean
  error: string | null
  syncedAt: number | null
  reload(): Promise<void>
}

export function useTaskList(): TaskList {
  const { store, snapshot } = useStore()
  const tasks = useMemo(
    () =>
      [...snapshot.summaries.values()]
        .filter((t) => t.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [snapshot.summaries],
  )
  const reload = useCallback(() => (store ? readList(store) : Promise.resolve()), [store])
  return {
    tasks,
    views: snapshot.views,
    loaded: snapshot.loaded,
    error: snapshot.error,
    syncedAt: snapshot.syncedAt,
    reload,
  }
}

export interface TaskData {
  summary: TaskSummary | null
  view: TaskView | null
  /** The list was read and has no such task, or the computer said it has none. */
  missing: boolean
  error: string | null
  reload(): Promise<void>
}

/** One task in full, read while its page shows and kept current by the computer's events. */
export function useTask(taskId: string): TaskData {
  const { store, snapshot } = useStore()
  const [error, setError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const connected = useConnected()

  const reload = useCallback(async () => {
    if (!store) return
    try {
      receive(store, await call(store.link, 'tasks.get', { taskId }))
      setError(null)
      setGone(false)
    } catch (failure) {
      const code = (failure as { code?: unknown } | null)?.code
      if (code === 'not_found') setGone(true)
      else setError(errorText(failure))
    }
  }, [store, taskId])

  useEffect(() => {
    if (connected) void reload()
  }, [connected, reload])

  // Deleted while it shows: the computer's event takes it out of the list.
  const summary = snapshot.summaries.get(taskId) ?? null
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (summary) setSeen(true)
  }, [summary])

  return {
    summary,
    view: snapshot.views.get(taskId) ?? null,
    missing: gone || (seen && !summary),
    error,
    reload,
  }
}

/** Sends a request that answers with the task's view, which the store takes at once. */
export async function taskRequest<
  M extends
    | 'tasks.review'
    | 'tasks.answer'
    | 'tasks.retry'
    | 'tasks.cancel'
    | 'tasks.note'
    | 'tasks.pin'
    | 'tasks.update'
    | 'tasks.start',
>(link: HostLink, method: M, params: HostParams<M>): Promise<TaskView> {
  const view = (await call(link, method, params)) as TaskView
  receive(storeFor(link), view)
  return view
}

/** Pins or unpins a task, saying so if it fails. */
export function togglePin(link: HostLink, task: TaskSummary): void {
  haptic.tap()
  taskRequest(link, 'tasks.update', { taskId: task.id, pinned: task.pinnedAt === null }).catch(
    (failure: unknown) =>
      Alert.alert(task.pinnedAt ? '没能取消置顶' : '没能置顶', errorText(failure)),
  )
}

/** Asks, then cancels a running task: its steps at work stop, and nothing is removed. */
export function confirmCancel(link: HostLink, task: TaskSummary): void {
  haptic.warning()
  Alert.alert(
    `取消“${task.title}”？`,
    task.branch
      ? '正在做的步骤会停下。它们的会话、需求的工作树和分支都留着。'
      : '正在做的步骤会停下。它们的会话留着，做过什么还能看。',
    [
      { text: '继续做', style: 'cancel' },
      {
        text: '取消需求',
        style: 'destructive',
        onPress: () => {
          taskRequest(link, 'tasks.cancel', { taskId: task.id }).then(
            () => haptic.success(),
            (failure: unknown) => Alert.alert('没能取消', errorText(failure)),
          )
        },
      },
    ],
  )
}

/** Asks, then deletes an ended task with its steps' sessions. */
export function confirmDelete(link: HostLink, task: TaskSummary, done?: () => void): void {
  haptic.warning()
  void linkHasBin(link).then((binOn) => askDeleteTask(link, task, binOn, done))
}

/** Huli: a computer whose Kite is older than the recycle bin deletes for good, as this says. */
function askDeleteTask(
  link: HostLink,
  task: TaskSummary,
  binOn: boolean,
  done: (() => void) | undefined,
): void {
  const what = binOn
    ? '需求和它各步骤的会话会移到回收站，可以在 设置 › 回收站 里恢复。'
    : '需求和它各步骤的会话删除后无法恢复。'
  Alert.alert(
    `删除“${task.title}”？`,
    task.branch ? `${what}分支 ${task.branch} 和它的工作树会留着。` : what,
    [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          call(link, 'tasks.delete', { taskId: task.id }).then(
            () => {
              drop(storeFor(link), task.id)
              haptic.success()
              done?.()
              binnedOne(link, 'task', task.id, task.title)
            },
            (failure: unknown) => Alert.alert('没能删除', errorText(failure)),
          )
        },
      },
    ],
  )
}

// The workflow library.

export interface Library {
  entries: WireWorkflowEntry[]
  loaded: boolean
  error: string | null
  reload(): Promise<void>
}

/** The computer's workflows, read while a screen shows them and again when the library changes. */
export function useWorkflowLibrary(): Library {
  const [entries, setEntries] = useState<WireWorkflowEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connected = useConnected()
  const link = useMaybeLink()

  const reload = useCallback(async () => {
    if (!link) return
    try {
      setEntries(await call(link, 'workflows.list', undefined))
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [link])

  useEffect(() => {
    if (connected) void reload()
  }, [connected, reload])

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw) => {
      if ((raw as HostEvent).type === 'workflows.changed') void reload()
    })
  }, [link, reload])

  return { entries: entries ?? [], loaded: entries !== null, error, reload }
}

// Which part of the 任务 tab shows: tasks or routines. Links set it before they open the tab.

export type TasksTabView = 'tasks' | 'routines'

let tabView: TasksTabView = 'tasks'
const tabListeners = new Set<() => void>()

export function setTasksTabView(view: TasksTabView): void {
  if (view === tabView) return
  tabView = view
  for (const listener of tabListeners) listener()
}

export function useTasksTabView(): TasksTabView {
  return useSyncExternalStore(
    (listener) => {
      tabListeners.add(listener)
      return () => tabListeners.delete(listener)
    },
    () => tabView,
  )
}

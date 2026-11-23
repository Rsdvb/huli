// The rows of the home list, from the sessions of one computer or of all of them: 需要你处理, 正在
// 运行 and 置顶 first, then the user's folders and the projects as groups that fold and show their
// latest few (按项目分组), or one list by time (按时间). A session shows once, in the first part that
// takes it; snoozed and settled ones show last, in 已推迟 and 已收起. Runs of one best-of-N group
// (同时交给几个 Agent) are one row, where their loudest run would be, that opens to the runs. Pure,
// so the screen only renders what this returns.

import type { SessionSummary } from '@shared/agent-host'
import type { SessionGroupRef } from '@shared/run-groups'
import { shownFolders, type SessionFolder } from '@shared/session-folders'
import type { TaskSummary } from '@shared/workflow'
import type { HomeGrouping } from './prefs'
import { folder as folderName, listOrder, needsYou } from './sessions'
import { parked } from './tidy'

/** A session with the computer it is on. */
export interface Placed {
  session: SessionSummary
  computer: string
}

export type GroupKind = 'folder' | 'project' | 'scratch'

export interface Group {
  key: string
  kind: GroupKind
  computer: string
  title: string
  count: number
  collapsed: boolean
  /** The folder a folder group stands for. */
  folder?: SessionFolder
  projectPath?: string
}

export type HomeItem =
  | { kind: 'section'; key: string; title: string; count: number; waiting?: boolean }
  | { kind: 'group'; key: string; group: Group }
  // `run`: a best-of-N run shown under its open group's row.
  | { kind: 'session'; key: string; placed: Placed; run?: true }
  | { kind: 'bestOf'; key: string; bestOf: BestOf }
  | { kind: 'task'; key: string; task: TaskSummary }
  | { kind: 'more'; key: string; group: string; hidden: number; total: number }

/** A best-of-N group in the list: its runs listed here, oldest first, and whether it is open. */
export interface BestOf {
  computer: string
  group: SessionGroupRef
  runs: Placed[]
  open: boolean
}

/** How many of a group's sessions show until it is opened all the way. */
export const GROUP_PREVIEW = 3

export interface HomeInput {
  /** Top-level sessions to list, of every computer shown, archived ones only when asked. */
  sessions: readonly Placed[]
  /** Each computer's folders, by computer id. */
  folders: ReadonlyMap<string, readonly SessionFolder[]>
  /** Project names, by `computer\0path`. */
  projectNames: ReadonlyMap<string, string>
  tasks: readonly TaskSummary[]
  /** Task ids whose waits count on the task rather than its sessions. */
  taskIds: ReadonlySet<string>
  grouping: HomeGrouping
  /** Project groups the user closed, by key. */
  collapsed: ReadonlySet<string>
  /** Groups opened past their first few, by key. */
  expanded: ReadonlySet<string>
  /** Empty folders show too, as places to drop into, unless a project filter is on. */
  showEmptyFolders: boolean
  /** Best-of-N groups opened to their runs, by `bestOfKey`. */
  openBestOf?: ReadonlySet<string>
  /** Huli: false while best-of-N is turned off on the computer: each run is a row of its own. */
  foldBestOf?: boolean
}

export const placedKey = (p: Placed) => `${p.computer}\0${p.session.id}`
export const projectKey = (computer: string, path: string) => `${computer}\0${path}`
export const bestOfKey = (computer: string, groupId: string) => `bestOf:${computer}\0${groupId}`

function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

const byOrder = (a: Placed, b: Placed) => listOrder(a.session, b.session)
const byTime = (a: Placed, b: Placed) => b.session.updatedAt - a.session.updatedAt

/**
 * The runs of each best-of-N group with two or more of them listed and not archived, by
 * `bestOfKey`, and the run that stands for the group in the list: one that waits for the user,
 * else one that runs, else the latest.
 */
function bestOfGroups(sessions: readonly Placed[]): Map<string, { runs: Placed[]; lead: Placed }> {
  const runs = new Map<string, Placed[]>()
  for (const p of sessions) {
    const group = p.session.group
    if (!group || p.session.archivedAt !== null) continue
    const key = bestOfKey(p.computer, group.id)
    runs.set(key, [...(runs.get(key) ?? []), p])
  }
  const rank = (p: Placed) => (needsYou(p.session) ? 2 : isRunning(p.session) ? 1 : 0)
  const out = new Map<string, { runs: Placed[]; lead: Placed }>()
  for (const [key, list] of runs) {
    if (list.length < 2) continue
    const lead = list.reduce((a, b) =>
      rank(b) > rank(a) || (rank(b) === rank(a) && b.session.updatedAt > a.session.updatedAt)
        ? b
        : a,
    )
    out.set(key, {
      runs: [...list].sort((a, b) => a.session.createdAt - b.session.createdAt),
      lead,
    })
  }
  return out
}

export function homeItems(input: HomeInput): HomeItem[] {
  const out: HomeItem[] = []
  const taken = new Set<string>()
  const ownWait = (p: Placed) =>
    needsYou(p.session) && !(p.session.task && input.taskIds.has(p.session.task.taskId))
  const groups: ReturnType<typeof bestOfGroups> =
    input.foldBestOf === false ? new Map() : bestOfGroups(input.sessions)
  const leads = new Map<string, string>()
  const inGroup = new Set<string>()
  for (const [key, { runs, lead }] of groups) {
    leads.set(placedKey(lead), key)
    for (const run of runs) if (run !== lead) inGroup.add(placedKey(run))
  }
  // A group's lead stands for its runs in every part below; the others are not listed apart.
  const sessions = input.sessions.filter((p) => !inGroup.has(placedKey(p)))
  const sessionItems = (p: Placed): HomeItem[] => {
    const key = leads.get(placedKey(p))
    const group = key ? groups.get(key) : undefined
    if (!key || !group || !p.session.group) {
      return [{ kind: 'session', key: placedKey(p), placed: p }]
    }
    const open = input.openBestOf?.has(key) ?? false
    const head: HomeItem = {
      kind: 'bestOf',
      key,
      bestOf: { computer: p.computer, group: p.session.group, runs: group.runs, open },
    }
    if (!open) return [head]
    return [
      head,
      ...group.runs.map((run): HomeItem => ({
        kind: 'session',
        key: placedKey(run),
        placed: run,
        run: true,
      })),
    ]
  }
  const take = (list: Placed[]) => {
    for (const p of list) taken.add(placedKey(p))
    return list
  }
  // Huli: snoozed and settled sessions leave every part above for their own at the end (会话整理).
  const snoozed = take(
    sessions
      .filter((p) => parked(p.session) === 'snoozed')
      .sort((a, b) => (a.session.snooze?.until ?? 0) - (b.session.snooze?.until ?? 0)),
  )
  const settled = take(
    sessions
      .filter((p) => parked(p.session) === 'settled')
      .sort((a, b) => (b.session.settled?.at ?? 0) - (a.session.settled?.at ?? 0)),
  )
  const pushParked = () => {
    if (snoozed.length > 0) {
      out.push({ kind: 'section', key: '__snoozed', title: '已推迟', count: snoozed.length })
      for (const p of snoozed) out.push(...sessionItems(p))
    }
    if (settled.length > 0) {
      out.push({ kind: 'section', key: '__settled', title: '已收起', count: settled.length })
      const shown = input.expanded.has('__settled') ? settled : settled.slice(0, GROUP_PREVIEW)
      for (const p of shown) out.push(...sessionItems(p))
      if (settled.length > shown.length) {
        out.push({
          kind: 'more',
          key: 'more:__settled',
          group: '__settled',
          hidden: settled.length - shown.length,
          total: settled.length,
        })
      }
    }
  }
  const live = sessions.filter((p) => p.session.archivedAt === null && !parked(p.session))

  const needing = take(live.filter(ownWait).sort(byOrder))
  if (needing.length + input.tasks.length > 0) {
    out.push({
      kind: 'section',
      key: '__waiting',
      title: '需要你处理',
      count: needing.length + input.tasks.length,
      waiting: true,
    })
    for (const t of input.tasks) out.push({ kind: 'task', key: `task:${t.id}`, task: t })
    for (const p of needing) out.push(...sessionItems(p))
  }

  const running = take(
    live.filter((p) => !taken.has(placedKey(p)) && isRunning(p.session)).sort(byTime),
  )
  if (running.length > 0) {
    out.push({ kind: 'section', key: '__running', title: '正在运行', count: running.length })
    for (const p of running) out.push(...sessionItems(p))
  }

  const pinned = take(
    live
      .filter((p) => !taken.has(placedKey(p)) && p.session.pinnedAt !== null)
      // In the order they were pinned, as the desktop's sidebar and the 需求 list keep them.
      .sort((a, b) => (a.session.pinnedAt ?? 0) - (b.session.pinnedAt ?? 0)),
  )
  if (pinned.length > 0) {
    out.push({ kind: 'section', key: '__pinned', title: '置顶', count: pinned.length })
    for (const p of pinned) out.push(...sessionItems(p))
  }

  const rest = sessions.filter((p) => !taken.has(placedKey(p)))

  if (input.grouping === 'time') {
    const list = [...rest].sort(byTime)
    if (list.length > 0) {
      out.push({ kind: 'section', key: '__recent', title: '最近', count: list.length })
      for (const p of list) out.push(...sessionItems(p))
    }
    pushParked()
    return out
  }

  const pushGroup = (group: Omit<Group, 'count'>, members: Placed[]) => {
    const list = [...members].sort(byTime)
    out.push({ kind: 'group', key: group.key, group: { ...group, count: list.length } })
    if (group.collapsed) return
    const all = input.expanded.has(group.key)
    const shown = all ? list : list.slice(0, GROUP_PREVIEW)
    for (const p of shown) out.push(...sessionItems(p))
    if (list.length > shown.length) {
      out.push({
        kind: 'more',
        key: `more:${group.key}`,
        group: group.key,
        hidden: list.length - shown.length,
        total: list.length,
      })
    }
  }

  // Folders: each computer's, pinned first, in the user's order.
  const inFolder = new Map<string, Placed[]>()
  const folderOf = new Map<string, string>()
  for (const [computer, folders] of input.folders) {
    for (const f of folders) {
      for (const id of f.sessionIds) {
        const key = `${computer}\0${id}`
        if (!folderOf.has(key)) folderOf.set(key, `${computer}\0${f.id}`)
      }
    }
  }
  for (const p of rest) {
    const f = folderOf.get(placedKey(p))
    if (!f) continue
    inFolder.set(f, [...(inFolder.get(f) ?? []), p])
  }
  const folderGroups: { group: Omit<Group, 'count'>; members: Placed[] }[] = []
  for (const [computer, folders] of input.folders) {
    for (const f of shownFolders(folders)) {
      const members = inFolder.get(`${computer}\0${f.id}`) ?? []
      if (members.length === 0 && !input.showEmptyFolders) continue
      folderGroups.push({
        group: {
          key: `folder:${computer}\0${f.id}`,
          kind: 'folder',
          computer,
          title: f.name,
          collapsed: f.collapsed,
          folder: f,
        },
        members,
      })
    }
  }
  // Pinned folders of every computer before the rest.
  folderGroups.sort((a, b) => Number(!!b.group.folder?.pinned) - Number(!!a.group.folder?.pinned))
  if (folderGroups.length > 0) {
    out.push({ kind: 'section', key: '__folders', title: '文件夹', count: folderGroups.length })
    for (const { group, members } of folderGroups) pushGroup(group, members)
  }

  // Projects: the latest active first, 无项目 among them by its own latest.
  const byProject = new Map<string, { computer: string; path: string | null; list: Placed[] }>()
  for (const p of rest) {
    if (folderOf.has(placedKey(p))) continue
    const path = p.session.scratch ? null : p.session.projectPath
    const key = path === null ? `scratch:${p.computer}` : `project:${projectKey(p.computer, path)}`
    const entry = byProject.get(key) ?? { computer: p.computer, path, list: [] }
    entry.list.push(p)
    byProject.set(key, entry)
  }
  const projects = [...byProject.entries()].sort(
    (a, b) =>
      Math.max(...b[1].list.map((p) => p.session.updatedAt)) -
      Math.max(...a[1].list.map((p) => p.session.updatedAt)),
  )
  if (projects.length > 0) {
    out.push({
      kind: 'section',
      key: '__projects',
      title: folderGroups.length > 0 ? '未分组' : '项目',
      count: projects.length,
    })
    for (const [key, { computer, path, list }] of projects) {
      const title =
        path === null
          ? '无项目'
          : (input.projectNames.get(projectKey(computer, path)) ?? folderName(path))
      pushGroup(
        {
          key,
          kind: path === null ? 'scratch' : 'project',
          computer,
          title,
          collapsed: input.collapsed.has(key),
          ...(path !== null ? { projectPath: path } : {}),
        },
        list,
      )
    }
  }
  pushParked()
  return out
}

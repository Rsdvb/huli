// The rows of the home list, from the sessions of one computer or of all of them: 需要你处理, 正在
// 运行 and 置顶 first, then the user's folders and the projects as groups that fold and show their
// latest few (按项目分组), or one list by time (按时间). A session shows once, in the first part that
// takes it. Pure, so the screen only renders what this returns.

import type { SessionSummary } from '@shared/agent-host'
import { shownFolders, type SessionFolder } from '@shared/session-folders'
import type { TaskSummary } from '@shared/workflow'
import type { HomeGrouping } from './prefs'
import { folder as folderName, listOrder, needsYou } from './sessions'

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
  | { kind: 'session'; key: string; placed: Placed }
  | { kind: 'task'; key: string; task: TaskSummary }
  | { kind: 'more'; key: string; group: string; hidden: number; total: number }

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
}

export const placedKey = (p: Placed) => `${p.computer}\0${p.session.id}`
export const projectKey = (computer: string, path: string) => `${computer}\0${path}`

function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

const byOrder = (a: Placed, b: Placed) => listOrder(a.session, b.session)
const byTime = (a: Placed, b: Placed) => b.session.updatedAt - a.session.updatedAt

export function homeItems(input: HomeInput): HomeItem[] {
  const out: HomeItem[] = []
  const taken = new Set<string>()
  const ownWait = (p: Placed) =>
    needsYou(p.session) && !(p.session.task && input.taskIds.has(p.session.task.taskId))
  const sessionItem = (p: Placed): HomeItem => ({
    kind: 'session',
    key: placedKey(p),
    placed: p,
  })
  const take = (list: Placed[]) => {
    for (const p of list) taken.add(placedKey(p))
    return list
  }
  const live = input.sessions.filter((p) => p.session.archivedAt === null)

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
    for (const p of needing) out.push(sessionItem(p))
  }

  const running = take(
    live.filter((p) => !taken.has(placedKey(p)) && isRunning(p.session)).sort(byTime),
  )
  if (running.length > 0) {
    out.push({ kind: 'section', key: '__running', title: '正在运行', count: running.length })
    for (const p of running) out.push(sessionItem(p))
  }

  const pinned = take(
    live
      .filter((p) => !taken.has(placedKey(p)) && p.session.pinnedAt !== null)
      .sort((a, b) => (b.session.pinnedAt ?? 0) - (a.session.pinnedAt ?? 0)),
  )
  if (pinned.length > 0) {
    out.push({ kind: 'section', key: '__pinned', title: '置顶', count: pinned.length })
    for (const p of pinned) out.push(sessionItem(p))
  }

  const rest = input.sessions.filter((p) => !taken.has(placedKey(p)))

  if (input.grouping === 'time') {
    const list = [...rest].sort(byTime)
    if (list.length > 0) {
      out.push({ kind: 'section', key: '__recent', title: '最近', count: list.length })
      for (const p of list) out.push(sessionItem(p))
    }
    return out
  }

  const pushGroup = (group: Omit<Group, 'count'>, members: Placed[]) => {
    const list = [...members].sort(byTime)
    out.push({ kind: 'group', key: group.key, group: { ...group, count: list.length } })
    if (group.collapsed) return
    const all = input.expanded.has(group.key)
    const shown = all ? list : list.slice(0, GROUP_PREVIEW)
    for (const p of shown) out.push(sessionItem(p))
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
  return out
}

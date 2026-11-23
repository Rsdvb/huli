// Huli: dragging session rows in the sidebar. A row goes up or down within its group (a project's,
// No project's or a folder's), which keeps the user's own order from then on, or onto another
// project, which opens the move dialog. The split's drag (split/session-drag.tsx) drives it: its
// start measures the row's group once, each move hit-tests the sidebar and slides the rows it
// passes with `translate` alone, rendering nothing, and its drop saves the order on the host.
// Huli's own; see tools/huli/README.md (Session order).

import { useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import type { SessionSummary } from '@shared/agent-host'
import type { MoveProblem } from '@shared/session-move'
import { canOrder, withRowsMoved } from '@shared/session-order'
import { toast } from '@renderer/components/ui/toast'
import { orderFolder } from '@renderer/features/session-folders/store'
import { askMove, canMove, runningMove } from '@renderer/features/session/move/move'
import type { SessionDragData } from '@renderer/features/split/session-drag-model'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { noProjectKey, useProjectsStore } from '@renderer/stores/projects'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  clearSelection,
  selectionFor,
  useSessionSelection,
} from '@renderer/stores/session-selection'
import {
  hostOfSession,
  noProjectGroup,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'

/** A sidebar group whose rows can take the user's order, as it shows now. */
export interface RowGroup {
  /** Its key: the project's path, `noProjectGroup(hostId)`, or the folder's key. */
  key: string
  kind: 'project' | 'noProject' | 'folder'
  hostId: string | null
  /** The project's path; null for No project and a folder. */
  path: string | null
  folderId: string | null
  name: string
  /** Every row's id in the order shown, the ones past "Show more" included. */
  rows: readonly string[]
  /** For a folder, the sessions a row stands for where they are not its own id (best-of-N). */
  sessions?: ReadonlyMap<string, readonly string[]>
  /** The group's order: null while it goes by activity, undefined on a host that cannot keep one. */
  order: readonly string[] | null | undefined
  /** Its host is offline, or its folder is gone. */
  away: boolean
  missing: boolean
}

const groups = new Map<string, RowGroup>()

/** Lists the group for the drag and the menus while it shows, as of its latest render. */
export function useRowGroup(group: RowGroup | null): void {
  useLayoutEffect(() => {
    if (!group) return
    groups.set(group.key, group)
    return () => {
      if (groups.get(group.key) === group) groups.delete(group.key)
    }
  })
}

/** Whether the group's rows can be put in an order now. */
const orderable = (group: RowGroup): boolean =>
  canOrder(group.order) && !group.away && group.rows.length > 1

/** The group showing the session as one of its rows, if any. */
function groupOfRow(sessionId: string): RowGroup | null {
  for (const group of groups.values()) if (group.rows.includes(sessionId)) return group
  return null
}

// ---------------------------------------------------------------------------------------------
// Saving an order.

/** Shows the order at once, where the group's rows read it from. */
function showOrder(group: RowGroup, ids: string[] | null): void {
  if (group.kind === 'project') {
    useProjectsStore.setState((s) => ({
      projects: s.projects.map((p) => (p.path === group.path ? { ...p, sessionOrder: ids } : p)),
    }))
  } else if (group.kind === 'noProject') {
    const { noProjects, setNoProject } = useProjectsStore.getState()
    const current = noProjects[noProjectKey(group.hostId)]
    if (current) setNoProject(group.hostId, { ...current, sessionOrder: ids })
  }
}

/** Reads the group's host's projects again after a change it refused. */
function rereadProjects(hostId: string | null): void {
  const store = useProjectsStore.getState()
  void hostAt(hostId, 'projects.list', undefined)
    .then((projects) => store.setAll(projects, hostId))
    .catch(() => {})
  void hostAt(hostId, 'projects.noProject', undefined)
    .then((noProject) => store.setNoProject(hostId, noProject))
    .catch(() => {})
}

/**
 * Keeps `ids` as the group's order, or goes back to activity with null. `announce` says which way
 * the group just turned, with Undo, which puts back the order it had.
 */
async function saveOrder(
  group: RowGroup,
  ids: string[] | null,
  announce: 'manual' | 'activity' | null = null,
): Promise<void> {
  const before = group.order ?? null
  if (group.kind === 'folder') {
    const sessions = ids?.flatMap((id) => group.sessions?.get(id) ?? [id]) ?? null
    if (!(await orderFolder(group.hostId, group.folderId!, sessions))) return
  } else {
    flushSync(() => showOrder(group, ids))
    try {
      await hostAt(group.hostId, 'projects.orderSessions', { path: group.path, ids })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
      rereadProjects(group.hostId)
      return
    }
  }
  if (!announce) return
  const back = { ...group, order: ids }
  const values = { name: group.name }
  toast(
    announce === 'manual'
      ? i18n.t('sidebar:order.nowManual', values)
      : i18n.t('sidebar:order.nowActivity', values),
    {
      label: i18n.t('sidebar:row.undo'),
      onClick: () => void saveOrder(back, before ? [...before] : null),
    },
  )
}

/**
 * The project's or folder's menu: 手动排序 keeps the rows' order as they show now, 按最近活动排序
 * lets activity order them again, with Undo.
 */
export function setGroupOrder(key: string, mode: 'manual' | 'activity'): void {
  const group = groups.get(key)
  if (!group || !canOrder(group.order)) return
  if (mode === 'manual') {
    if (group.order) return
    void saveOrder(group, [...group.rows])
  } else if (group.order) {
    void saveOrder(group, null, 'activity')
  }
}

/** Where the session's row stands in its group, for its menu's 上移 and 下移; null where none. */
export function rowPlace(sessionId: string): { first: boolean; last: boolean } | null {
  const group = groupOfRow(sessionId)
  if (!group || !orderable(group)) return null
  const index = group.rows.indexOf(sessionId)
  return { first: index === 0, last: index === group.rows.length - 1 }
}

/** Moves the session's row one place up or down in its group, as its menu and Alt+arrows do. */
export function moveRow(sessionId: string, by: -1 | 1): void {
  const group = groupOfRow(sessionId)
  if (!group || !orderable(group)) return
  const index = group.rows.indexOf(sessionId)
  const neighbour = group.rows[index + by]
  if (neighbour === undefined) return
  const next =
    by < 0
      ? withRowsMoved(group.rows, [sessionId], { before: neighbour })
      : withRowsMoved(group.rows, [sessionId], { after: neighbour })
  void saveOrder(group, next, group.order ? null : 'manual')
}

// ---------------------------------------------------------------------------------------------
// The drag.

interface Item {
  id: string
  el: HTMLElement
  /** From the list's top, and its height, as measured when the drag started. */
  top: number
  height: number
  shift: number
}

interface Sorting {
  group: RowGroup
  list: HTMLElement
  items: Item[]
  source: Item
  moving: ReadonlySet<string>
  /** Where the source would go among the other rows, null while the pointer is elsewhere. */
  target: number | null
}

interface Over {
  key: string
  head: HTMLElement | null
  list: HTMLElement | null
  /** Why the drop cannot go there; null where it can. */
  why: string | null
}

/** Where a group's header or its rows lie, in the window, as measured at the latest scan. */
interface Zone {
  key: string
  el: HTMLElement
  head: boolean
  box: DOMRect
}

/** The sidebar as measured: its box, its list's visible box, the groups' zones. */
interface Layout {
  side: DOMRect | null
  nav: DOMRect | null
  zones: Zone[]
}

interface RowDrag {
  ids: string[]
  sorting: Sorting | null
  over: Over | null
  /** Measured once and again only when something scrolls, so a move reads no layout. */
  layout: Layout | null
  /** The verdict on each group the pointer has been over, so a hover asks once. */
  verdicts: Map<string, string | null>
  point: { x: number; y: number } | null
  inSidebar: boolean
  /** The chip stands off the pointer, so the rows and the line under it show. */
  chipAside: boolean
  /** Where the pointer took the row, from the row's corner, where the chip's corner starts. */
  grab: { x: number; y: number }
}

let drag: RowDrag | null = null

const sideList = (): HTMLElement | null => document.querySelector('.kettu-side-list')

/** A row's id, as its own row element carries it; null for what is no row, as Show more. */
function rowIdOf(li: Element): string | null {
  const row = li.querySelector<HTMLElement>('[data-session-id], [data-task-id], [data-group-id]')
  return row?.dataset.sessionId ?? row?.dataset.taskId ?? row?.dataset.groupId ?? null
}

/** The sessions a drag of this one carries: the picked ones when it is one of them. */
function dragged(sessionId: string): string[] {
  const picked = selectionFor(sessionId, useSessionSelection.getState().ids)
  return picked ? [...picked] : [sessionId]
}

/**
 * The row's group, measured, when the dragged sessions are rows of it that can be reordered. Rows
 * slid by `translate` keep their place in the layout, so the measures hold the whole drag.
 */
function measure(row: Element, ids: readonly string[]): Sorting | null {
  const li = row.closest('li')
  const list = li?.parentElement
  const key = list?.dataset.rowGroup
  const group = key ? groups.get(key) : undefined
  if (!li || !list || !group || !orderable(group)) return null
  if (!ids.every((id) => group.rows.includes(id))) return null
  const origin = list.getBoundingClientRect().top
  const items = Array.from(list.children).flatMap((el): Item[] => {
    const id = el instanceof HTMLElement ? rowIdOf(el) : null
    if (!id) return []
    const box = (el as HTMLElement).getBoundingClientRect()
    return [{ id, el: el as HTMLElement, top: box.top - origin, height: box.height, shift: 0 }]
  })
  const source = items.find((item) => item.el === li)
  if (!source || items.length < 2) return null
  return { group, list, items, source, moving: new Set(ids), target: null }
}

/** A drag of a session began, from its sidebar row `element` or a pane's title. */
export function rowDragStarted(
  data: SessionDragData,
  element: Element | undefined,
  point: { x: number; y: number },
): void {
  const ids = dragged(data.sessionId)
  const inList = !data.paneId && element?.closest('.kettu-side-list')
  const box = element?.getBoundingClientRect()
  drag = {
    ids,
    sorting: inList ? measure(element!, ids) : null,
    over: null,
    // Measured now, while the drag's start has just read the layout, so it costs no layout of its own.
    layout: scan(),
    verdicts: new Map(),
    point: null,
    inSidebar: false,
    chipAside: false,
    grab: box ? { x: point.x - box.left, y: point.y - box.top } : { x: 0, y: 0 },
  }
  // The list may scroll under a pointer at rest, near its edge; the place follows it.
  document.addEventListener('scroll', rescan, { capture: true, passive: true })
}

/** The sidebar's list scrolled under the pointer: measured again, and the place follows. */
function rescan(event: Event): void {
  if (!drag || !(event.target instanceof Element) || !event.target.closest('.ui-as-side')) return
  drag.layout = null
  if (drag.point) rowDragMoved(drag.point)
}

/** Measures the sidebar and its groups' headers and rows, once a scroll. */
function scan(): Layout {
  const side = document.querySelector('.ui-as-side')?.getBoundingClientRect() ?? null
  const nav = document.querySelector('.ui-as-side__nav')?.getBoundingClientRect() ?? null
  const zones = Array.from(
    sideList()?.querySelectorAll<HTMLElement>('[data-row-group], [data-row-group-head]') ?? [],
    (el): Zone => ({
      key: el.dataset.rowGroup ?? el.dataset.rowGroupHead ?? '',
      el,
      head: el.dataset.rowGroupHead !== undefined,
      box: el.getBoundingClientRect(),
    }),
  )
  return { side, nav, zones }
}

const inside = (box: DOMRect | null, point: { x: number; y: number }): boolean =>
  !!box && point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom

/**
 * Slides the rows so the source takes `target`'s place, or puts them all back with null. The list's
 * `data-sorting` gives them their transition, which stays until the drag is over.
 */
function slide(sorting: Sorting, target: number | null): void {
  if (target === sorting.target) return
  sorting.target = target
  const { items, source, list } = sorting
  if (target === null) {
    for (const item of items) setShift(item, 0)
    delete source.el.dataset.sortSource
    for (const item of items) delete item.el.dataset.sortCarried
    return
  }
  if (list.dataset.sorting === undefined && !prefersReducedMotion()) list.dataset.sorting = ''
  source.el.dataset.sortSource = ''
  for (const item of items) {
    if (item !== source && sorting.moving.has(item.id)) item.el.dataset.sortCarried = ''
  }
  // The rows as they would stand, each at the sum of the heights before it.
  const others = items.filter((item) => item !== source)
  const placed = [...others.slice(0, target), source, ...others.slice(target)]
  let top = items[0]!.top
  for (const item of placed) {
    setShift(item, top - item.top)
    top += item.height
  }
}

function setShift(item: Item, shift: number): void {
  if (item.shift === shift) return
  item.shift = shift
  item.el.style.translate = shift ? `0 ${shift}px` : ''
}

/** Where among the other rows the source would go for a pointer at `y` over its list's `box`. */
function targetAt(sorting: Sorting, box: DOMRect, y: number): number {
  const local = y - box.top
  let target = 0
  for (const item of sorting.items) {
    if (item !== sorting.source && item.top + item.height / 2 < local) target++
  }
  return target
}

/**
 * Over the sidebar the chip moves to the pointer's lower right, as the system's drag image does,
 * so it hides neither the line nor the project it would drop on; elsewhere it is where it was.
 */
function placeChip(current: RowDrag): void {
  if (current.inSidebar === current.chipAside) return
  const chip = document.querySelector('[data-dnd-overlay]')?.firstElementChild
  if (!(chip instanceof HTMLElement)) return
  current.chipAside = current.inSidebar
  // The chip's corner follows the pointer from where the row's was, so no layout is read here.
  const { x, y } = current.grab
  chip.style.translate = current.inSidebar ? `${Math.round(x + 14)}px ${Math.round(y + 12)}px` : ''
}

/** Marks another group as where the drop goes, or no group with null. */
function mark(over: Over | null): void {
  const before = drag?.over
  if (before?.key === over?.key && before?.why === over?.why) return
  if (before?.why === null) {
    delete before.head?.dataset.moveTarget
    delete before.list?.dataset.moveTarget
  }
  if (over?.why === null) {
    if (over.head) over.head.dataset.moveTarget = ''
    if (over.list) over.list.dataset.moveTarget = ''
  }
  if (drag) drag.over = over
}

/**
 * Follows the pointer: true while it is over the sidebar, whose drop is its own then, never the
 * split's.
 */
export function rowDragMoved(point: { x: number; y: number }): boolean {
  if (!drag) return false
  drag.point = point
  const layout = (drag.layout ??= scan())
  const inSidebar = inside(layout.side, point)
  drag.inSidebar = inSidebar
  placeChip(drag)
  // Only what shows in the list's view counts, not a group scrolled under its top.
  const zone =
    inSidebar && inside(layout.nav, point)
      ? layout.zones.find((item) => inside(item.box, point))
      : undefined
  const key = zone?.key ?? null
  const { sorting } = drag
  if (sorting && zone && key === sorting.group.key) {
    mark(null)
    slide(sorting, zone.head ? 0 : targetAt(sorting, zone.box, point.y))
    return true
  }
  if (sorting) slide(sorting, null)
  const group = key ? groups.get(key) : undefined
  if (!group || !zone) {
    mark(null)
    return inSidebar
  }
  if (!drag.verdicts.has(key!)) drag.verdicts.set(key!, moveProblem(drag.ids, group))
  const why = drag.verdicts.get(key!) ?? null
  const part = (head: boolean) =>
    layout.zones.find((item) => item.key === group.key && item.head === head)?.el ?? null
  mark({ key: group.key, head: part(true), list: part(false), why })
  return true
}

/**
 * Ends the drag: a row's new place is saved, a drop on another project opens the move dialog, and
 * one it cannot take says why. `skip` when the drag was canceled or another target took it. True
 * when the sidebar took the drop, which the split then leaves alone.
 */
export function rowDragEnded(skip: boolean): boolean {
  const current = drag
  document.removeEventListener('scroll', rescan, { capture: true })
  if (!current) return false
  const { sorting, over } = current
  mark(null)
  drag = null
  const target = skip ? null : (sorting?.target ?? null)
  if (sorting) {
    const { list } = sorting
    if (target !== null) {
      // The rows land where they stand, without sliding back first.
      delete list.dataset.sorting
      drop(sorting, target)
      slide(sorting, null)
    } else {
      slide(sorting, null)
      settle(list)
    }
  }
  if (skip) return false
  if (target !== null) return true
  if (over) {
    if (over.why === null) openMove(current.ids, over.key)
    else if (over.why) toast(over.why, undefined, { tone: 'warning' })
    return true
  }
  return current.inSidebar
}

let settling: { list: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null

/** Lets the rows slide back into place, then takes the list's transition away. */
function settle(list: HTMLElement): void {
  if (settling) clearTimeout(settling.timer)
  settling = {
    list,
    timer: setTimeout(() => {
      if (!drag?.sorting || drag.sorting.list !== list) delete list.dataset.sorting
      settling = null
    }, 400),
  }
}

/** Saves the order a drop gives the group, unless it changed nothing. */
function drop(sorting: Sorting, target: number): void {
  const { group, items, source, moving } = sorting
  const others = items.filter((item) => item !== source)
  // The first row staying put at or after the place, else the last one before it.
  const below = others.slice(target).find((item) => !moving.has(item.id))
  const above = others
    .slice(0, target)
    .reverse()
    .find((item) => !moving.has(item.id))
  const order = group.rows.filter((id) => moving.has(id))
  const next = withRowsMoved(
    group.rows,
    order,
    below ? { before: below.id } : above ? { after: above.id } : { before: null },
  )
  if (next.every((id, index) => id === group.rows[index])) return
  clearSelection()
  void saveOrder(group, next, group.order ? null : 'manual')
}

// ---------------------------------------------------------------------------------------------
// Onto another project.

const BUSY = new Set(['starting', 'running', 'awaiting_permission'])

function online(hostId: string | null): boolean {
  if (hostId === null) return true
  const host = otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
  return host?.connection.state === 'online'
}

/** The group a session's row shows in, by its key, for its own project or No project. */
const homeOf = (summary: SessionSummary): string =>
  summary.scratch ? noProjectGroup(hostOfSession(summary)) : summary.projectPath

/** Why one session cannot move into the project; null when the move code may take it. */
function sessionProblem(summary: SessionSummary, group: RowGroup): string | null {
  const problem = (key: MoveProblem): string =>
    i18n.t(`session:move.problems.${key}`, { agent: '' })
  if (summary.scratch) return problem('noProject')
  if (summary.parentId !== null || summary.origin === 'subagent') return problem('subagent')
  if (summary.manager) return problem('manager')
  if (summary.worker) return problem('worker')
  if (summary.prepared) return problem('prepared')
  if (summary.movedTo) return i18n.t('sidebar:rowDrag.moved')
  if (BUSY.has(summary.status) || runningMove(summary.id)) return problem('busy')
  const from = hostOfSession(summary)
  if (!online(from) || !online(group.hostId)) return problem('offline')
  return null
}

/**
 * Why the dragged sessions cannot move into the group: '' for their own group or a folder, where
 * no move is meant; null when the move dialog may open.
 */
function moveProblem(ids: readonly string[], group: RowGroup): string | null {
  const { byId } = useSessionsStore.getState()
  const summaries = ids.flatMap((id) => (byId[id] ? [byId[id]] : []))
  if (summaries.length === 0 || group.kind === 'folder') return ''
  if (summaries.every((summary) => homeOf(summary) === group.key)) return ''
  if (!canMove()) return i18n.t('sidebar:rowDrag.noWindow')
  if (group.kind === 'noProject') return i18n.t('sidebar:rowDrag.noProjectTarget')
  if (group.missing) return i18n.t('sidebar:rowDrag.missing')
  for (const summary of summaries.filter((item) => homeOf(item) !== group.key)) {
    const why = sessionProblem(summary, group)
    if (!why) continue
    return summaries.length > 1
      ? i18n.t('sidebar:rowDrag.oneOf', { title: sessionTitle(summary), why })
      : why
  }
  return null
}

function openMove(ids: readonly string[], key: string): void {
  const group = groups.get(key)
  const { byId } = useSessionsStore.getState()
  // Ones already in the project stay out of the move.
  const summaries = ids.flatMap((id) =>
    byId[id] && group && homeOf(byId[id]) !== group.key ? [byId[id]] : [],
  )
  const [first, ...more] = summaries
  if (!group?.path || !first) return
  clearSelection()
  askMove(first, {
    more,
    dropped: { host: group.hostId, projectPath: group.path, projectName: group.name },
  })
}

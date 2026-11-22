import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { readJson, writeJson } from '@renderer/lib/storage'
import { liveTree, useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { countByState, overviewRows, type OverviewRow, type OverviewState } from './model'

/** The page's rows, from the tasks and sessions every connected host lists. */
export function useOverviewRows(): OverviewRow[] {
  const tasks = useTasksStore((s) => s.summaries)
  const byId = useSessionsStore((s) => s.byId)
  return useMemo(() => overviewRows(tasks, liveTree(byId)), [tasks, byId])
}

/** The count for the last tasks and sessions it was taken of, which most store changes keep. */
let counted: { tasks: unknown; byId: unknown; count: number } | null = null

/**
 * What is for the user: ready to take, or waiting for an answer. Selected as the number alone: the
 * sidebar's menu reads it, and a change to any session re-rendered the whole window's frame.
 */
export function useOverviewCount(): number {
  const tasks = useTasksStore((s) => s.summaries)
  return useSessionsStore((s) => {
    if (counted?.tasks !== tasks || counted.byId !== s.byId) {
      const counts = countByState(overviewRows(tasks, liveTree(s.byId)))
      counted = { tasks, byId: s.byId, count: counts.ready + counts.you }
    }
    return counted.count
  })
}

// Huli: `board`, the user's task board (features/task-board).
export type OverviewView = 'inbox' | 'flow' | 'timeline' | 'board'
export type GroupBy = 'state' | 'project'

interface Prefs {
  view: OverviewView
  groupBy: GroupBy
  /** Huli: the project the board shows, null for every project. */
  boardProject: string | null
}

const KEY = 'kettu:overview'
const DEFAULTS: Prefs = { view: 'flow', groupBy: 'state', boardProject: null }
const listeners = new Set<() => void>()
let prefs: Prefs = { ...DEFAULTS, ...readJson<Partial<Prefs>>(KEY, {}) }

/** How the page was last looked at, kept across launches. */
export function useOverviewPrefs(): [Prefs, (change: Partial<Prefs>) => void] {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => prefs,
  )
  return [
    current,
    (change) => {
      prefs = { ...prefs, ...change }
      writeJson(KEY, prefs)
      listeners.forEach((listener) => listener())
    },
  ]
}

/** Reads the full view of each listed task once, for its documents and its workflow's names. */
export function useTaskViews(rows: readonly OverviewRow[]): void {
  const ids = rows.flatMap((row) => (row.kind === 'task' ? [row.task.id] : [])).join('\n')
  useEffect(() => {
    if (!ids) return
    const { views, read } = useTasksStore.getState()
    for (const id of ids.split('\n')) if (!views[id]) void read(id).catch(() => undefined)
  }, [ids])
}

export type StateFilter = OverviewState | 'all'

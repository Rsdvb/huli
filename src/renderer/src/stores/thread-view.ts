import { create } from 'zustand'
import { isToolCallView, type ToolCallView } from '@shared/zen-view'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useEntry } from '@renderer/lib/features'
import { useSettingsStore } from './settings'

// Huli: each session's own choice of how much of its agent's work the thread shows (简洁视图),
// kept on this device in localStorage; a session without one follows Settings > General.

const KEY = 'thread-view'
/** The most sessions whose choice is kept; the oldest go first. */
const MAX_KEPT = 300

function load(): Record<string, ToolCallView> {
  const stored = readJson<unknown>(KEY, null)
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, ToolCallView] =>
      isToolCallView(entry[1]),
    ),
  )
}

export const useThreadView = create<{ bySession: Record<string, ToolCallView> }>(() => ({
  bySession: load(),
}))

/** Sets a session's own choice, or null to follow the settings again. */
export function setThreadView(sessionId: string, view: ToolCallView | null): void {
  useThreadView.setState((s) => {
    const bySession = { ...s.bySession }
    delete bySession[sessionId]
    if (view !== null) bySession[sessionId] = view
    const ids = Object.keys(bySession)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) delete bySession[id]
    writeJson(KEY, bySession)
    return { bySession }
  })
}

/** The view the settings give a session without its own choice. */
export function useDefaultThreadView(): ToolCallView {
  return useSettingsStore((s) => s.settings.thread.toolCalls ?? 'all')
}

/** How much of its agent's work the session's thread shows: its own choice, else the settings'. */
export function useToolCallView(sessionId: string): ToolCallView {
  const on = useEntry('session.zenView')
  const own = useThreadView((s) => s.bySession[sessionId])
  const fallback = useDefaultThreadView()
  return on ? (own ?? fallback) : 'all'
}

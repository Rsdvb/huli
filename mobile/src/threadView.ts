// Huli: each session's choice of how much of its agent's work the conversation shows (简洁视图),
// kept with the phone's preferences; a session without one shows everything.

import type { ToolCallView } from '@shared/zen-view'
import { useEntryOn } from './host'
import { getPrefs, setPrefs, usePref } from './prefs'

/** The most sessions whose choice is kept; the oldest go first. */
export const THREAD_VIEWS_KEPT = 200

export const VIEW_LABEL: Record<ToolCallView, string> = {
  all: '全部显示',
  hideSuccessful: '隐藏成功的工具调用',
  conclusions: '只看结论',
}

/** The session's view: its own choice, or everything; everything while the feature is off. */
export function useThreadViewOf(sessionId: string): ToolCallView {
  const views = usePref('threadViews')
  const on = useEntryOn('phone.zenView')
  return on ? (views[sessionId] ?? 'all') : 'all'
}

export function threadViewOf(sessionId: string): ToolCallView {
  return getPrefs().threadViews[sessionId] ?? 'all'
}

export function setThreadView(sessionId: string, view: ToolCallView): void {
  const views = { ...getPrefs().threadViews }
  delete views[sessionId]
  if (view !== 'all') views[sessionId] = view
  const ids = Object.keys(views)
  for (const id of ids.slice(0, Math.max(0, ids.length - THREAD_VIEWS_KEPT))) delete views[id]
  setPrefs({ threadViews: views })
}

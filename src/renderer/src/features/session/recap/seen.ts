import { parseSeenMarks, withSeen, type SeenMark } from '@shared/recap'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useThreadsStore } from '@renderer/stores/threads'

// Huli: where this device last saw each session, kept in localStorage, for the recap that greets
// the user when they come back to one. Written only when a session stops being looked at: its
// pane shows another, or the window goes to the back.

const KEY = 'session-seen'

let marks: Record<string, SeenMark> | null = null

function loaded(): Record<string, SeenMark> {
  marks ??= parseSeenMarks(readJson<unknown>(KEY, {}))
  return marks
}

export function seenMark(sessionId: string): SeenMark | null {
  return loaded()[sessionId] ?? null
}

/** Marks the session seen now, at its thread's last entry, when the replica holds its thread. */
export function markSeen(sessionId: string): void {
  const order = useThreadsStore.getState().replicas[sessionId]?.state?.order
  if (!order) return
  marks = withSeen(loaded(), sessionId, { at: Date.now(), entry: order.at(-1) ?? null })
  writeJson(KEY, marks)
}

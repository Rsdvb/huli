import { parseSeenMarks, withSeen, type SeenMark } from '@shared/recap'
import { readJson, writeJson } from '@renderer/lib/storage'

// Huli: where this device last saw each session, kept in localStorage, for the recap that greets
// the user when they come back to one. Written when a session comes into view, leaves it (its
// pane shows another, the window is hidden or closes) and when its recap is put away.

const KEY = 'session-seen'

let marks: Record<string, SeenMark> | null = null

function loaded(): Record<string, SeenMark> {
  marks ??= parseSeenMarks(readJson<unknown>(KEY, {}))
  return marks
}

export function seenMark(sessionId: string): SeenMark | null {
  return loaded()[sessionId] ?? null
}

export function markSeen(sessionId: string, mark: SeenMark): void {
  marks = withSeen(loaded(), sessionId, mark)
  writeJson(KEY, marks)
}

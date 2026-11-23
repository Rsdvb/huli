import { laterMark, parseSeenMarks, seenReporter, withSeen, type SeenMark } from '@shared/recap'
import { host } from '@renderer/lib/host'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useSessionsStore } from '@renderer/stores/sessions'

// Huli: where this device last saw each session, kept in localStorage, for the recap that greets
// the user when they come back to one. Written when a session comes into view, leaves it (its
// pane shows another, the window is hidden or closes) and when its recap is put away. Each mark
// also goes to the session's host when it keeps them (`SessionSummary.seen`), at most one per
// session every few seconds; the host keeps the latest of every device's, and a recap starts
// from the later of that and this device's.

const KEY = 'session-seen'

let marks: Record<string, SeenMark> | null = null

function loaded(): Record<string, SeenMark> {
  marks ??= parseSeenMarks(readJson<unknown>(KEY, {}))
  return marks
}

const reporter = seenReporter((sessionId, mark) => {
  void host('sessions.setSeen', { sessionId, at: mark.at, entry: mark.entry }).catch(() => {})
})

/** The host's mark of the session, the latest of its devices'; undefined from one keeping none. */
function hostMark(sessionId: string): SeenMark | null | undefined {
  return useSessionsStore.getState().byId[sessionId]?.seen
}

/** Where the user last saw the session: the later of this device's mark and its host's. */
export function seenMark(sessionId: string): SeenMark | null {
  return laterMark(loaded()[sessionId], hostMark(sessionId))
}

export function markSeen(sessionId: string, mark: SeenMark): void {
  marks = withSeen(loaded(), sessionId, mark)
  writeJson(KEY, marks)
  const known = hostMark(sessionId)
  if (known === undefined || (known !== null && known.at >= mark.at)) return
  reporter.report(sessionId, mark)
}

/** Sends the marks that wait for their turn now, as the window goes. */
export function flushSeen(): void {
  reporter.flush()
}

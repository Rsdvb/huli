// Huli: what happened in a session while the user was away from it, for the one line that greets
// them when they come back. Worked out from the thread's entries alone, with no model, so the
// desktop and the phone always say the same.

import type { DigestedThreadEntry, ThreadEntry } from './thread'

/** How long the user has to have been away for coming back to show a recap. */
export const RECAP_AWAY_MS = 30 * 60_000

/** The most sessions a device keeps a seen mark for; the least recently seen go first. */
export const SEEN_MARKS_KEPT = 300

/** Where a device last saw a session: when, and the thread's last entry then (null if empty). */
export interface SeenMark {
  at: number
  entry: string | null
}

export interface Recap {
  /** The first entry since the user left, where "jump to where you left off" goes. */
  from: string
  /** Distinct files the agent changed, and the lines it added and removed in them. */
  files: number
  added: number
  removed: number
  /** Commands it ran. */
  commands: number
  /** Requests that asked the user, answered or not. */
  approvals: number
  /** Of those, the ones still waiting. */
  waiting: number
  /** Errors that ended a turn or stopped the agent. */
  errors: number
  /** The latest reply's first line as plain text, or null when the agent wrote none. */
  reply: string | null
  /**
   * The entry the user left at lies on a page not loaded, so the counts start at the loaded
   * ones and may be short: a client shows them as "at least" (16+).
   */
  partial: boolean
}

type Entry = ThreadEntry | DigestedThreadEntry

export interface RecapThread {
  order: readonly string[]
  byId: Readonly<Record<string, Entry | undefined>>
}

/** How long a reply's line may run; a client shortens it further to fit. */
const REPLY_CHARS = 160

/** The lines in a text, a final newline ending its last line rather than starting another. */
function lineCount(text: string): number {
  if (text === '') return 0
  let count = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++
  return text.endsWith('\n') ? count - 1 : count
}

/** The most edits a diff is counted through before the cheap bound stands in for it. */
const MOST_EDITS = 400

/**
 * The lines added and removed between `a` and `b`, by the shortest edit script (Myers' O(ND)
 * search), or null when it takes more than MOST_EDITS edits.
 */
function editCounts(
  a: readonly string[],
  b: readonly string[],
): { added: number; removed: number } | null {
  const n = a.length
  const m = b.length
  const most = Math.min(n + m, MOST_EDITS)
  const offset = most + 1
  const v = new Array<number>(2 * most + 3).fill(0)
  for (let d = 0; d <= most; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        const same = (n + m - d) / 2
        return { added: m - same, removed: n - same }
      }
    }
  }
  return null
}

/**
 * Lines added and removed from `oldText` to `newText`, as a diff counts them; for a change of
 * more than a few hundred lines, what lies between the lines both start and end with, an upper
 * bound that never spends long on one diff.
 */
export function changedLines(
  oldText: string | null,
  newText: string,
): { added: number; removed: number } {
  if (oldText === null || oldText === '') return { added: lineCount(newText), removed: 0 }
  if (oldText === newText) return { added: 0, removed: 0 }
  const before = oldText.split('\n')
  const after = newText.split('\n')
  let start = 0
  const shorter = Math.min(before.length, after.length)
  while (start < shorter && before[start] === after[start]) start++
  let end = 0
  while (
    end < shorter - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const removed = before.slice(start, before.length - end)
  const added = after.slice(start, after.length - end)
  return editCounts(removed, added) ?? { added: added.length, removed: removed.length }
}

/** A reply's first line of text without its Markdown marks, spaces collapsed. */
export function replyLine(markdown: string): string | null {
  let fenced = false
  for (const raw of markdown.split('\n', 200)) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || line === '' || /^([-*_]\s*){3,}$/.test(line) || /^\|?[\s:|-]+\|?$/.test(line)) {
      continue
    }
    const text = line
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/^\|\s*|\s*\|$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    return text.length > REPLY_CHARS ? `${text.slice(0, REPLY_CHARS - 1)}…` : text
  }
  return null
}

/** Whether a call's request asked the user, rather than a routine, a task or the host answering. */
function askedUser(entry: Extract<Entry, { kind: 'tool' }>): boolean {
  if (entry.permission) return true
  const result = entry.permissionResult
  if (result === 'cancelled' || result === 'withdrawn') return true
  return typeof result === 'object' && result !== null && result.by === undefined
}

/**
 * What happened since the device last saw the session, or null when the user was not away long
 * enough, the device never saw it, or nothing worth a line happened. `older`: the thread has pages
 * before the loaded ones, where an entry not found may lie. `awayMs`: how long counts as away,
 * RECAP_AWAY_MS unless a test run shortens it.
 */
export function recapSince(
  thread: RecapThread,
  mark: SeenMark | null,
  { now, older, awayMs = RECAP_AWAY_MS }: { now: number; older: boolean; awayMs?: number },
): Recap | null {
  if (!mark || now - mark.at < awayMs) return null
  let start = 0
  let partial = false
  if (mark.entry !== null) {
    const at = thread.order.indexOf(mark.entry)
    if (at >= 0) start = at + 1
    // Without older pages, an entry gone from the thread means it was read anew, as after a
    // replay, and nothing places the user in it.
    else if (older) partial = true
    else return null
  }
  if (start >= thread.order.length) return null

  const files = new Set<string>()
  let added = 0
  let removed = 0
  let commands = 0
  let approvals = 0
  let waiting = 0
  let errors = 0
  let reply: string | null = null
  for (let i = start; i < thread.order.length; i++) {
    const entry = thread.byId[thread.order[i]!]
    if (!entry) continue
    if (entry.kind === 'agent') {
      reply = replyLine(entry.markdown) ?? reply
    } else if (entry.kind === 'notice') {
      if (entry.severity === 'error' || entry.cause === 'agent_stopped') errors++
    } else if (entry.kind === 'tool') {
      if (askedUser(entry)) {
        approvals++
        if (entry.permission) waiting++
      }
      if (entry.denied) continue
      if (
        entry.toolKind === 'execute' &&
        entry.status !== 'pending' &&
        entry.status !== 'cancelled'
      )
        commands++
      if (entry.status !== 'completed') continue
      for (const part of entry.content) {
        if (part.type === 'diff') {
          files.add(part.path)
          const lines = changedLines(part.oldText, part.newText)
          added += lines.added
          removed += lines.removed
        } else if (part.type === 'digest' && part.of === 'diff') {
          files.add(part.path)
          added += part.added ?? 0
          removed += part.removed ?? 0
        }
      }
    }
  }
  if (files.size === 0 && commands === 0 && approvals === 0 && errors === 0 && reply === null) {
    return null
  }
  return {
    from: thread.order[start]!,
    files: files.size,
    added,
    removed,
    commands,
    approvals,
    waiting,
    errors,
    reply,
    partial,
  }
}

/** The marks a device keeps with `sessionId` seen now, the oldest past the most kept let go. */
export function withSeen(
  marks: Readonly<Record<string, SeenMark>>,
  sessionId: string,
  mark: SeenMark,
): Record<string, SeenMark> {
  const next: Record<string, SeenMark> = {}
  for (const [id, each] of Object.entries(marks)) if (id !== sessionId) next[id] = each
  next[sessionId] = mark
  const ids = Object.keys(next)
  if (ids.length <= SEEN_MARKS_KEPT) return next
  ids.sort((a, b) => next[a]!.at - next[b]!.at)
  for (const id of ids.slice(0, ids.length - SEEN_MARKS_KEPT)) delete next[id]
  return next
}

/** The marks read back from storage, each one well formed; anything else is dropped. */
export function parseSeenMarks(value: unknown): Record<string, SeenMark> {
  const marks: Record<string, SeenMark> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return marks
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const { at, entry } = raw as { at?: unknown; entry?: unknown }
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    if (entry !== null && (typeof entry !== 'string' || entry.length > 512)) continue
    marks[id] = { at, entry }
  }
  return marks
}

/** Where a session is seen now: at this moment, at the thread's last entry. */
export function seenNow(thread: RecapThread, now: number): SeenMark {
  return { at: now, entry: thread.order.at(-1) ?? null }
}

/** Where a device stands with one session's recap as the user comes and goes. */
export interface RecapVisit {
  /** Where the user last saw the session; null if this device never showed it. */
  mark: SeenMark | null
  /** The session is on screen, its screen in front and the window or app in front. */
  inView: boolean
  /** The recap on show, until the user is done with it or leaves. */
  shown: Recap | null
}

/**
 * - `view`: the session comes into view: its screen opens, or the window or app comes back.
 * - `leave`: it goes out of view: the screen is left or covered, the window or app goes back.
 * - `done`: the user is done with the recap: closed it, jumped to where they left off, or sent a
 *   message.
 */
export type RecapEvent = 'view' | 'leave' | 'done'

export const NOT_VISITED: RecapVisit = { mark: null, inView: false, shown: null }

/**
 * The visit after `event`. Time in view counts as seen: coming into view shows a recap only of
 * what came after the user last left, and only after an absence of `awayMs` or more; leaving, and
 * being done with the recap, mark everything up to now seen. An event that repeats the state, as
 * a second leave or a view while in view, changes nothing, so it never measures an absence from a
 * mark older than the last time the user looked.
 */
export function recapStep(
  visit: RecapVisit,
  event: RecapEvent,
  thread: RecapThread,
  clock: { now: number; older: boolean; awayMs?: number },
): RecapVisit {
  if (event === 'view') {
    if (visit.inView) return visit
    return {
      mark: seenNow(thread, clock.now),
      inView: true,
      shown: recapSince(thread, visit.mark, clock),
    }
  }
  if (event === 'leave') {
    if (!visit.inView) return visit
    return { mark: seenNow(thread, clock.now), inView: false, shown: null }
  }
  // A recap shows only in view, and leaving puts it away.
  if (!visit.shown) return visit
  return { mark: seenNow(thread, clock.now), inView: true, shown: null }
}

/** Where a device keeps its seen marks, read once and written whole. */
export interface SeenStorage {
  /** The marks kept, in any shape: what is not a mark is dropped. */
  read(): Promise<unknown>
  write(marks: Record<string, SeenMark>): Promise<void>
}

export interface SeenBook {
  /** The session's mark, once the marks kept are read. */
  get(sessionId: string): Promise<SeenMark | null>
  /**
   * Keeps `mark`: at once for `get`, and in storage once the marks kept are read, so none of
   * them is lost. Resolves when it is written.
   */
  set(sessionId: string, mark: SeenMark): Promise<void>
  /** Writes nothing more, as when the storage is deleted. */
  close(): void
}

/**
 * A device's seen marks over storage that reads and writes asynchronously, as a file. A mark set
 * while the stored ones are read is newer than its stored one; writes go one at a time, each of
 * the latest marks, and one that fails leaves the next to try.
 */
export function seenBook(storage: SeenStorage): SeenBook {
  let marks: Record<string, SeenMark> = {}
  let closed = false
  const read = Promise.resolve()
    .then(() => storage.read())
    .then(parseSeenMarks, () => ({}))
    .then((stored) => {
      let merged = stored
      for (const [id, mark] of Object.entries(marks)) merged = withSeen(merged, id, mark)
      marks = merged
    })
  let writes: Promise<void> = read
  let queued = false
  return {
    async get(sessionId) {
      await read
      return marks[sessionId] ?? null
    },
    set(sessionId, mark) {
      marks = withSeen(marks, sessionId, mark)
      if (queued) return writes
      queued = true
      writes = writes.then(async () => {
        queued = false
        if (closed) return
        try {
          await storage.write(marks)
        } catch {
          // The next mark set writes them all again.
        }
      })
      return writes
    },
    close() {
      closed = true
    },
  }
}

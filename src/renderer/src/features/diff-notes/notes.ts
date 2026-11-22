// Comments on the lines of a diff the Files pane shows, kept in the session's draft and sent to
// its agent together as one message (@shared/diff-notes).

import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import {
  MAX_DIFF_NOTES,
  diffNotesMessage,
  newDiffNote,
  type DiffNote,
  type DiffNoteRow,
} from '@shared/diff-notes'
import type { UserContent } from '@shared/thread'
import {
  readDraftNotes,
  readDraftPageNotes,
  writeDraftNotes,
  writeDraftPageNotes,
} from '@renderer/features/session/composer/drafts'
import { pageNoteShots, pageNotesText } from '@renderer/features/page-notes/notes'
import { MAX_PAGE_NOTES } from '@shared/page-notes'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useSessionsStore } from '@renderer/stores/sessions'
import { showSending, useThreadsStore } from '@renderer/stores/threads'

/**
 * Counts the diff's renders, which the library makes on its own, such as when highlighting
 * arrives or folded lines unfold; the comments' marks are placed again after each.
 */
export class RenderCount {
  count = 0
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  bump = (): void => {
    this.count++
    for (const listener of this.listeners) listener()
  }
}

const ADDED = 1
const REMOVED = 2

/**
 * Every line of a diff in the order the unified view numbers its rows, the folded unchanged runs
 * too, so a row's index is the first number of its `data-line-index`.
 */
interface Rows {
  marks: Uint8Array
  old: Int32Array
  new: Int32Array
  /** The row of each old line, and of each new line, by number. */
  ofOld: Int32Array
  ofNew: Int32Array
}

const rowsCache = new WeakMap<FileDiffMetadata, Rows>()

function rowsOf(fileDiff: FileDiffMetadata): Rows {
  const known = rowsCache.get(fileDiff)
  if (known) return known
  const oldCount = fileDiff.deletionLines.length
  const newCount = fileDiff.additionLines.length
  const size = oldCount + newCount
  const marks = new Uint8Array(size)
  const olds = new Int32Array(size)
  const news = new Int32Array(size)
  const ofOld = new Int32Array(oldCount + 2).fill(-1)
  const ofNew = new Int32Array(newCount + 2).fill(-1)
  let index = 0
  let oldNo = 1
  let newNo = 1
  const push = (mark: number): void => {
    marks[index] = mark
    olds[index] = mark === ADDED ? 0 : oldNo
    news[index] = mark === REMOVED ? 0 : newNo
    if (mark !== ADDED) ofOld[oldNo++] = index
    if (mark !== REMOVED) ofNew[newNo++] = index
    index++
  }
  for (const hunk of fileDiff.hunks) {
    for (let i = 0; i < hunk.collapsedBefore && oldNo <= oldCount && newNo <= newCount; i++) push(0)
    for (const part of hunk.hunkContent) {
      if (part.type === 'context') {
        for (let i = 0; i < part.lines; i++) push(0)
      } else {
        for (let i = 0; i < part.deletions; i++) push(REMOVED)
        for (let i = 0; i < part.additions; i++) push(ADDED)
      }
    }
  }
  while (oldNo <= oldCount && newNo <= newCount) push(0)
  const rows = {
    marks: marks.subarray(0, index),
    old: olds.subarray(0, index),
    new: news.subarray(0, index),
    ofOld,
    ofNew,
  }
  rowsCache.set(fileDiff, rows)
  return rows
}

/** The row a selection's end is on, or -1 when the diff has no such line. */
function rowAt(rows: Rows, line: number, side: SelectedLineRange['side']): number {
  const table = side === 'deletions' ? rows.ofOld : rows.ofNew
  return line > 0 && line < table.length ? table[line]! : -1
}

/** The rows a selection covers, first and last, in the view's order; null when it fits none. */
export function rowSpan(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): [number, number] | null {
  const rows = rowsOf(fileDiff)
  const a = rowAt(rows, range.start, range.side)
  const b = rowAt(rows, range.end, range.endSide ?? range.side)
  if (a < 0 || b < 0) return null
  return a <= b ? [a, b] : [b, a]
}

/** The rows a note's lines are on, or null when this diff no longer has them. */
export function noteSpan(fileDiff: FileDiffMetadata, note: DiffNote): [number, number] | null {
  if (!note.range) return null
  const { side, start, end } = note.range
  return rowSpan(fileDiff, { start, end, side })
}

const lineText = (line: string | undefined): string => (line ?? '').replace(/\r?\n$/, '')

function noteRows(fileDiff: FileDiffMetadata, [first, last]: [number, number]): DiffNoteRow[] {
  const rows = rowsOf(fileDiff)
  const out: DiffNoteRow[] = []
  for (let i = first; i <= last; i++) {
    const mark = rows.marks[i]
    const old = rows.old[i]! || null
    const next = rows.new[i]! || null
    out.push({
      mark: mark === ADDED ? '+' : mark === REMOVED ? '-' : ' ',
      old,
      new: next,
      text: lineText(
        mark === REMOVED ? fileDiff.deletionLines[old! - 1] : fileDiff.additionLines[next! - 1],
      ),
    })
  }
  return out
}

let made = 0

/** A note of `text` on the rows `span` of the file `path` shows, at `ref` or in the working tree. */
export function makeNote(
  fileDiff: FileDiffMetadata,
  span: [number, number],
  place: { path: string; ref: string | null },
  text: string,
): DiffNote {
  const at = Date.now()
  return newDiffNote(
    { id: `${at.toString(36)}-${(++made).toString(36)}`, ...place, text, at },
    noteRows(fileDiff, span),
    true,
  )
}

/** Whether the session can take another note. */
export const notesFull = (sessionId: string): boolean =>
  readDraftNotes(sessionId).length >= MAX_DIFF_NOTES

export function addNote(sessionId: string, note: DiffNote): void {
  writeDraftNotes(sessionId, [...readDraftNotes(sessionId), note].slice(-MAX_DIFF_NOTES))
}

export function editNote(sessionId: string, id: string, text: string): void {
  writeDraftNotes(
    sessionId,
    readDraftNotes(sessionId).map((note) => (note.id === id ? { ...note, text } : note)),
  )
}

export function removeNote(sessionId: string, id: string): void {
  writeDraftNotes(
    sessionId,
    readDraftNotes(sessionId).filter((note) => note.id !== id),
  )
}

export function clearNotes(sessionId: string): void {
  writeDraftNotes(sessionId, [])
}

/** The message the notes go as, in the interface's language. */
export function notesMessage(notes: readonly DiffNote[]): string {
  const t = i18n.getFixedT(null, 'files')
  return diffNotesMessage(notes, {
    intro: (count) => t('notes.message.intro', { count }),
    removed: t('notes.message.removed'),
    commit: (ref) => t('notes.message.commit', { ref }),
    more: (count) => t('notes.message.more', { count }),
  })
}

/**
 * Sends the session's notes as one message through its queue, which sends at once when the
 * session is free; they leave the draft as they go and come back if the send fails. Huli: the
 * comments on page elements go in the same message, after the diff's, with their screenshots.
 */
export async function sendNotes(sessionId: string): Promise<void> {
  const notes = readDraftNotes(sessionId)
  const pageNotes = readDraftPageNotes(sessionId)
  if (notes.length === 0 && pageNotes.length === 0) return
  const text = [
    ...(notes.length > 0 ? [notesMessage(notes)] : []),
    ...(pageNotes.length > 0 ? [pageNotesText(pageNotes)] : []),
  ].join('\n\n')
  const content: UserContent[] = [
    { type: 'text', text },
    ...pageNoteShots(pageNotes).map((attachment): UserContent => ({
      type: 'ref',
      ref: { kind: 'attachment', attachment },
    })),
  ]
  const status =
    useThreadsStore.getState().replicas[sessionId]?.state?.session.status ??
    useSessionsStore.getState().byId[sessionId]?.status
  const unshow = status === 'ready' || status === 'closed' ? showSending(sessionId, content) : null
  writeDraftNotes(sessionId, [])
  writeDraftPageNotes(sessionId, [])
  try {
    const { itemId } = await host('sessions.queue', { sessionId, content })
    // It waits in the queue after all, which shows it there.
    if (itemId) unshow?.()
  } catch (error) {
    unshow?.()
    const written = readDraftNotes(sessionId)
    writeDraftNotes(sessionId, [...notes, ...written].slice(0, MAX_DIFF_NOTES))
    const writtenPages = readDraftPageNotes(sessionId)
    writeDraftPageNotes(sessionId, [...pageNotes, ...writtenPages].slice(0, MAX_PAGE_NOTES))
    throw error
  }
}

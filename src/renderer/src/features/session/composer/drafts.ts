import { useSyncExternalStore } from 'react'
import { parseDiffNotes, type DiffNote } from '@shared/diff-notes'
import { parsePageNotes, type PageNote } from '@shared/page-notes'
import { isAttachment, type Attachment } from '@shared/thread'
import { removeKey } from '@renderer/lib/storage'

// Unsent composer text and attachments per session, in localStorage under `draft:<sessionId>` as
// JSON `{ text, attachments, notes }`, written 300 ms after the last change. One stored as plain
// text, before drafts had attachments, reads as text alone. A draft that is too large or fails to
// save stays in memory. `notes` are comments on diff lines waiting to go to the agent together,
// and `pageNotes` (Huli) those on elements of a page in the session's browser, which go with them;
// sending the composer's message leaves them, deleting the session drops them.

/** The New session screen's draft, kept like a session's until the session it starts exists. */
export const NEW_SESSION_DRAFT = 'new'

/**
 * A draft's attachment as stored: the host's record of it, and what the tile shows about it;
 * `hostId` names another host that holds the record.
 */
export interface SavedAttachment {
  attachment: Attachment
  pixels: { width: number; height: number } | null
  scaled: { width: number; height: number } | null
  hostId?: string
}

interface Draft {
  text: string
  attachments: SavedAttachment[]
  notes: DiffNote[]
  pageNotes: PageNote[]
}

const WRITE_DELAY_MS = 300
const MAX_DRAFT_BYTES = 1024 * 1024

const memory = new Map<string, Draft>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const PREFIX = 'draft:'
const key = (sessionId: string) => `${PREFIX}${sessionId}`
const EMPTY: Draft = { text: '', attachments: [], notes: [], pageNotes: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSize = (value: unknown): value is { width: number; height: number } | null =>
  value === null ||
  (isRecord(value) && typeof value.width === 'number' && typeof value.height === 'number')

function isSaved(value: unknown): value is SavedAttachment {
  return (
    isRecord(value) &&
    isAttachment(value.attachment) &&
    isSize(value.pixels) &&
    isSize(value.scaled) &&
    (value.hostId === undefined || typeof value.hostId === 'string')
  )
}

/** A stored draft; one stored as plain text, or that is not a draft's JSON, is text alone. */
export function parseDraft(raw: string): Draft {
  if (raw.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (isRecord(value) && typeof value.text === 'string' && Array.isArray(value.attachments)) {
        return {
          text: value.text,
          attachments: value.attachments.filter(isSaved),
          notes: parseDiffNotes(value.notes),
          pageNotes: parsePageNotes(value.pageNotes),
        }
      }
    } catch {
      // Text that only starts like JSON.
    }
  }
  return { text: raw, attachments: [], notes: [], pageNotes: [] }
}

function read(sessionId: string): Draft {
  const kept = memory.get(sessionId)
  if (kept) return kept
  try {
    const raw = localStorage.getItem(key(sessionId))
    return raw === null ? EMPTY : parseDraft(raw)
  } catch {
    return EMPTY
  }
}

export function readDraft(sessionId: string): string {
  return read(sessionId).text
}

export function readDraftAttachments(sessionId: string): SavedAttachment[] {
  return read(sessionId).attachments
}

/** Whether a draft holds what Send takes: text other than white space, or an attachment. */
export function hasMessage(text: string, attachments: readonly unknown[]): boolean {
  return text.trim().length > 0 || attachments.length > 0
}

function write(sessionId: string, draft: Draft): void {
  memory.set(sessionId, draft)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.set(
    sessionId,
    setTimeout(() => flushDraft(sessionId), WRITE_DELAY_MS),
  )
}

export function writeDraft(sessionId: string, text: string): void {
  write(sessionId, { ...read(sessionId), text })
}

export function writeDraftAttachments(sessionId: string, attachments: SavedAttachment[]): void {
  write(sessionId, { ...read(sessionId), attachments })
}

/** Writes a pending draft now, for example when the composer unmounts. */
export function flushDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  const draft = memory.get(sessionId)
  if (draft === undefined) return
  if (
    !draft.text &&
    draft.attachments.length === 0 &&
    draft.notes.length === 0 &&
    draft.pageNotes.length === 0
  ) {
    removeKey(key(sessionId))
    memory.delete(sessionId)
    return
  }
  const value = JSON.stringify(draft)
  if (value.length * 2 > MAX_DRAFT_BYTES) {
    console.warn(`Draft for ${sessionId} is over 1 MB; keeping it in memory only`)
    return
  }
  try {
    localStorage.setItem(key(sessionId), value)
    memory.delete(sessionId)
  } catch (error) {
    console.warn(`Could not save the draft for ${sessionId}; keeping it in memory`, error)
  }
}

/** Every draft, saved or in memory, New session's included. */
export function draftIds(): string[] {
  const ids = new Set(memory.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(PREFIX)) ids.add(name.slice(PREFIX.length))
    }
  } catch {
    // Without storage only the drafts in memory count.
  }
  return [...ids].sort()
}

/** The sessions whose draft, saved or in memory, holds more than white space, or anything else. */
export function draftedSessions(): string[] {
  return draftIds().filter((id) => {
    if (id === NEW_SESSION_DRAFT) return false
    const draft = read(id)
    return (
      draft.text.trim() !== '' ||
      draft.attachments.length > 0 ||
      draft.notes.length > 0 ||
      draft.pageNotes.length > 0
    )
  })
}

/** Empties the draft's message, its text and attachments, as a send does; its notes stay. */
export function clearDraft(sessionId: string): void {
  const { notes, pageNotes } = read(sessionId)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  memory.delete(sessionId)
  if (notes.length === 0 && pageNotes.length === 0) {
    removeKey(key(sessionId))
    return
  }
  memory.set(sessionId, { text: '', attachments: [], notes, pageNotes })
  flushDraft(sessionId)
}

/** Drops the whole draft, notes too, of a session that is gone. */
export function forgetDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  memory.delete(sessionId)
  removeKey(key(sessionId))
  const shown = shownNotes.delete(sessionId)
  if (shownPageNotes.delete(sessionId) || shown) emitNotes()
}

// The notes as the views last read them, one array per session until they change, so a view that
// reads them renders again only when its session's notes do.
const shownNotes = new Map<string, readonly DiffNote[]>()
const shownPageNotes = new Map<string, readonly PageNote[]>()
const noteListeners = new Set<() => void>()

function emitNotes(): void {
  for (const listener of noteListeners) listener()
}

function subscribeNotes(listener: () => void): () => void {
  noteListeners.add(listener)
  return () => {
    noteListeners.delete(listener)
  }
}

/** The session's comments on diff lines, in the order they were written. */
export function readDraftNotes(sessionId: string): readonly DiffNote[] {
  let notes = shownNotes.get(sessionId)
  if (!notes) shownNotes.set(sessionId, (notes = read(sessionId).notes))
  return notes
}

/** Replaces the session's notes and stores them at once: each change is a deliberate edit. */
export function writeDraftNotes(sessionId: string, notes: DiffNote[]): void {
  shownNotes.set(sessionId, notes)
  write(sessionId, { ...read(sessionId), notes })
  flushDraft(sessionId)
  emitNotes()
}

/** The session's notes, rendering again only when they change; none for no session. */
export function useDraftNotes(sessionId: string | null): readonly DiffNote[] {
  return useSyncExternalStore(subscribeNotes, () =>
    sessionId === null ? NO_NOTES : readDraftNotes(sessionId),
  )
}

const NO_NOTES: readonly DiffNote[] = []

/** Huli: the session's comments on elements of its browser's pages, in the order written. */
export function readDraftPageNotes(sessionId: string): readonly PageNote[] {
  let notes = shownPageNotes.get(sessionId)
  if (!notes) shownPageNotes.set(sessionId, (notes = read(sessionId).pageNotes))
  return notes
}

/** Replaces the session's page notes and stores them at once, as its diff notes are. */
export function writeDraftPageNotes(sessionId: string, notes: PageNote[]): void {
  shownPageNotes.set(sessionId, notes)
  write(sessionId, { ...read(sessionId), pageNotes: notes })
  flushDraft(sessionId)
  emitNotes()
}

/** The session's page notes, rendering again only when they change; none for no session. */
export function useDraftPageNotes(sessionId: string | null): readonly PageNote[] {
  return useSyncExternalStore(subscribeNotes, () =>
    sessionId === null ? NO_PAGE_NOTES : readDraftPageNotes(sessionId),
  )
}

const NO_PAGE_NOTES: readonly PageNote[] = []

/** How many comments of either kind the session holds. */
export function useNoteCount(sessionId: string | null): number {
  return useSyncExternalStore(subscribeNotes, () =>
    sessionId === null
      ? 0
      : readDraftNotes(sessionId).length + readDraftPageNotes(sessionId).length,
  )
}

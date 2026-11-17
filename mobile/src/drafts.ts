// Unsent messages, per computer and session, as the desktop keeps them (composer/drafts.ts): the
// text, the attachments the computer already holds, and the `@` mentions among them. Kept in memory
// and written 300 ms after the last change to one JSON file per computer in the app's documents
// folder, so a draft outlives leaving the screen and a restart of the app. New session's draft is
// kept under NEW_SESSION_DRAFT until the session it starts exists.
//
//   <documents>/huli/drafts/<computer id>.json   { v: 1, drafts: { <session id>: Draft } }

import { useSyncExternalStore } from 'react'
import { Directory, File, Paths } from 'expo-file-system'
import { isAttachment, type Attachment } from '@shared/thread'

export const NEW_SESSION_DRAFT = 'new'

/** A draft's attachment: the computer's record, and what the phone picked it from. */
export interface SavedAttachment {
  attachment: Attachment
  kind: 'image' | 'file' | 'project' | 'text'
  /** Where it came from on the phone, or the project path a mention named. */
  uri: string
  projectPath?: string
}

/** A mention's `@name` in the text, by its range, and the attachment it stands for. */
export interface SavedMention {
  from: number
  to: number
  attachmentId: string
}

export interface Draft {
  text: string
  attachments: SavedAttachment[]
  mentions: SavedMention[]
}

const VERSION = 1
const WRITE_DELAY_MS = 300
/** A draft whose JSON is larger than this stays in memory only. */
const MAX_DRAFT_CHARS = 512 * 1024

const memory = new Map<string, Map<string, Draft>>()
const loading = new Map<string, Promise<void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let version = 0

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isSaved(value: unknown): value is SavedAttachment {
  return (
    isRecord(value) &&
    isAttachment(value.attachment) &&
    (value.kind === 'image' ||
      value.kind === 'file' ||
      value.kind === 'project' ||
      value.kind === 'text') &&
    typeof value.uri === 'string'
  )
}

function isMention(value: unknown): value is SavedMention {
  return (
    isRecord(value) &&
    typeof value.from === 'number' &&
    typeof value.to === 'number' &&
    typeof value.attachmentId === 'string'
  )
}

function parseDraft(value: unknown): Draft | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null
  const attachments = Array.isArray(value.attachments) ? value.attachments.filter(isSaved) : []
  const ids = new Set(attachments.map((a) => a.attachment.id))
  const mentions = (Array.isArray(value.mentions) ? value.mentions.filter(isMention) : []).filter(
    (m) =>
      ids.has(m.attachmentId) &&
      m.from >= 0 &&
      m.to > m.from &&
      m.to <= (value.text as string).length,
  )
  return { text: value.text, attachments, mentions }
}

function fileOf(computer: string): File {
  return new File(
    new Directory(Paths.document, 'huli', 'drafts'),
    `${computer.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  )
}

function publish(): void {
  version++
  for (const listener of listeners) listener()
}

/** Reads a computer's drafts once; later calls wait on the same read. */
export function loadDrafts(computer: string): Promise<void> {
  const known = loading.get(computer)
  if (known) return known
  const read = (async () => {
    const drafts = new Map<string, Draft>()
    try {
      const file = fileOf(computer)
      if (file.exists) {
        const value: unknown = JSON.parse(await file.text())
        if (isRecord(value) && value.v === VERSION && isRecord(value.drafts)) {
          for (const [key, raw] of Object.entries(value.drafts)) {
            const draft = parseDraft(raw)
            if (draft) drafts.set(key, draft)
          }
        }
      }
    } catch (error) {
      console.warn('Could not read the drafts', error)
    }
    // A draft written while the file was read is newer than the file's.
    const written = memory.get(computer)
    if (written) for (const [key, draft] of written) drafts.set(key, draft)
    memory.set(computer, drafts)
    publish()
  })()
  loading.set(computer, read)
  return read
}

export function draftsLoaded(computer: string): boolean {
  return memory.has(computer) && loading.has(computer)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the computer's drafts have been read; starts the read. */
export function useDraftsReady(computer: string | null): boolean {
  if (computer && !loading.has(computer)) void loadDrafts(computer)
  useSyncExternalStore(subscribe, () => version)
  return computer !== null && draftsLoaded(computer)
}

export function readDraft(computer: string, key: string): Draft | null {
  return memory.get(computer)?.get(key) ?? null
}

function empty(draft: Draft): boolean {
  return draft.text === '' && draft.attachments.length === 0
}

export function writeDraft(computer: string, key: string, draft: Draft): void {
  let drafts = memory.get(computer)
  if (!drafts) memory.set(computer, (drafts = new Map()))
  if (empty(draft)) {
    if (!drafts.has(key)) return
    drafts.delete(key)
  } else {
    drafts.set(key, draft)
  }
  schedule(computer)
}

export function clearDraft(computer: string, key: string): void {
  writeDraft(computer, key, { text: '', attachments: [], mentions: [] })
}

function schedule(computer: string): void {
  const timer = timers.get(computer)
  if (timer) clearTimeout(timer)
  timers.set(
    computer,
    setTimeout(() => {
      timers.delete(computer)
      void save(computer)
    }, WRITE_DELAY_MS),
  )
}

async function save(computer: string): Promise<void> {
  // Never over the file before it has been read, or the drafts in it would be lost.
  await loadDrafts(computer)
  const drafts = memory.get(computer)
  if (!drafts) return
  const kept: Record<string, Draft> = {}
  for (const [key, draft] of drafts) {
    if (JSON.stringify(draft).length <= MAX_DRAFT_CHARS) kept[key] = draft
  }
  try {
    const file = fileOf(computer)
    if (Object.keys(kept).length === 0) {
      if (file.exists) file.delete()
      return
    }
    const dir = file.parentDirectory
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
    if (!file.exists) file.create({ intermediates: true })
    await file.write(JSON.stringify({ v: VERSION, drafts: kept }))
  } catch (error) {
    console.warn('Could not save the drafts; keeping them in memory', error)
  }
}

/** Forgets every draft of a computer, as when it is unpaired. */
export function dropDrafts(computer: string): void {
  memory.delete(computer)
  loading.delete(computer)
  const timer = timers.get(computer)
  if (timer) clearTimeout(timer)
  timers.delete(computer)
  try {
    const file = fileOf(computer)
    if (file.exists) file.delete()
  } catch {
    // Nothing to delete.
  }
  publish()
}

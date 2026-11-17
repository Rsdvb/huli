// What was sent while the phone could not reach its computer, kept per computer until it goes: a
// session's next messages, and new sessions with their first. Once the link is up they go one at a
// time in the order they were written, a session's messages through the host's queue as the
// composer's own do, a new session through `sessions.create` with its first message. A failure the
// link may get over (the connection went, the computer was busy) leaves the rest waiting for the
// next connection; a message the computer refuses stays where it was, failed, to retry or withdraw.
//
//   <documents>/huli/outbox/<computer id>/outbox.json   { v: 1, items: OutboxItem[] }
//   <documents>/huli/outbox/<computer id>/files/<name>  a picked file's prepared bytes
//
// Files are named, not given by URI: iOS moves the app's documents folder when the app updates.

import { useCallback } from 'react'
import { Directory, File, Paths } from 'expo-file-system'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import { isAttachment, type Attachment, type UserContent } from '@shared/thread'
import { isPhoto, type PickedSource } from './attachments'
import { createStore, sameItems, useSelector } from './select'

/** An attachment of a waiting message: held by the computer, a prepared file, or a project's file. */
export type OutboxAttachment =
  | { kind: 'held'; attachment: Attachment }
  | {
      kind: 'file'
      /** Its name in the computer's files folder. */
      file: string
      name: string
      mimeType: string
      thumb: string | null
      size: number
    }
  | { kind: 'project'; projectPath: string; path: string; name: string }

/** What a new session starts with, as New session picked it. */
export interface NewSessionPlan {
  agentId: string
  projectPath: string | null
  parentId?: string
  options?: Record<string, string | boolean>
}

export interface OutboxItem {
  id: string
  /** The session it goes to; null for a new session, which `create` describes. */
  sessionId: string | null
  create?: NewSessionPlan
  text: string
  attachments: OutboxAttachment[]
  createdAt: number
  /** Why the computer refused it; it waits for Retry or Withdraw then. */
  failed?: string
}

/** What a composer hands over: the message, its attachments in the order they were added. */
export interface OutboxMessage {
  text: string
  attachments: OutboxAttachment[]
}

interface State {
  items: ReadonlyMap<string, readonly OutboxItem[]>
  /** The ids of the items going now. */
  sending: ReadonlySet<string>
}

const VERSION = 1
const NONE: readonly OutboxItem[] = []

const store = createStore<State>({ items: new Map(), sending: new Set() })
const loading = new Map<string, Promise<void>>()
const writes = new Map<string, Promise<void>>()

const safe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

function folderOf(computer: string): Directory {
  return new Directory(Paths.document, 'huli', 'outbox', safe(computer))
}

function filesOf(computer: string): Directory {
  return new Directory(folderOf(computer), 'files')
}

/** A kept file's URI, from its name. */
export function outboxFile(computer: string, name: string): File {
  return new File(filesOf(computer), name)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseAttachment(value: unknown): OutboxAttachment | null {
  if (!isRecord(value)) return null
  if (value.kind === 'held' && isAttachment(value.attachment)) {
    return { kind: 'held', attachment: value.attachment }
  }
  if (
    value.kind === 'file' &&
    typeof value.file === 'string' &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.size === 'number'
  ) {
    return {
      kind: 'file',
      file: value.file,
      name: value.name,
      mimeType: value.mimeType,
      thumb: typeof value.thumb === 'string' ? value.thumb : null,
      size: value.size,
    }
  }
  if (
    value.kind === 'project' &&
    typeof value.projectPath === 'string' &&
    typeof value.path === 'string' &&
    typeof value.name === 'string'
  ) {
    return { kind: 'project', projectPath: value.projectPath, path: value.path, name: value.name }
  }
  return null
}

function parsePlan(value: unknown): NewSessionPlan | null {
  if (!isRecord(value) || typeof value.agentId !== 'string') return null
  if (value.projectPath !== null && typeof value.projectPath !== 'string') return null
  const options = isRecord(value.options)
    ? Object.fromEntries(
        Object.entries(value.options).filter(
          (entry): entry is [string, string | boolean] =>
            typeof entry[1] === 'string' || typeof entry[1] === 'boolean',
        ),
      )
    : undefined
  return {
    agentId: value.agentId,
    projectPath: value.projectPath,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  }
}

function parseItem(value: unknown): OutboxItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string') {
    return null
  }
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : null
  const create = sessionId === null ? parsePlan(value.create) : null
  if (sessionId === null && !create) return null
  const attachments = Array.isArray(value.attachments) ? value.attachments : []
  const parsed = attachments.map(parseAttachment)
  if (parsed.some((a) => a === null)) return null
  return {
    id: value.id,
    sessionId,
    ...(create ? { create } : {}),
    text: value.text,
    attachments: parsed as OutboxAttachment[],
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    ...(typeof value.failed === 'string' ? { failed: value.failed } : {}),
  }
}

function itemsOf(computer: string): readonly OutboxItem[] {
  return store.get().items.get(computer) ?? NONE
}

function setItems(computer: string, change: (items: readonly OutboxItem[]) => OutboxItem[]): void {
  store.set((state) => {
    const items = new Map(state.items)
    items.set(computer, change(state.items.get(computer) ?? NONE))
    return { ...state, items }
  })
  save(computer)
}

function setSending(id: string, on: boolean): void {
  store.set((state) => {
    if (state.sending.has(id) === on) return state
    const sending = new Set(state.sending)
    if (on) sending.add(id)
    else sending.delete(id)
    return { ...state, sending }
  })
}

/** Writes one after another, each the outbox as it is by then. */
function save(computer: string): void {
  const next = (writes.get(computer) ?? Promise.resolve()).then(async () => {
    // Never over the file before it has been read, or the messages in it would be lost.
    await loadOutbox(computer)
    try {
      const file = new File(folderOf(computer), 'outbox.json')
      const items = itemsOf(computer)
      if (items.length === 0) {
        if (file.exists) file.delete()
        return
      }
      const dir = file.parentDirectory
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
      if (!file.exists) file.create({ intermediates: true })
      await file.write(JSON.stringify({ v: VERSION, items }))
    } catch (error) {
      console.warn('Could not save the outbox; keeping it in memory', error)
    }
  })
  writes.set(computer, next)
}

/** Reads a computer's outbox once, and deletes the files no message keeps. */
export function loadOutbox(computer: string): Promise<void> {
  const known = loading.get(computer)
  if (known) return known
  const read = (async () => {
    const items: OutboxItem[] = []
    try {
      const file = new File(folderOf(computer), 'outbox.json')
      if (file.exists) {
        const value: unknown = JSON.parse(await file.text())
        if (isRecord(value) && value.v === VERSION && Array.isArray(value.items)) {
          for (const raw of value.items) {
            const item = parseItem(raw)
            if (item) items.push(item)
          }
        }
      }
    } catch (error) {
      console.warn('Could not read the outbox', error)
    }
    try {
      const kept = new Set(
        items.flatMap((item) =>
          item.attachments.flatMap((a) => (a.kind === 'file' ? [a.file] : [])),
        ),
      )
      const files = filesOf(computer)
      if (files.exists) {
        for (const entry of files.list()) {
          if (entry instanceof File && !kept.has(entry.name)) entry.delete()
        }
      }
    } catch {
      // Left for the next start.
    }
    // Anything queued while the file was read is newer.
    const written = store.get().items.get(computer) ?? NONE
    store.set((state) => {
      const all = new Map(state.items)
      all.set(computer, [...items, ...written])
      return { ...state, items: all }
    })
  })()
  loading.set(computer, read)
  return read
}

/** A new file in the computer's files folder for a picked attachment's prepared bytes. */
export async function keepFile(
  computer: string,
  bytes: Uint8Array,
  name: string,
): Promise<{ file: string; uri: string }> {
  await loadOutbox(computer)
  const dir = filesOf(computer)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? ''
  const kept = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${extension}`
  const file = new File(dir, kept)
  file.create({ overwrite: true })
  await file.write(bytes)
  return { file: kept, uri: file.uri }
}

/** Deletes a kept file no message needs any more. */
export function dropFile(computer: string, name: string): void {
  try {
    const file = outboxFile(computer, name)
    if (file.exists) file.delete()
  } catch {
    // Swept at the next start.
  }
}

let nextId = 0

/** Keeps a message to go once the computer is reachable, and sends it at once if it is. */
export function queueMessage(
  computer: string,
  target: { sessionId: string } | { create: NewSessionPlan },
  message: OutboxMessage,
): OutboxItem {
  const item: OutboxItem = {
    id: `o${Date.now().toString(36)}${(nextId++).toString(36)}`,
    sessionId: 'sessionId' in target ? target.sessionId : null,
    ...('create' in target ? { create: target.create } : {}),
    text: message.text,
    attachments: message.attachments,
    createdAt: Date.now(),
  }
  void loadOutbox(computer).then(() => {
    setItems(computer, (items) => [...items, item])
    kick(computer)
  })
  return item
}

/** Tries a failed message again with the rest. */
export function retryItem(computer: string, id: string): void {
  setItems(computer, (items) =>
    items.map((item) => {
      if (item.id !== id) return item
      const cleared = { ...item }
      delete cleared.failed
      return cleared
    }),
  )
  kick(computer)
}

/**
 * Takes a message back out, for the composer: its text, the attachments the computer holds, and
 * its other attachments as picked again, their files moved to the cache. Null while it goes.
 */
export async function withdrawItem(
  computer: string,
  id: string,
): Promise<{ content: UserContent[]; picked: PickedSource[] } | null> {
  const item = itemsOf(computer).find((each) => each.id === id)
  if (!item || store.get().sending.has(id)) return null
  setItems(computer, (items) => items.filter((each) => each.id !== id))
  const content: UserContent[] = item.text ? [{ type: 'text', text: item.text }] : []
  const picked: PickedSource[] = []
  for (const a of item.attachments) {
    if (a.kind === 'held') {
      content.push({ type: 'ref', ref: { kind: 'attachment', attachment: a.attachment } })
    } else if (a.kind === 'project') {
      picked.push({
        kind: 'project',
        uri: a.path,
        name: a.name,
        mimeType: null,
        size: null,
        projectPath: a.projectPath,
      })
    } else {
      const from = outboxFile(computer, a.file)
      if (!from.exists) continue
      const to = new File(Paths.cache, `huli-outbox-${a.file}`)
      try {
        await from.move(to)
      } catch {
        continue
      }
      picked.push({
        kind: isPhoto(a.mimeType) ? 'image' : 'file',
        uri: to.uri,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      })
    }
  }
  return { content, picked }
}

/** Forgets everything a computer's outbox kept, as when it is unpaired. */
export function dropOutbox(computer: string): void {
  loading.delete(computer)
  store.set((state) => {
    if (!state.items.has(computer)) return state
    const items = new Map(state.items)
    items.delete(computer)
    return { ...state, items }
  })
  const next = (writes.get(computer) ?? Promise.resolve()).then(() => {
    try {
      const dir = folderOf(computer)
      if (dir.exists) dir.delete()
    } catch {
      // Nothing to delete.
    }
  })
  writes.set(computer, next)
}

// ---- Reading it ----

/** A session's waiting messages, oldest first; null names the new sessions under `parentId`. */
export function useOutbox(
  computer: string | null,
  sessionId: string | null,
  parentId?: string,
): readonly OutboxItem[] {
  if (computer && !loading.has(computer)) void loadOutbox(computer)
  const select = useCallback(
    (state: State) => {
      if (!computer) return NONE
      const all = state.items.get(computer) ?? NONE
      const mine = all.filter((item) =>
        sessionId !== null
          ? item.sessionId === sessionId
          : item.sessionId === null && item.create?.parentId === parentId,
      )
      return mine.length === 0 ? NONE : mine
    },
    [computer, sessionId, parentId],
  )
  return useSelector(store, select, sameItems)
}

const selectSending = (state: State) => state.sending

/** The ids of the messages going now. */
export function useOutboxSending(): ReadonlySet<string> {
  return useSelector(store, selectSending)
}

// ---- Sending it ----

/** The link the outbox goes over: the active computer's, while it is connected. */
let route: { link: HostLink; computer: string } | null = null
const flushing = new Set<string>()
const again = new Set<string>()

/** Says which computer is connected now, and sends what waits for it. */
export function setOutboxLink(link: HostLink | null, computer: string | null): void {
  route = link && computer ? { link, computer } : null
  if (computer) kick(computer)
}

function kick(computer: string): void {
  if (route?.computer !== computer || route.link.state.kind !== 'connected') return
  void flush(route.link, computer)
}

/** Heard when a waiting new session was made; true when the listener took it over. */
export type CreatedListener = (created: { itemId: string; session: SessionSummary }) => boolean

const createdListeners = new Set<CreatedListener>()
let createdFallback: ((session: SessionSummary) => void) | null = null

/** Hears waiting new sessions made, as the screen that shows one does. */
export function onCreated(listener: CreatedListener): () => void {
  createdListeners.add(listener)
  return () => {
    createdListeners.delete(listener)
  }
}

/** What happens to a made session no screen took over: a notice, say. */
export function setCreatedFallback(fallback: ((session: SessionSummary) => void) | null): void {
  createdFallback = fallback
}

// Codes a later connection may get past; anything else is the computer refusing the message.
const TRANSIENT = new Set(['host_restarted', 'busy', 'unavailable', 'host_offline', 'timeout'])

class Refused extends Error {}

function isTransient(error: unknown): boolean {
  if (error instanceof Refused) return false
  const code = (error as { code?: unknown } | null)?.code
  return typeof code !== 'string' || TRANSIENT.has(code)
}

function failText(error: unknown, item: OutboxItem): string {
  if (error instanceof Refused) return error.message
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  if (code === 'not_found') {
    return item.sessionId ? '这个会话已不在电脑上了。' : (message ?? '电脑上找不到需要的内容。')
  }
  if (code === 'agent_unavailable') return message ?? 'Agent 现在用不了。'
  return message || '电脑没有接受这条消息。'
}

async function flush(link: HostLink, computer: string): Promise<void> {
  if (flushing.has(computer)) {
    again.add(computer)
    return
  }
  flushing.add(computer)
  try {
    await loadOutbox(computer)
    // Each message once per round: one refused is skipped until it is retried.
    const tried = new Set<string>()
    for (;;) {
      if (link.state.kind !== 'connected' || route?.link !== link) return
      // A session's later messages wait behind one that failed, so they never arrive out of order.
      const blocked = new Set<string>()
      const item = itemsOf(computer).find((each) => {
        if (each.failed || tried.has(each.id)) {
          if (each.sessionId !== null) blocked.add(each.sessionId)
          return false
        }
        return each.sessionId === null || !blocked.has(each.sessionId)
      })
      if (!item) return
      tried.add(item.id)
      setSending(item.id, true)
      try {
        await send(link, computer, item)
      } catch (error) {
        if (isTransient(error)) return
        const failed = failText(error, item)
        setItems(computer, (items) =>
          items.map((each) => (each.id === item.id ? { ...each, failed } : each)),
        )
      } finally {
        setSending(item.id, false)
      }
    }
  } finally {
    flushing.delete(computer)
    if (again.delete(computer)) kick(computer)
  }
}

async function send(link: HostLink, computer: string, item: OutboxItem): Promise<void> {
  const content: UserContent[] = item.text.trim() ? [{ type: 'text', text: item.text }] : []
  for (const [index, kept] of item.attachments.entries()) {
    let attachment: Attachment
    if (kept.kind === 'held') {
      attachment = kept.attachment
    } else {
      attachment = await handOver(link, computer, kept)
      // Held by the computer from now on, so a retry does not hand it over again.
      setItems(computer, (items) =>
        items.map((each) =>
          each.id === item.id
            ? {
                ...each,
                attachments: each.attachments.map((a, i) =>
                  i === index ? { kind: 'held', attachment } : a,
                ),
              }
            : each,
        ),
      )
      if (kept.kind === 'file') dropFile(computer, kept.file)
    }
    content.push({ type: 'ref', ref: { kind: 'attachment', attachment } })
  }
  if (item.sessionId !== null) {
    await link.request('sessions.queue', { sessionId: item.sessionId, content })
    setItems(computer, (items) => items.filter((each) => each.id !== item.id))
    return
  }
  const plan = item.create!
  const session = (await link.request('sessions.create', {
    agentId: plan.agentId,
    projectPath: plan.projectPath,
    ...(plan.parentId ? { parentId: plan.parentId } : {}),
    ...(plan.options ? { options: plan.options } : {}),
    ...(content.length > 0 ? { prompt: content } : {}),
  })) as SessionSummary
  setItems(computer, (items) => items.filter((each) => each.id !== item.id))
  let taken = false
  for (const listener of createdListeners) {
    if (listener({ itemId: item.id, session })) taken = true
  }
  if (!taken) createdFallback?.(session)
}

async function handOver(
  link: HostLink,
  computer: string,
  kept: Exclude<OutboxAttachment, { kind: 'held' }>,
): Promise<Attachment> {
  if (kept.kind === 'project') {
    return (await link.request('attachments.add', {
      source: { projectPath: kept.projectPath, path: kept.path },
      thumb: null,
    })) as Attachment
  }
  const file = outboxFile(computer, kept.file)
  let bytes: Uint8Array | null = null
  try {
    if (file.exists) bytes = await file.bytes()
  } catch {
    // Said below.
  }
  if (!bytes) throw new Refused(`「${kept.name}」在手机上的副本已不在，请撤回后重新添加。`)
  return (await link.request('attachments.add', {
    source: { bytes, mimeType: kept.mimeType, name: kept.name },
    thumb: kept.thumb,
  })) as Attachment
}

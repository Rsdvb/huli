// What the phone shows before the link is up: each computer's session list, agents and projects,
// and the latest page of the sessions opened most recently, kept as JSON files in the app's cache
// folder (out of backups; the system may clear it, which costs only a slower start).
//
//   <cache>/huli/<computer id>/lists.json            the lists (sessions, agents, projects,
//                                                    folders), and when they were read
//   <cache>/huli/<computer id>/threads.json          the cached threads' ids, latest opened first
//   <cache>/huli/<computer id>/threads/<id>.json     one thread's newest entries
//
// It is read-only: nothing here is ever sent back, and the computer's own answers replace it as
// soon as they come. Unpairing a computer deletes its folder.

import { Directory, File, Paths } from 'expo-file-system'
import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import type { SessionFolder } from '@shared/session-folders'
import type { SessionView, ThreadEntry, ThreadState } from '@shared/thread'

const VERSION = 1
/** Threads kept per computer, the least recently opened dropped first. */
const THREADS_KEPT = 20
/** Entries kept per thread: about a screen and a half of a conversation. */
const ENTRIES_KEPT = 60
/** One entry larger than this (an inline image, a long tool output) is left out. */
const ENTRY_MAX = 64 * 1024

export interface CachedLists {
  savedAt: number
  sessions: SessionSummary[]
  agents: AgentStatus[]
  projects: Project[]
  /** Missing in a cache written before folders. */
  folders?: SessionFolder[]
}

export interface CachedThread {
  savedAt: number
  session: SessionView
  entries: ThreadEntry[]
}

function root(): Directory {
  return new Directory(Paths.cache, 'huli')
}

function folderOf(computer: string): Directory {
  return new Directory(root(), computer.replace(/[^A-Za-z0-9_-]/g, '_'))
}

function threadFile(computer: string, sessionId: string): File {
  return new File(
    folderOf(computer),
    'threads',
    `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  )
}

function ensure(dir: Directory): void {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
}

async function readJson<T>(file: File): Promise<T | null> {
  try {
    if (!file.exists) return null
    const value = JSON.parse(await file.text()) as { v?: number } & T
    return value.v === VERSION ? value : null
  } catch {
    return null
  }
}

async function writeJson(file: File, value: object): Promise<void> {
  ensure(file.parentDirectory)
  if (!file.exists) file.create({ intermediates: true })
  await file.write(JSON.stringify({ v: VERSION, ...value }))
}

// Writes for one computer go one after another, so the threads index is never written twice at once.
const queues = new Map<string, Promise<void>>()

function serial(computer: string, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(computer) ?? Promise.resolve()).then(task).catch(() => {})
  queues.set(computer, next)
  return next
}

export function readLists(computer: string): Promise<CachedLists | null> {
  return readJson<CachedLists>(new File(folderOf(computer), 'lists.json'))
}

export function writeLists(computer: string, lists: CachedLists): Promise<void> {
  return serial(computer, () => writeJson(new File(folderOf(computer), 'lists.json'), lists))
}

// The threads read or saved latest, in memory too, so a session opened again shows its rows on the
// first frame of the push rather than once its file is read. A saved one keeps as many entries as
// the screen showed, up to RECENT_ENTRIES, so the conversation opens on the rows it closed on.
const RECENT_KEPT = 6
const RECENT_ENTRIES = 1000
const recent = new Map<string, CachedThread>()

function remember(computer: string, sessionId: string, thread: CachedThread): void {
  const key = `${computer}/${sessionId}`
  recent.delete(key)
  recent.set(key, thread)
  for (const old of recent.keys()) {
    if (recent.size <= RECENT_KEPT) break
    recent.delete(old)
  }
}

/** Huli: forgets the copies in memory, as when the system runs short of it; the files stay. */
export function dropRecentThreads(): void {
  recent.clear()
}

/** The copy read or saved latest in this run, at once; null when there is none in memory. */
export function recentThread(computer: string, sessionId: string): CachedThread | null {
  return recent.get(`${computer}/${sessionId}`) ?? null
}

export async function readThread(
  computer: string,
  sessionId: string,
): Promise<CachedThread | null> {
  const copy = await readJson<CachedThread>(threadFile(computer, sessionId))
  // The copy in memory is never older than the file, and may hold more.
  if (copy && !recent.has(`${computer}/${sessionId}`)) remember(computer, sessionId, copy)
  return copy
}

/** The cached threads' ids, latest opened first. */
export async function cachedThreadIds(computer: string): Promise<string[]> {
  const index = await readJson<{ ids: string[] }>(new File(folderOf(computer), 'threads.json'))
  return Array.isArray(index?.ids) ? index.ids : []
}

function newest(thread: ThreadState, count: number, maxSize = Infinity): ThreadEntry[] {
  const kept: ThreadEntry[] = []
  for (let i = thread.order.length - 1; i >= 0 && kept.length < count; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry && (maxSize === Infinity || JSON.stringify(entry).length <= maxSize)) kept.push(entry)
  }
  return kept.reverse()
}

/** Keeps the thread's newest entries, and forgets the threads opened longest ago. */
export function writeThread(computer: string, thread: ThreadState): Promise<void> {
  const sessionId = thread.session.id
  const savedAt = Date.now()
  // A predicted prompt is for the moment it came; the computer sends it again if it holds.
  const session = { ...thread.session, suggestion: undefined }
  const copy: CachedThread = { savedAt, session, entries: newest(thread, ENTRIES_KEPT, ENTRY_MAX) }
  remember(computer, sessionId, { savedAt, session, entries: newest(thread, RECENT_ENTRIES) })
  return serial(computer, async () => {
    await writeJson(threadFile(computer, sessionId), copy)
    const ids = [sessionId, ...(await cachedThreadIds(computer)).filter((id) => id !== sessionId)]
    for (const gone of ids.splice(THREADS_KEPT)) {
      const file = threadFile(computer, gone)
      if (file.exists) file.delete()
    }
    await writeJson(new File(folderOf(computer), 'threads.json'), { ids })
  })
}

/** Forgets one session, as when it was deleted on the computer. */
export function dropThread(computer: string, sessionId: string): Promise<void> {
  recent.delete(`${computer}/${sessionId}`)
  return serial(computer, async () => {
    const file = threadFile(computer, sessionId)
    if (file.exists) file.delete()
    const ids = (await cachedThreadIds(computer)).filter((id) => id !== sessionId)
    await writeJson(new File(folderOf(computer), 'threads.json'), { ids })
  })
}

/** Deletes everything kept for a computer, as when it is unpaired. */
export function clearComputer(computer: string): Promise<void> {
  return serial(computer, async () => {
    const dir = folderOf(computer)
    if (dir.exists) dir.delete()
  })
}

/** The text of an entry a search looks in: what the user and the agent wrote. */
export function entryText(entry: ThreadEntry): string | null {
  if (entry.kind === 'user') {
    return entry.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ')
  }
  if (entry.kind === 'agent') return entry.markdown
  return null
}

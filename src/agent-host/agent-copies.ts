// Huli: what an agent keeps of a session after Kite deletes it, removed too, so that neither the
// agent's own apps nor Import from agents bring it back.
//
// Claude Code's SDK (0.3.326) deletes the transcript and its `<id>/` folder in one project folder
// only. Copies of the transcript Claude Code left in other project folders, as when the Claude app
// continued it in a scratch folder, the backups Kite made of it, and the files Claude Code 2.1 keeps
// per session (file-history, session-env, tasks, uploads, todos, debug) stay; they go here.
//
// agy 1.5.13 deletes nothing over ACP and keeps a conversation as `conversations/<id>.db`,
// `brain/<id>/` and `annotations/<id>.pbtxt`, with entries in its summary indexes:
// `conversation_summaries.db`, the summary store it syncs that database from at every start
// (`jetbox_summaries_proto.pb`; the Antigravity app's `agyhub_summaries_proto.pb`, which indexes
// the CLI's conversations too) and `cache/conversation_metadata.json`. It lists only conversations
// whose `.db` is there, from its own folder and the app's (`~/.gemini/antigravity`). A `.db` another
// agy process holds open cannot be removed on Windows: that conversation is left whole and tried
// again later. `implicit/` holds editor activity under ids of its own, never a conversation's.
//
// Codex 0.171's `thread/delete` removes the rollout, its state rows and its name index entries
// itself, so Codex needs nothing here.
//
// Only names that are exactly the session's id are touched, inside the agent's own folder. A link
// is removed as a link and never followed, and a folder reached through one is not looked into.

import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { harnessOf, type AgentId, type HarnessId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from './find-command'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How long a write to one of agy's databases waits for another program's lock. */
const BUSY_MS = 2_000
/** Sub-agent conversations followed down from one conversation, at most. */
const MAX_CONVERSATIONS = 256
/** agy's later passes, in ms after the first: past the session router's 5 s kill, then once more. */
const RETRY_MS = [6_000, 20_000]

/** The harnesses whose copy of a deleted session Kite removes itself. */
const REMOVES: ReadonlySet<HarnessId> = new Set(['claude-code', 'antigravity'])

/** Whether Kite removes what the agent keeps of a session it deletes, past the agent's own delete. */
export function removesCopies(harness: HarnessId): boolean {
  return REMOVES.has(harness)
}

export interface CopyRemoval {
  removed: string[]
  /** Held open by another program, as a running agy: left whole, to be tried again. */
  held: string[]
  failed: { path: string; reason: string }[]
}

const empty = (): CopyRemoval => ({ removed: [], held: [], failed: [] })

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code ?? (error instanceof Error ? error.name : 'error')
}

const HELD = new Set(['EBUSY', 'EPERM', 'EACCES'])

async function realFolder(folder: string): Promise<boolean> {
  const info = await lstat(folder).catch(() => null)
  return !!info && info.isDirectory() && !info.isSymbolicLink()
}

async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  )
}

/** The names in `folder` that `match` takes, as paths; none when it is no real folder. */
async function namesIn(folder: string, match: (name: string) => boolean): Promise<string[]> {
  if (!(await realFolder(folder))) return []
  const names = await readdir(folder).catch(() => [] as string[])
  return names.filter((name) => match(name.toLowerCase())).map((name) => path.join(folder, name))
}

/** Removes one file, folder or link; a link goes as a link. */
async function removePath(file: string, result: CopyRemoval): Promise<boolean> {
  try {
    const info = await lstat(file)
    await rm(file, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true })
    result.removed.push(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    result.failed.push({ path: file, reason: reasonOf(error) })
    return false
  }
}

// Claude Code.

/**
 * What Claude Code keeps of session `sessionId` under its configuration folder `folder` past what
 * its SDK's delete removes, that one included: the transcript and its `<id>/` folder in every
 * project folder, Kite's `.kite-bak-*` backups of it, and its per-session files.
 */
export async function claudeCopyPaths(folder: string, sessionId: string): Promise<string[]> {
  if (!UUID.test(sessionId)) return []
  const id = sessionId.toLowerCase()
  const found: string[] = []
  const projects = path.join(folder, 'projects')
  if (await realFolder(projects)) {
    const entries = await readdir(projects, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      found.push(
        ...(await namesIn(
          path.join(projects, entry.name),
          (name) =>
            name === `${id}.jsonl` || name === id || name.startsWith(`${id}.jsonl.kite-bak-`),
        )),
      )
    }
  }
  const own = (sub: string, match: (name: string) => boolean): Promise<string[]> =>
    namesIn(path.join(folder, sub), match)
  const named = (name: string): boolean => name === id
  const todo = new RegExp(`^${id}(-agent-[0-9a-z-]+)?\\.json$`)
  found.push(
    ...(await own('file-history', named)),
    ...(await own('session-env', named)),
    ...(await own('tasks', named)),
    ...(await own('uploads', named)),
    ...(await own('todos', (name) => todo.test(name))),
    ...(await own('debug', (name) => name === `${id}.txt`)),
  )
  return found
}

export async function removeClaudeCopies(folder: string, sessionId: string): Promise<CopyRemoval> {
  const result = empty()
  for (const file of await claudeCopyPaths(folder, sessionId)) await removePath(file, result)
  return result
}

// agy.

/** agy's data folders under the home folder it runs with: its own, then the Antigravity app's. */
export function agyFolders(home: string): string[] {
  const base = path.join(home, '.gemini')
  return [path.join(base, 'antigravity-cli'), path.join(base, 'antigravity')]
}

const SUMMARIES_DB = 'conversation_summaries.db'
const SUMMARY_STORES = [
  'jetbox_summaries_proto.pb',
  'agyhub_summaries_proto.pb',
  'jetbox_summaries.pb',
  'agyhub_summaries.pb',
]
const METADATA = ['cache', 'conversation_metadata.json']
const DB_PARTS = ['', '-wal', '-shm', '-journal']

function varint(bytes: Uint8Array, at: number): [number, number] | null {
  let value = 0
  let scale = 1
  for (let i = at; i < bytes.length && i < at + 10; i++) {
    const byte = bytes[i]!
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return [value, i + 1]
    scale *= 128
  }
  return null
}

/** The fields of a protobuf message, or null when it does not parse as one. */
function fieldsOf(
  bytes: Uint8Array,
): { field: number; wire: number; start: number; body: Uint8Array; end: number }[] | null {
  const fields = []
  let at = 0
  while (at < bytes.length) {
    const start = at
    const key = varint(bytes, at)
    if (!key) return null
    const [tag, next] = key
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    at = next
    let body: Uint8Array = bytes.subarray(0, 0)
    if (wire === 0) {
      const value = varint(bytes, at)
      if (!value) return null
      at = value[1]
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
    } else if (wire === 2) {
      const length = varint(bytes, at)
      if (!length) return null
      body = bytes.subarray(length[1], length[1] + length[0])
      at = length[1] + length[0]
    } else {
      return null
    }
    if (field === 0 || at > bytes.length) return null
    fields.push({ field, wire, start, body, end: at })
  }
  return fields
}

/**
 * agy's summary store without the entries keyed by `ids`. The store is a message of maps keyed by
 * conversation id: each top-level field an entry whose field 1 is the id. Null when the bytes are
 * not that, so a file of another shape is left alone.
 */
export function withoutEntries(
  bytes: Uint8Array,
  ids: ReadonlySet<string>,
): { bytes: Buffer; dropped: number } | null {
  const entries = fieldsOf(bytes)
  if (!entries) return null
  const kept: Uint8Array[] = []
  let dropped = 0
  for (const entry of entries) {
    if (entry.wire !== 2) return null
    const key = fieldsOf(entry.body)?.find((inner) => inner.field === 1)
    if (!key || key.wire !== 2) return null
    const id = Buffer.from(key.body).toString('utf8').toLowerCase()
    if (ids.has(id)) dropped++
    else kept.push(bytes.subarray(entry.start, entry.end))
  }
  return { bytes: Buffer.concat(kept), dropped }
}

async function replaceFile(file: string, content: string | Buffer): Promise<void> {
  const temp = `${file}.kite-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temp, content)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function dropStoreEntries(
  file: string,
  ids: ReadonlySet<string>,
  result: CopyRemoval,
): Promise<void> {
  const bytes = await readFile(file).catch(() => null)
  if (!bytes) return
  const next = withoutEntries(bytes, ids)
  if (!next) {
    result.failed.push({ path: file, reason: 'unknown format, left alone' })
    return
  }
  if (next.dropped === 0) return
  try {
    await replaceFile(file, next.bytes)
    result.removed.push(`${file} (${next.dropped} ${next.dropped === 1 ? 'entry' : 'entries'})`)
  } catch (error) {
    result.failed.push({ path: file, reason: reasonOf(error) })
  }
}

async function dropMetadata(
  file: string,
  ids: ReadonlySet<string>,
  result: CopyRemoval,
): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    result.failed.push({ path: file, reason: 'does not parse, left alone' })
    return
  }
  const conversations = (data as { conversations?: unknown } | null)?.conversations
  if (typeof conversations !== 'object' || conversations === null) return
  const map = conversations as Record<string, unknown>
  const gone = Object.keys(map).filter((key) => ids.has(key.toLowerCase()))
  if (gone.length === 0) return
  for (const key of gone) delete map[key]
  try {
    await replaceFile(file, JSON.stringify(data, null, 2))
    result.removed.push(`${file} (${gone.length} ${gone.length === 1 ? 'entry' : 'entries'})`)
  } catch (error) {
    result.failed.push({ path: file, reason: reasonOf(error) })
  }
}

/** Opens agy's summaries database, which it has open itself, with SQLite's own locking. */
function openSummaries(file: string): DatabaseSync {
  return new DatabaseSync(file, { timeout: BUSY_MS })
}

interface SummaryRead {
  /** Steps of the conversation's own row; null without one. */
  steps: number | null
  /** Its sub-agents' conversations, down every level. */
  children: string[]
}

function readSummaries(file: string, id: string): SummaryRead {
  const db = openSummaries(file)
  try {
    const row = db
      .prepare('SELECT step_count FROM conversation_summaries WHERE lower(conversation_id) = ?')
      .get(id)
    let children: string[] = []
    try {
      children = db
        .prepare(
          `WITH RECURSIVE kids(id) AS (
             SELECT conversation_id FROM conversation_summaries
               WHERE lower(parent_conversation_id) = ? AND nesting_depth > 0
             UNION
             SELECT s.conversation_id FROM conversation_summaries s
               JOIN kids ON lower(s.parent_conversation_id) = lower(kids.id) AND s.nesting_depth > 0
           ) SELECT id FROM kids LIMIT ${MAX_CONVERSATIONS}`,
        )
        .all(id)
        .map((kid) => String(kid.id).toLowerCase())
        .filter((kid) => UUID.test(kid))
    } catch {
      // A version without sub-agents' columns has no sub-agents to follow.
    }
    return { steps: row ? Number(row.step_count) : null, children }
  } finally {
    db.close()
  }
}

function dropSummaries(file: string, ids: readonly string[]): number {
  const db = openSummaries(file)
  try {
    const remove = db.prepare('DELETE FROM conversation_summaries WHERE lower(conversation_id) = ?')
    let rows = 0
    for (const id of ids) rows += Number(remove.run(id).changes)
    return rows
  } finally {
    db.close()
  }
}

/** The conversation's files in one of agy's folders: its database's, and the rest. */
async function agyFiles(folder: string, id: string): Promise<{ db: string[]; rest: string[] }> {
  // The database itself first, then its journals.
  const db = (
    await namesIn(path.join(folder, 'conversations'), (name) =>
      DB_PARTS.some((part) => name === `${id}.db${part}`),
    )
  ).sort((a, b) => a.length - b.length)
  const rest = [
    ...(await namesIn(path.join(folder, 'brain'), (name) => name === id)),
    ...(await namesIn(path.join(folder, 'annotations'), (name) => name === `${id}.pbtxt`)),
  ]
  return { db, rest }
}

async function storesHolding(folder: string, ids: ReadonlySet<string>): Promise<boolean> {
  for (const name of SUMMARY_STORES) {
    const bytes = await readFile(path.join(folder, name)).catch(() => null)
    if (!bytes) continue
    const next = withoutEntries(bytes, ids)
    if (next && next.dropped > 0) return true
  }
  const text = await readFile(path.join(folder, ...METADATA), 'utf8').catch(() => null)
  return text !== null && [...ids].some((id) => text.toLowerCase().includes(`"${id}"`))
}

export interface AgyPass extends CopyRemoval {
  /** The conversations this pass looked for: the one asked for and its sub-agents'. */
  ids: string[]
  /** The folders that had something of them, which a later pass looks in again. */
  touched: string[]
  /**
   * `unprompted` was asked and the conversation has steps, or its summary could not be read:
   * nothing was removed.
   */
  kept: boolean
}

/**
 * One pass over agy's folders under `home` for conversation `conversationId` and its sub-agents'.
 * With `unprompted`, a conversation whose summary has steps is left alone, since only one that
 * never got a prompt may be dropped so. `known` names folders an earlier pass touched, whose
 * summaries database is cleaned even when nothing else of the conversation is left there.
 */
export async function removeAgyCopies(
  home: string,
  conversationId: string,
  { unprompted = false, known = [] }: { unprompted?: boolean; known?: readonly string[] } = {},
): Promise<AgyPass> {
  const pass: AgyPass = { ...empty(), ids: [], touched: [], kept: false }
  if (!UUID.test(conversationId)) return pass
  const id = conversationId.toLowerCase()
  const folders: { folder: string; summaries: string | null }[] = []
  for (const folder of agyFolders(home)) {
    if (!(await realFolder(folder))) continue
    const summaries = path.join(folder, SUMMARIES_DB)
    folders.push({ folder, summaries: (await present(summaries)) ? summaries : null })
  }
  const ids = new Set([id])
  const traced = new Set<string>()
  for (const { folder, summaries } of folders) {
    const files = await agyFiles(folder, id)
    const seen =
      known.includes(folder) ||
      files.db.length > 0 ||
      files.rest.length > 0 ||
      (await storesHolding(folder, ids))
    if (!seen) continue
    traced.add(folder)
    if (!summaries) continue
    try {
      const read = readSummaries(summaries, id)
      if (unprompted && read.steps !== null && read.steps > 0) {
        return { ...pass, ids: [id], kept: true }
      }
      if (!unprompted) for (const child of read.children) ids.add(child)
    } catch (error) {
      pass.failed.push({ path: summaries, reason: reasonOf(error) })
      if (unprompted) return { ...pass, ids: [id], kept: true }
    }
  }
  pass.ids = [...ids]
  pass.touched = [...traced]
  if (traced.size === 0) return pass

  const gone: string[] = []
  for (const each of ids) {
    const parts = await Promise.all(
      [...traced].map(async (folder) => ({ folder, ...(await agyFiles(folder, each)) })),
    )
    let held = false
    // The database goes first: one that another agy holds open keeps the whole conversation.
    for (const file of parts.flatMap((part) => part.db)) {
      if (await removePath(file, pass)) continue
      const failure = pass.failed.at(-1)
      if (failure?.path === file && HELD.has(failure.reason)) {
        pass.failed.pop()
        pass.held.push(file)
      }
      held = true
      break
    }
    if (held) continue
    for (const file of parts.flatMap((part) => part.rest)) await removePath(file, pass)
    gone.push(each)
  }
  if (gone.length === 0) return pass

  const goneSet = new Set(gone)
  for (const { folder, summaries } of folders) {
    if (!traced.has(folder)) continue
    if (summaries) {
      try {
        const rows = dropSummaries(summaries, gone)
        if (rows > 0) pass.removed.push(`${summaries} (${rows} ${rows === 1 ? 'row' : 'rows'})`)
      } catch (error) {
        pass.failed.push({ path: summaries, reason: reasonOf(error) })
      }
    }
    for (const name of SUMMARY_STORES) {
      await dropStoreEntries(path.join(folder, name), goneSet, pass)
    }
    await dropMetadata(path.join(folder, ...METADATA), goneSet, pass)
  }
  return pass
}

/** The home folder agy runs with: the one its environment names, as Go's os.UserHomeDir reads. */
export function agyHome(env: Env, platform: Platform, fallback: string): string {
  return getEnv(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) || fallback
}

// The host's service.

export interface AgentCopiesDeps {
  platform: Platform
  /** The agent's configuration folder as it resolves it, Claude Code's; null when it has none. */
  configFolder(agentId: AgentId): string | null
  /** The environment the agent runs with. */
  env(agentId: AgentId): Env
  /** The home folder when the agent's environment names none. */
  homeDir?: string
  log(level: 'info' | 'warn', message: string): void
  /** agy's later passes, in ms after the first. */
  retryMs?: readonly number[]
}

interface Pending {
  agentId: AgentId
  conversationId: string
  unprompted: boolean
  known: readonly string[]
  timer: ReturnType<typeof setTimeout>
}

export class AgentCopies {
  private readonly pending = new Map<string, Pending>()
  private disposed = false

  constructor(private readonly deps: AgentCopiesDeps) {}

  /**
   * After the agent's own delete, removes what it keeps of `agentSessionId` past it. Never throws:
   * what could not be removed is logged, and agy's held conversations are tried again later.
   */
  async removeDeleted(agentId: AgentId, agentSessionId: string): Promise<void> {
    try {
      switch (harnessOf(agentId)) {
        case 'claude-code': {
          const folder = this.deps.configFolder(agentId)
          if (!folder) return
          this.report(agentId, agentSessionId, await removeClaudeCopies(folder, agentSessionId))
          return
        }
        case 'antigravity':
          await this.agyPass(agentId, agentSessionId, false, [], 0)
          return
        default:
          return
      }
    } catch (error) {
      this.deps.log(
        'warn',
        `Could not remove ${agentId}'s copy of session ${agentSessionId}: ${reasonOf(error)}`,
      )
    }
  }

  /**
   * A session Kite opened for itself and let go before its first prompt, a prepared or hidden one:
   * agy keeps an empty conversation for it, which goes here. Other agents keep none.
   */
  discardUnprompted(agentId: AgentId, agentSessionId: string): void {
    if (harnessOf(agentId) !== 'antigravity') return
    void this.agyPass(agentId, agentSessionId, true, [], 0).catch((error: unknown) => {
      this.deps.log(
        'warn',
        `Could not remove ${agentId}'s copy of session ${agentSessionId}: ${reasonOf(error)}`,
      )
    })
  }

  /**
   * Runs the passes still waiting at once, as the last ones: once the agents have stopped, nothing
   * holds their conversations any more. Later calls do nothing.
   */
  async flush(): Promise<void> {
    if (this.disposed) return
    const waiting = [...this.pending.values()]
    this.dispose()
    const delays = this.deps.retryMs ?? RETRY_MS
    await Promise.all(
      waiting.map((each) =>
        this.agyPass(
          each.agentId,
          each.conversationId,
          each.unprompted,
          each.known,
          delays.length,
          true,
        ).catch(() => {}),
      ),
    )
  }

  dispose(): void {
    this.disposed = true
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  // The agy process of the session may still be exiting, holding its database or writing its
  // summary back as it goes, so a pass that found something is followed by later ones.
  private async agyPass(
    agentId: AgentId,
    conversationId: string,
    unprompted: boolean,
    known: readonly string[],
    attempt: number,
    flushing = false,
  ): Promise<void> {
    if (this.disposed && !flushing) return
    const key = `${agentId}\n${conversationId.toLowerCase()}`
    const waiting = this.pending.get(key)
    if (waiting) {
      clearTimeout(waiting.timer)
      this.pending.delete(key)
    }
    const home = agyHome(
      this.deps.env(agentId),
      this.deps.platform,
      this.deps.homeDir ?? os.homedir(),
    )
    const pass = await removeAgyCopies(home, conversationId, {
      unprompted,
      known: [...new Set([...known, ...(waiting?.known ?? [])])],
    })
    if (pass.kept) return
    const delays = this.deps.retryMs ?? RETRY_MS
    const last = attempt >= delays.length || this.disposed
    this.report(agentId, conversationId, pass, !last)
    if (pass.touched.length === 0 || last) return
    // After the router's kill a pass that found nothing held is the last.
    if (attempt > 0 && pass.held.length === 0) return
    const next = attempt + 1
    const timer = setTimeout(() => {
      this.pending.delete(key)
      void this.agyPass(agentId, conversationId, unprompted, pass.touched, next).catch(
        (error: unknown) => this.deps.log('warn', `agy copy removal failed: ${reasonOf(error)}`),
      )
    }, delays[attempt]!)
    timer.unref?.()
    this.pending.set(key, {
      agentId,
      conversationId,
      unprompted,
      known: pass.touched,
      timer,
    })
  }

  private report(agentId: AgentId, sessionId: string, result: CopyRemoval, again = false): void {
    const { log } = this.deps
    const of = `${agentId}'s copy of session ${sessionId}`
    if (result.removed.length > 0) log('info', `Removed ${of}: ${result.removed.join(', ')}`)
    if (result.held.length > 0) {
      log(
        'warn',
        `${again ? 'Will try again to remove' : 'Could not remove'} ${of}, held open by another program: ${result.held.join(', ')}`,
      )
    }
    for (const { path: file, reason } of result.failed) {
      log('warn', `Could not remove part of ${of}: ${file} (${reason})`)
    }
  }
}

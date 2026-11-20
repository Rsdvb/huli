// Huli: the import from the agents' other folders: a Claude Code configuration folder or its
// `projects` folder, or a Codex home or its `sessions` folder, kept elsewhere, as a backup, a WSL
// distribution's home or a folder copied from another computer. Their sessions are listed from
// their files, and an import copies the chosen ones into the agent's own folder, where the agent
// resumes them, once the user has seen the files it writes. The chosen folder is only read. In
// the agent's folder nothing is overwritten but a transcript the chosen folder's copy carries
// further, which is kept beside it first, as `claude-copies.ts` does. Huli's own; see
// tools/huli/README.md.

import { constants, type Dirent } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { HistoryCopyAction, HistoryCopyOutcome } from '@shared/agent-history'
import { claudeCopies, compareTranscripts } from './claude-copies'
import type { HistoryItem } from './agent-history'
import { findCodexRollout } from './model-requests/codex'
import { fileSource, zstdSource, type ByteSource } from './usage/lines'
import type { LogFn } from './storage'

export type FolderHarness = 'claude-code' | 'codex'

/** Where a chosen folder's sessions are. */
export type FolderSource =
  /** `root`: a `projects` folder; `only`: the one project folder under it to read. */
  | { harness: 'claude-code'; root: string; only: string | null }
  /** `root`: a `sessions` folder or part of one; `home`: the Codex home it is in, when known. */
  | { harness: 'codex'; root: string; home: string | null }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_FILE = new RegExp(`^(${UUID})\\.jsonl$`, 'i')
const ROLLOUT_FILE = new RegExp(
  `^rollout-(?:(\\d{4})-(\\d{2})-(\\d{2})T[^/\\\\]*?-)?(${UUID})\\.jsonl(\\.zst)?$`,
  'i',
)
/** The folders of a Codex `sessions` folder: a year, a month, a day. */
const DATE_FOLDER = /^\d{1,4}$/
const DATE_DEPTH = 3
/** Project folders looked into for a transcript before a folder is taken for a `projects` one. */
const PROBED = 200
/** Rollouts one listing reads at most. */
const MAX_ROLLOUTS = 20_000
/** What is read of a rollout's start for its first prompt, which follows long instructions. */
export const ROLLOUT_HEAD = 1024 * 1024
const ROLLOUT_TAIL = 64 * 1024
/** Codex's index of thread names, read whole up to this. */
const INDEX_LIMIT = 32 * 1024 * 1024
/** The files of a session's own folder (subagents, tool results) one copy takes at most. */
const SESSION_FILES = 5_000
/** The files a plan names per session; the rest are counted. */
export const LISTED_FILES = 200
const READS = 8
const TITLE_CHARS = 200

type Json = Record<string, unknown>

function record(line: string): Json | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null
  } catch {
    return null
  }
}

const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function titleOf(value: string | null): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (collapsed === '') return null
  const chars = Array.from(collapsed)
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : collapsed
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function entries(folder: string): Promise<Dirent[]> {
  return readdir(folder, { withFileTypes: true }).catch(() => [])
}

async function isDirectory(folder: string): Promise<boolean> {
  return stat(folder).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

/**
 * Where the sessions of a chosen folder are, for an agent of `harness`; null when it holds none
 * of that agent's. Claude Code's: its configuration folder, its `projects` folder or one project
 * folder in it. Codex's: its home, its `sessions` folder or a year, month or day folder in that.
 */
export async function folderSource(
  folder: string,
  harness: FolderHarness,
): Promise<FolderSource | null> {
  if (harness === 'claude-code') {
    const projects = path.join(folder, 'projects')
    if (await isDirectory(projects)) return { harness, root: projects, only: null }
    const children = await entries(folder)
    if (children.some((child) => child.isFile() && SESSION_FILE.test(child.name))) {
      return { harness, root: path.dirname(folder), only: path.basename(folder) }
    }
    for (const child of children.filter((entry) => entry.isDirectory()).slice(0, PROBED)) {
      const inner = await entries(path.join(folder, child.name))
      if (inner.some((entry) => entry.isFile() && SESSION_FILE.test(entry.name))) {
        return { harness, root: folder, only: null }
      }
    }
    return null
  }
  const sessions = path.join(folder, 'sessions')
  if (await isDirectory(sessions)) return { harness, root: sessions, home: folder }
  const home = path.basename(folder).toLowerCase() === 'sessions' ? path.dirname(folder) : null
  return (await rolloutFiles(folder, 1)).length > 0 ? { harness, root: folder, home } : null
}

/** The rollouts under a `sessions` folder, or under a year, month or day folder of one. */
async function rolloutFiles(root: string, limit = MAX_ROLLOUTS): Promise<string[]> {
  const found: string[] = []
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const entry of await entries(folder)) {
      if (found.length >= limit) return
      const full = path.join(folder, entry.name)
      if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) found.push(full)
      else if (entry.isDirectory() && depth < DATE_DEPTH && DATE_FOLDER.test(entry.name)) {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return found
}

/** Codex's names for its threads, from `session_index.jsonl` in its home, the latest last. */
async function codexIndex(
  home: string | null,
): Promise<Map<string, { name: string | null; updatedAt: number | null }>> {
  const index = new Map<string, { name: string | null; updatedAt: number | null }>()
  if (home === null) return index
  const file = path.join(home, 'session_index.jsonl')
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > INDEX_LIMIT) return index
  const data = await readFile(file, 'utf8').catch(() => '')
  for (const line of data.split('\n')) {
    const entry = record(line)
    const id = text(entry?.id)?.toLowerCase()
    if (!entry || !id) continue
    const before = index.get(id)
    index.set(id, {
      name: text(entry.thread_name) ?? before?.name ?? null,
      updatedAt: time(entry.updated_at) ?? before?.updatedAt ?? null,
    })
  }
  return index
}

function promptOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((block: unknown) => {
    const value = object(block)
    return value && typeof value.text === 'string' ? [value.text] : []
  })
  return parts.length > 0 ? parts.join(' ') : null
}

interface RolloutHead {
  id: string | null
  cwd: string | null
  createdAt: number | null
  subagent: boolean
  prompt: string | null
  prompted: boolean
}

/**
 * The start of a rollout, up to its first prompt: its `session_meta` names the thread, its folder
 * and who started it, and its first `user_message` (an `item_completed` of a `UserMessage` in newer
 * Codex) is what Codex previews it by.
 */
export async function readRolloutHead(source: ByteSource): Promise<RolloutHead> {
  const head: RolloutHead = {
    id: null,
    cwd: null,
    createdAt: null,
    subagent: false,
    prompt: null,
    prompted: false,
  }
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let read = 0
  const take = (line: string): boolean => {
    const entry = record(line)
    if (!entry) return false
    const payload = object(entry.payload)
    if (!payload) return false
    if (entry.type === 'session_meta' && head.id === null) {
      head.id = text(payload.id)
      head.cwd = text(payload.cwd)
      head.createdAt = time(payload.timestamp) ?? time(entry.timestamp)
      head.subagent = object(payload.source)?.subagent !== undefined
      return false
    }
    if (entry.type !== 'event_msg') return false
    let prompt: string | null = null
    if (payload.type === 'user_message') prompt = promptOf(payload.message)
    else if (payload.type === 'item_completed') {
      const item = object(payload.item)
      if (item?.type === 'UserMessage') prompt = promptOf(item.content)
    }
    if (prompt === null) return false
    head.prompted = true
    head.prompt = titleOf(prompt)
    return true
  }
  for await (const chunk of source.chunks(0)) {
    read += chunk.length
    const lines = (carry + decoder.write(chunk)).split('\n')
    carry = lines.pop() ?? ''
    if (lines.some(take)) return head
    if (read >= ROLLOUT_HEAD) {
      // A prompt past the head still says that it is one.
      head.prompted ||= /"type":"(?:user_message|UserMessage)"/.test(carry)
      return head
    }
  }
  take(carry + decoder.end())
  return head
}

/** The time of a plain rollout's last record, from its end. */
async function lastTime(file: string, size: number): Promise<number | null> {
  if (size === 0) return null
  const start = Math.max(0, size - ROLLOUT_TAIL)
  const bytes = await fileSource(file, size).read(start, size - start)
  const lines = bytes.toString('utf8').split('\n')
  if (start > 0) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = time(record(lines[i]!)?.timestamp)
    if (at !== null) return at
  }
  return null
}

export interface FolderScan {
  /** Newest first. */
  items: HistoryItem[]
  /** The file each listed session was read from. */
  files: ReadonlyMap<string, string>
}

/**
 * Every thread whose rollout is under a Codex `sessions` folder, newest first; a thread kept both
 * whole and compressed is listed once, from its latest file.
 */
export async function scanCodexRollouts(source: FolderSource, log: LogFn): Promise<FolderScan> {
  if (source.harness !== 'codex') return { items: [], files: new Map() }
  const [files, index] = await Promise.all([rolloutFiles(source.root), codexIndex(source.home)])
  const byId = new Map<string, { item: HistoryItem; file: string }>()
  await eachLimited(files, READS, async (file) => {
    try {
      const info = await stat(file)
      const compressed = file.endsWith('.zst')
      const bytes = compressed ? zstdSource(file) : fileSource(file, info.size)
      const head = await readRolloutHead(bytes)
      const named = ROLLOUT_FILE.exec(path.basename(file))?.[4]?.toLowerCase() ?? null
      const id = head.id?.toLowerCase() ?? named
      if (!id || !head.cwd) return
      const indexed = index.get(id)
      const updatedAt =
        (compressed ? null : await lastTime(file, info.size)) ??
        indexed?.updatedAt ??
        Math.round(info.mtimeMs)
      const item: HistoryItem = {
        sessionId: id,
        title: titleOf(indexed?.name ?? null) ?? head.prompt,
        cwd: plain(head.cwd),
        createdAt: head.createdAt,
        updatedAt,
        subagent: head.subagent,
        prompted: head.prompted,
      }
      const other = byId.get(id)
      if (!other || (item.updatedAt ?? 0) > (other.item.updatedAt ?? 0))
        byId.set(id, { item, file })
    } catch (error) {
      log('warn', `Could not read Codex rollout ${file}: ${(error as Error).message}`)
    }
  })
  const items = [...byId.values()].map((entry) => entry.item)
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { items, files: new Map([...byId].map(([id, entry]) => [id, entry.file])) }
}

/** `\\?\C:\x` as `C:\x`: Codex records long-path forms on Windows. */
function plain(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return value
}

/** How the bytes of `a` stand to those of `b`, compared as they stream. */
export async function compareBytes(
  a: ByteSource,
  b: ByteSource,
): Promise<'same' | 'ahead' | 'behind' | 'fork'> {
  const first = a.chunks(0)[Symbol.asyncIterator]()
  const second = b.chunks(0)[Symbol.asyncIterator]()
  let left: Buffer = Buffer.alloc(0)
  let right: Buffer = Buffer.alloc(0)
  let leftDone = false
  let rightDone = false
  try {
    for (;;) {
      if (left.length === 0 && !leftDone) {
        const next = await first.next()
        if (next.done) leftDone = true
        else left = next.value
        continue
      }
      if (right.length === 0 && !rightDone) {
        const next = await second.next()
        if (next.done) rightDone = true
        else right = next.value
        continue
      }
      if (left.length === 0 && right.length === 0) return 'same'
      if (left.length === 0) return 'behind'
      if (right.length === 0) return 'ahead'
      const length = Math.min(left.length, right.length)
      if (!left.subarray(0, length).equals(right.subarray(0, length))) return 'fork'
      left = left.subarray(length)
      right = right.subarray(length)
    }
  } finally {
    await first.return?.()
    await second.return?.()
  }
}

const bytesOf = async (file: string): Promise<ByteSource> =>
  file.endsWith('.zst') ? zstdSource(file) : fileSource(file, (await stat(file)).size)

/** A file to copy, from the chosen folder to the agent's own. */
export interface CopiedFile {
  from: string
  to: string
}

/** What an import from another folder does with one session, with the files it reads. */
export interface PlannedCopy {
  acpSessionId: string
  title: string | null
  cwd: string
  action: HistoryCopyAction
  /** The transcript or rollout it writes, for `new` and `newer`. */
  transcript: CopiedFile | null
  /** For `newer` over a file: that file as it was planned, and where it is kept first. */
  replaced: { file: string; size: number; mtimeMs: number; backup: string } | null
  /** The session folder's files the agent's copy lacks: subagents, tool results. */
  extra: CopiedFile[]
}

export interface PlanInput {
  harness: FolderHarness
  /** The agent's own folder: Claude Code's configuration folder, or Codex's home. */
  target: string
  session: Pick<HistoryItem, 'sessionId' | 'title' | 'cwd' | 'createdAt'>
  /** Its transcript or rollout in the chosen folder. */
  file: string
  /** Its folder is gone here, so the agent could not resume it. */
  missing: boolean
  now: number
}

const stampOf = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, '-')

/** The files under a session's own folder, beside its transcript, that `to` lacks. */
async function missingFiles(from: string, to: string): Promise<CopiedFile[]> {
  const found: CopiedFile[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await entries(path.join(from, relative))) {
      if (found.length >= SESSION_FILES) return
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile() && !(await isFile(path.join(to, name)))) {
        found.push({ from: path.join(from, name), to: path.join(to, name) })
      }
    }
  }
  await walk('')
  return found
}

async function replacing(
  file: string,
  now: number,
): Promise<{ file: string; size: number; mtimeMs: number; backup: string } | null> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return null
  return {
    file,
    size: info.size,
    mtimeMs: info.mtimeMs,
    backup: `${file}.kite-bak-${stampOf(now)}`,
  }
}

/** The day folder Codex keeps a rollout in, from its name, else from when its thread began. */
function dayFolder(name: string, createdAt: number | null): string[] {
  const match = ROLLOUT_FILE.exec(name)
  if (match?.[1] && match[2] && match[3]) return [match[1], match[2], match[3]]
  const at = new Date(createdAt ?? Date.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  return [String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())]
}

/**
 * Where a chosen session's files go in the agent's own folder and what becomes of what is there.
 * Claude Code resumes a session from the project folder of the folder it runs in, so a transcript
 * goes to `projects/<that folder, named as Claude Code names it>/<id>.jsonl`, with the session's
 * own folder of subagents and tool results beside it; Codex finds a thread's rollout under
 * `sessions/<year>/<month>/<day>`, where the chosen folder kept it.
 */
export async function planCopy(input: PlanInput): Promise<PlannedCopy> {
  const { session, file, target, now } = input
  const base = {
    acpSessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    transcript: null,
    replaced: null,
    extra: [],
  }
  if (input.missing) return { ...base, action: 'missing' }
  if (input.harness === 'claude-code') {
    const copies = await claudeCopies(path.join(target, 'projects'), session.cwd, session.sessionId)
    if (!copies) return { ...base, action: 'conflict' }
    const { home, current } = copies
    const relation = current === null ? 'ahead' : await compareTranscripts(file, current)
    const action: HistoryCopyAction =
      current === null
        ? 'new'
        : relation === 'ahead'
          ? 'newer'
          : relation === 'same'
            ? 'same'
            : relation === 'behind'
              ? 'older'
              : 'conflict'
    if (action === 'conflict' || action === 'older') return { ...base, action }
    const folder = path.join(path.dirname(file), session.sessionId)
    const extra = (await isDirectory(folder))
      ? await missingFiles(folder, path.join(path.dirname(home), session.sessionId))
      : []
    const writes = action === 'new' || action === 'newer'
    return {
      ...base,
      action,
      transcript: writes ? { from: file, to: home } : null,
      replaced: action === 'newer' ? await replacing(home, now) : null,
      extra,
    }
  }
  const existing = await findCodexRollout(target, session.sessionId)
  const name = path.basename(file)
  if (existing === null) {
    const to = path.join(target, 'sessions', ...dayFolder(name, session.createdAt), name)
    return { ...base, action: 'new', transcript: { from: file, to } }
  }
  const relation = await compareBytes(await bytesOf(file), await bytesOf(existing)).catch(
    () => null,
  )
  // A whole rollout cannot stand in for a compressed one, nor the other way round.
  const sameKind = file.endsWith('.zst') === existing.endsWith('.zst')
  if (relation === 'ahead' && sameKind) {
    return {
      ...base,
      action: 'newer',
      transcript: { from: file, to: existing },
      replaced: await replacing(existing, now),
    }
  }
  return {
    ...base,
    action: relation === 'same' ? 'same' : relation === 'behind' ? 'older' : 'conflict',
  }
}

/** The files a planned copy writes, the transcript first. */
export function writtenFiles(copy: PlannedCopy): string[] {
  return [...(copy.transcript ? [copy.transcript.to] : []), ...copy.extra.map((file) => file.to)]
}

const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST'

/** Copies a file that is not there yet, with the time it was last changed in the chosen folder. */
async function copyNew(file: CopiedFile): Promise<boolean> {
  await mkdir(path.dirname(file.to), { recursive: true })
  try {
    await copyFile(file.from, file.to, constants.COPYFILE_EXCL)
  } catch (error) {
    if (exists(error)) return false
    throw error
  }
  await keepTimes(file)
  return true
}

async function keepTimes(file: CopiedFile): Promise<void> {
  const info = await stat(file.from).catch(() => null)
  if (info) await utimes(file.to, info.atime, info.mtime).catch(() => {})
}

/**
 * Runs a planned copy. A file that appeared since the plan is left alone, and so is the agent's
 * copy a `newer` replaces when it changed since; that copy is kept beside it before it is.
 */
export async function runCopy(copy: PlannedCopy): Promise<HistoryCopyOutcome> {
  const outcome = (
    status: HistoryCopyOutcome['status'],
    written: number,
    message?: string,
  ): HistoryCopyOutcome => ({
    acpSessionId: copy.acpSessionId,
    status,
    written,
    ...(message ? { message } : {}),
  })
  if (copy.action === 'conflict' || copy.action === 'missing') return outcome('skipped', 0)
  let written = 0
  try {
    const { transcript, replaced } = copy
    if (transcript && replaced) {
      const now = await stat(replaced.file).catch(() => null)
      if (!now || now.size !== replaced.size || now.mtimeMs !== replaced.mtimeMs) {
        return outcome('skipped', 0, 'changed')
      }
      await copyFile(replaced.file, replaced.backup, constants.COPYFILE_EXCL)
      await copyFile(transcript.from, transcript.to)
      await keepTimes(transcript)
      written++
    } else if (transcript) {
      if (!(await copyNew(transcript))) return outcome('skipped', 0, 'changed')
      written++
    }
    for (const file of copy.extra) if (await copyNew(file)) written++
  } catch (error) {
    return outcome('failed', written, (error as Error).message)
  }
  return outcome(copy.transcript ? 'copied' : 'present', written)
}

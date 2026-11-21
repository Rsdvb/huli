// DeepSeek Harness's own record of its sessions, which Kettu lists for an import and replays into
// a thread. dsh keeps each session as an append-only log of the events its SDK wire streams, one
// JSON row per event after a header row, zstd frames by default, in
// `<home>/sessions/--<project>--/<id>/session.v<format>.jsonl.zstd`, as
// @deepseek-ai/dsh-session-persistence-jsonl 0.2.2 writes format 4. A dsh with a newer format
// writes a file of a higher version beside the old one and reads only that, so Kettu reads the
// newest too and leaves out a session whose newest it does not know. dsh's ACP mode lists sessions
// without titles or times and replays none, and its SDK wire reads no history.

import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { Platform } from '@shared/platform'
import { samePath } from '../paths'
import { titleWithoutAhead, withoutAhead } from '../session-updates'
import type { EventData, SessionEvent, WireMessage } from './protocol'

/**
 * The formats read: 4 since dsh 0.1.7, and 3 of 0.1.5 and 0.1.6, which differs only where
 * `normalize` lifts it. Older ones came from dsh's first weeks, whose rows differ more.
 */
export const OLDEST_FORMAT = 3
export const NEWEST_FORMAT = 4

/** A generation's file: `session.jsonl` for format 0, `session.v<N>.jsonl` after, maybe zstd. */
const LOG_NAME = /^session(?:\.v([1-9][0-9]{0,8}))?\.jsonl(\.zstd)?$/
/** How far a compressed log may inflate before it is left unread, as a damaged one is. */
const MAX_INFLATED = 2 ** 30
const ZSTD_CHUNK = 1 << 18
const NEWLINE = 0x0a
/** The start of every event row dsh writes; a row without it is parsed whole. */
const ROW_START = /^\{"type":"([^"\\]{1,120})","seq":\d+,"time":(\d+)/
const TITLE_CHARS = 80
const LIST_READS = 4
const KEPT_SUMMARIES = 4_000
/** The bytes of a row's start that hold its type and time. */
const ROW_PREFIX = 200

export interface DshHeader {
  version: number
  id: string
  createdAt: number
  cwd: string | null
  parentSession: string | null
  subagent: boolean
  isSeeded: boolean
}

/** A session's log: its newest generation, which is the one dsh reads. */
export interface DshLog {
  file: string
  version: number
  compressed: boolean
}

/** A session as the import lists it. */
export interface DshListed {
  sessionId: string
  cwd: string | null
  title: string | null
  createdAt: number
  updatedAt: number
  subagent: boolean
  /** It has a turn, so a message of someone's: dsh lists a session without one as blank. */
  prompted: boolean
}

/** A session's history: its events in order, without what only rebuilds a model request. */
export interface DshHistory {
  header: DshHeader
  events: SessionEvent[]
  /** How many leading events a fork inherited from the session it was made from. */
  inherited: number
  /** The route of its latest request. */
  route: { provider: string; model: string; effort: string | null } | null
}

/** A session dsh wrote in a format this build does not read. */
export class DshFormatError extends Error {
  constructor(readonly version: number) {
    super(`DeepSeek Harness session format ${version} is not supported`)
    this.name = 'DshFormatError'
  }
}

/** Where dsh keeps its sessions under its home. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'sessions')
}

// `encodeSegment` and `projectKey` follow dsh's own naming of a session's folders, from
// https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/session/session-persistence-jsonl/src/format.ts
// Copyright (c) 2026 DeepSeek. MIT License.

/** A session id as dsh names its folder: safe characters as they are, every other as `~XXXX`. */
export function encodeSegment(raw: string): string {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out +=
      ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
        ? ch
        : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** The folder dsh keeps a working directory's sessions in: separators as `-`, cut to fit. */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else {
      readable +=
        ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
          ? ch
          : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

async function entries(dir: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      dir: entry.isDirectory(),
    }))
  } catch {
    return []
  }
}

/** The session's newest generation in its folder; null for a folder without a log. */
export async function logIn(dir: string): Promise<DshLog | null> {
  let best: DshLog | null = null
  for (const entry of await entries(dir)) {
    if (entry.dir) continue
    const match = LOG_NAME.exec(entry.name)
    if (!match) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    if (best && best.version >= version) continue
    best = { file: path.join(dir, entry.name), version, compressed: match[2] !== undefined }
  }
  return best
}

/**
 * Every complete row of a log, oldest first, without its newline. A compressed log is inflated
 * as it is read. A last row cut off as dsh wrote it, or a damaged end, ends the log there.
 */
export async function eachRow(log: DshLog, row: (bytes: Buffer) => boolean | void): Promise<void> {
  const input = createReadStream(log.file, { highWaterMark: 1 << 20 })
  const source = log.compressed
    ? pipeline(input, createZstdDecompress({ chunkSize: ZSTD_CHUNK }), () => {})
    : input
  let carry: Buffer | null = null
  let inflated = 0
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      inflated += chunk.length
      if (inflated > MAX_INFLATED) return
      const buffer: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      let from = 0
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, from)
        if (newline < 0) break
        const end = newline > from && buffer[newline - 1] === 0x0d ? newline - 1 : newline
        if (end > from && row(buffer.subarray(from, end)) === false) return
        from = newline + 1
      }
      carry = from < buffer.length ? Buffer.from(buffer.subarray(from)) : null
    }
  } catch {
    // A damaged or torn end: the rows before it stand, as dsh keeps them.
  } finally {
    source.destroy()
    input.destroy()
  }
}

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return null
  }
}

/** A log's header row; null for one that is not a session's. */
export function parseHeader(value: unknown): DshHeader | null {
  const row = record(value)
  if (!row || row.type !== 'session') return null
  const { version, id } = row
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || typeof id !== 'string')
    return null
  if (id === '') return null
  return {
    version,
    id,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    cwd: text(row.cwd),
    parentSession: text(row.parentSession),
    subagent: row.origin === 'subagent',
    isSeeded: row.isSeeded === true,
  }
}

/** The header a log starts with, which names the version its file name gives. */
function headerOf(bytes: Buffer, log: DshLog): DshHeader | null {
  const header = parseHeader(parse(bytes))
  return header?.version === log.version ? header : null
}

/** The type and time a row starts with, read without parsing a row that may be large. */
function rowStart(bytes: Buffer): { type: string; time: number } | null {
  const match = ROW_START.exec(bytes.toString('utf8', 0, Math.min(bytes.length, ROW_PREFIX)))
  if (match) return { type: match[1]!, time: Number(match[2]) }
  const event = record(parse(bytes))
  return typeof event?.type === 'string'
    ? { type: event.type, time: typeof event.time === 'number' ? event.time : 0 }
    : null
}

/** A file Kettu sent embedded, as its prompt writes one into a text block of its own. */
export const EMBEDDED_FILE = /^<file path="([^"\n]+)">\n[\s\S]*\n<\/file>$/

/** The first words a message's text blocks hold, without what Kettu sent ahead or embedded. */
function messageText(message: unknown): string {
  const content = record(message)?.content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    const value = record(block)
    if (value?.type !== 'text' || typeof value.text !== 'string') continue
    const typed = withoutAhead(value.text)
    if (typed.trim() !== '' && !EMBEDDED_FILE.test(typed)) return typed
  }
  return ''
}

/** A message the user wrote, rather than context dsh or a subagent's report put in. */
export function fromUser(message: unknown): boolean {
  const source = record(record(message)?.source)
  return source?.kind === 'user'
}

function shortTitle(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  const chars = [...collapsed]
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : collapsed
}

/** Reads what the list shows of a session: its title, times and kind, from the whole log. */
export async function summarize(log: DshLog): Promise<DshListed | null> {
  let header: DshHeader | null = null
  let title: string | null = null
  let prompt: string | null = null
  let lastAt = 0
  let prompted = false
  let first = true
  await eachRow(log, (bytes) => {
    if (first) {
      first = false
      header = headerOf(bytes, log)
      return header !== null
    }
    const start = rowStart(bytes)
    if (!start) return
    switch (start.type) {
      case 'session/title': {
        const named = text(record(record(parse(bytes))?.data)?.title)
        if (named) title = named
        break
      }
      case 'user/message': {
        const message = record(parse(bytes))?.data
        if (!fromUser(message)) break
        lastAt = Math.max(lastAt, start.time)
        prompt ??= shortTitle(messageText(message))
        break
      }
      case 'turn/start':
        prompted = true
        break
      case 'assistant/message':
      case 'turn/end':
        lastAt = Math.max(lastAt, start.time)
        break
    }
  })
  const found = header as DshHeader | null
  if (!found) return null
  const own = title ? shortTitle(titleWithoutAhead(title)) : null
  return {
    sessionId: found.id,
    cwd: found.cwd,
    title: own ?? prompt,
    createdAt: found.createdAt,
    updatedAt: Math.max(found.createdAt, lastAt),
    subagent: found.subagent,
    prompted,
  }
}

const kept = new Map<string, { size: number; mtimeMs: number; listed: DshListed | null }>()

/** A session's summary, read again only once its log changed. */
async function summaryOf(log: DshLog): Promise<DshListed | null> {
  let info
  try {
    info = await stat(log.file)
  } catch {
    return null
  }
  const known = kept.get(log.file)
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.listed
  const listed = await summarize(log).catch(() => null)
  kept.delete(log.file)
  kept.set(log.file, { size: info.size, mtimeMs: info.mtimeMs, listed })
  if (kept.size > KEPT_SUMMARIES) kept.delete(kept.keys().next().value!)
  return listed
}

async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(LIST_READS, items.length) }, worker))
}

function supported(version: number): boolean {
  return version >= OLDEST_FORMAT && version <= NEWEST_FORMAT
}

/**
 * The sessions under `root`, newest first; with `cwd`, only those of that working directory. A
 * session in a format this build does not read, or whose log does not read as one, is left out.
 */
export async function listSessions(
  root: string,
  platform: Platform,
  cwd: string | null = null,
): Promise<DshListed[]> {
  // dsh names the folder after the directory as `path.resolve` gives it.
  const keys = cwd === null ? null : new Set([folderKey(projectKey(path.resolve(cwd)), platform)])
  const logs: DshLog[] = []
  for (const project of await entries(root)) {
    if (!project.dir || (keys && !keys.has(folderKey(project.name, platform)))) continue
    const dir = path.join(root, project.name)
    for (const session of await entries(dir)) {
      if (!session.dir) continue
      const log = await logIn(path.join(dir, session.name))
      if (log && supported(log.version)) logs.push(log)
    }
  }
  const listed: DshListed[] = []
  await eachLimited(logs, async (log) => {
    const summary = await summaryOf(log)
    if (!summary) return
    if (cwd !== null && (summary.cwd === null || !samePath(summary.cwd, cwd, platform))) return
    listed.push(summary)
  })
  const unique = new Map<string, DshListed>()
  for (const item of listed.sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!unique.has(item.sessionId)) unique.set(item.sessionId, item)
  }
  return [...unique.values()]
}

/** Folder names compare as the file system does: without case on Windows. */
function folderKey(name: string, platform: Platform): string {
  return platform === 'win32' ? name.toLowerCase() : name
}

/**
 * A session's log: in the folder of one of `cwds` first, then in any project folder, as after its
 * directory moved. Null when dsh has none, as for a session that was never prompted.
 */
export async function findLog(
  root: string,
  sessionId: string,
  cwds: readonly string[],
  platform: Platform,
): Promise<DshLog | null> {
  const name = encodeSegment(sessionId)
  const first = [...new Set(cwds.map((cwd) => projectKey(path.resolve(cwd))))]
  const tried = new Set<string>()
  const look = async (project: string): Promise<DshLog | null> => {
    tried.add(folderKey(project, platform))
    return logIn(path.join(root, project, name))
  }
  for (const project of first) {
    const log = await look(project)
    if (log) return log
  }
  for (const project of await entries(root)) {
    if (!project.dir || tried.has(folderKey(project.name, platform))) continue
    const log = await look(project.name)
    if (log) return log
  }
  return null
}

/**
 * Huli: a log's header and the subagents' sessions its `subagent/catalog` rows name, for removing
 * a session with its subagents'. Null for a log that is not a session's.
 */
export async function readLinks(
  log: DshLog,
): Promise<{ header: DshHeader; children: string[] } | null> {
  let header: DshHeader | null = null
  const children: string[] = []
  let first = true
  await eachRow(log, (bytes) => {
    if (first) {
      first = false
      header = headerOf(bytes, log)
      return header !== null
    }
    if (rowStart(bytes)?.type !== 'subagent/catalog') return
    const childId = text(record(record(parse(bytes))?.data)?.childId)
    if (childId && !children.includes(childId)) children.push(childId)
  })
  const found = header as DshHeader | null
  return found ? { header: found, children } : null
}

/** Rows that only rebuild a model request or record its stream, which no thread shows. */
const UNREAD = new Set(['system/message', 'assistant/attempt'])

/**
 * A session's events as format 4 holds them. Format 3 kept a tool's result in a `tool-result`
 * block of a user-role message; its other rows read alike for what a thread shows.
 */
export function normalize(event: SessionEvent, version: number): SessionEvent {
  if (version >= 4 || event.type !== 'tool/result') return event
  const data = record(event.data)
  const message = record(data?.message)
  const content = message?.content
  if (!data || !message || message.role !== 'user' || !Array.isArray(content)) return event
  const wrapper = record(content[0])
  if (content.length !== 1 || wrapper?.type !== 'tool-result') return event
  const source = record(message.source)
  const callId = text(wrapper.toolCallId) ?? text(source?.callId)
  const lifted: WireMessage = {
    id: typeof message.id === 'string' ? message.id : '',
    role: 'tool',
    content: Array.isArray(wrapper.content) ? (wrapper.content as WireMessage['content']) : [],
    ...(source ? { source: source as WireMessage['source'] } : {}),
    ...(callId ? { toolCallId: callId } : {}),
    ...(wrapper.isError === true ? { isError: true } : {}),
  }
  return { ...event, data: { ...data, message: lifted } } as SessionEvent
}

/**
 * Reads a session's whole history. Rejects with `DshFormatError` for a format this build does not
 * read; a row that does not parse is passed over, and a damaged end ends the history there.
 */
export async function readHistory(log: DshLog): Promise<DshHistory | null> {
  if (!supported(log.version)) throw new DshFormatError(log.version)
  let header: DshHeader | null = null
  const events: SessionEvent[] = []
  let inherited = 0
  let route: DshHistory['route'] = null
  let first = true
  await eachRow(log, (bytes) => {
    if (first) {
      first = false
      header = headerOf(bytes, log)
      return header !== null
    }
    const start = rowStart(bytes)
    if (!start || UNREAD.has(start.type)) return
    const value = record(parse(bytes))
    if (!value || typeof value.type !== 'string') return
    const event = {
      type: value.type,
      seq: typeof value.seq === 'number' ? value.seq : events.length,
      time: typeof value.time === 'number' ? value.time : 0,
      data: value.data,
    } as SessionEvent
    switch (event.type) {
      case 'request/header': {
        const config = record(record(record(event.data)?.header)?.config)
        const provider = text(config?.provider)
        const model = text(config?.model)
        if (provider && model)
          route = { provider, model, effort: text(config?.reasoningEffort) ?? null }
        return
      }
      case 'model/selection': {
        const data = record(event.data)
        const provider = text(data?.provider)
        const model = text(data?.model)
        if (provider && model)
          route = { provider, model, effort: text(data?.reasoningEffort) ?? null }
        break
      }
      case 'assistant/message': {
        // The timed stream doubles the row and only a model's replay reads it.
        const data = record(event.data)
        if (data && 'stream' in data) {
          const rest = { ...data }
          delete rest.stream
          event.data = rest as unknown as EventData['assistant/message']
        }
        break
      }
      case 'session/end-seed':
        if (record(event.data)?.inherited === true) inherited = events.length
        break
    }
    events.push(normalize(event, log.version))
  })
  const found = header as DshHeader | null
  return found ? { header: found, events, inherited, route } : null
}

/** The files a user message's images name, as dsh's attachment store keeps them. */
const IMAGE_ID = /^sha256:([a-f0-9]{64})$/
const IMAGE_BYTES = 20 * 1024 * 1024

/** The bytes of the images the user's own messages hold, by attachment id, as base64. */
export async function readImages(
  home: string,
  events: readonly SessionEvent[],
): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'user/message' || !fromUser(event.data)) continue
    for (const block of (event.data as WireMessage).content ?? []) {
      if (block.type !== 'image') continue
      const id = record(block.attachment)?.attachmentId
      if (typeof id === 'string' && IMAGE_ID.test(id)) ids.add(id)
    }
  }
  const images = new Map<string, string>()
  for (const id of ids) {
    const sha = IMAGE_ID.exec(id)![1]!
    const file = path.join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
    try {
      if ((await stat(file)).size > IMAGE_BYTES) continue
      images.set(id, (await readFile(file)).toString('base64'))
    } catch {
      // An image dsh no longer holds shows by its name alone.
    }
  }
  return images
}

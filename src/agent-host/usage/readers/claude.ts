// Claude Code's usage from its session logs: one row per API message, taken from the assistant
// lines that carry the message's usage. Huli: each row also carries the images the log's context
// held when the message was asked for, those of the prompts and tool results since its latest
// compaction, which the request uploaded again (`shared/traffic.ts`).
// Ported from cc-switch, https://github.com/farion1231/cc-switch/blob/7da2553/src-tauri/src/services/session_usage.rs
// Copyright (c) 2025 Jason Young. MIT License.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { configLocations } from '../../agent-details'
import { eachLine, openLog, resumeOffset, tailHash, unchanged } from '../lines'
import {
  normalizeModel,
  type FileCursor,
  type LogReader,
  type ScanContext,
  type UsageRow,
} from '../model'

const AGENT_ID = 'claude-code'
/**
 * Lines without one of these cannot carry a message's usage, an image or a compaction, so they are
 * never parsed. Claude Code writes its lines without spaces.
 */
const NEEDLES = ['"usage"', '"type":"image"', '"compact_boundary"']

/** The fields read from a log line; any of them may be missing or of another type. */
interface Line {
  type?: unknown
  subtype?: unknown
  isSidechain?: unknown
  timestamp?: unknown
  sessionId?: unknown
  cwd?: unknown
  message?: {
    content?: unknown
    id?: unknown
    model?: unknown
    stop_reason?: unknown
    usage?: {
      input_tokens?: unknown
      output_tokens?: unknown
      cache_read_input_tokens?: unknown
      cache_creation_input_tokens?: unknown
      cache_creation?: {
        ephemeral_1h_input_tokens?: unknown
      } | null
    } | null
  } | null
}

/** A message's best line so far in one read. */
interface Message {
  row: UsageRow
  stopped: boolean
}

/** Huli: the images the log's context holds, and their bytes as base64. */
interface Held {
  count: number
  bytes: number
}

/** The images a cursor's state says its log's context held where it stopped. */
function heldOf(cursor: FileCursor | null, start: number): Held {
  if (!cursor?.state || start === 0) return { count: 0, bytes: 0 }
  try {
    const value = JSON.parse(cursor.state) as { images?: unknown; imageBytes?: unknown }
    return { count: count(value.images), bytes: count(value.imageBytes) }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** The base64 of a content block that is an image, or null. */
function imageData(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const { type, source } = block as { type?: unknown; source?: { type?: unknown; data?: unknown } }
  if (type !== 'image' || source?.type !== 'base64' || typeof source.data !== 'string') return null
  return source.data
}

/** Adds the images of a prompt or of its tool results to what the context holds. */
function holdImages(content: unknown, held: Held): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    const data = imageData(block)
    if (data !== null) {
      held.count++
      held.bytes += data.length
      continue
    }
    const inner = (block as { type?: unknown; content?: unknown } | null)?.content
    if ((block as { type?: unknown } | null)?.type === 'tool_result') holdImages(inner, held)
  }
}

interface Pending {
  file: string
  cursor: FileCursor | null
  /** What `plan` counted for it. */
  bytes: number
}

/** `chosen` is an agent's own configuration folder, which wins over the environment's. */
export function projectsFolder(
  env: ScanContext['env'],
  home: string,
  platform: Platform,
  chosen: string | null = null,
): string {
  const config = configLocations(AGENT_ID, (name) => env[name], home, platform, chosen).find(
    (item) => item.id === 'folder',
  )?.candidates[0]
  if (!config) throw new Error('Claude Code has no configuration folder')
  return (platform === 'win32' ? path.win32 : path.posix).join(config, 'projects')
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// Symlinks are kept as candidates, since cc-switch follows them; stat and readdir sort them out.
const isLog = (entry: Dirent): boolean => entry.name.endsWith('.jsonl') && !entry.isDirectory()
const mayBeFolder = (entry: Dirent): boolean => entry.isDirectory() || entry.isSymbolicLink()

async function entries(folder: string, log: ScanContext['log']): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (!isMissing(error)) log('warn', `Could not list ${folder}: ${(error as Error).message}`)
    return []
  }
}

/** A project's sessions, their subagents and workflow subagents, at cc-switch's fixed depths. */
async function projectLogs(project: string, log: ScanContext['log']): Promise<string[]> {
  const files: string[] = []
  for (const entry of await entries(project, log)) {
    const session = path.join(project, entry.name)
    if (isLog(entry)) {
      files.push(session)
      continue
    }
    if (!mayBeFolder(entry)) continue
    const subagents = path.join(session, 'subagents')
    for (const child of await entries(subagents, log)) {
      const childPath = path.join(subagents, child.name)
      if (isLog(child)) files.push(childPath)
      else if (child.name === 'workflows' && mayBeFolder(child)) {
        for (const workflow of await entries(childPath, log)) {
          if (!mayBeFolder(workflow)) continue
          const workflowPath = path.join(childPath, workflow.name)
          for (const file of await entries(workflowPath, log)) {
            if (isLog(file)) files.push(path.join(workflowPath, file.name))
          }
        }
      }
    }
  }
  return files
}

/** Every log under `root`, or null when there is no such folder. */
async function listLogs(root: string, log: ScanContext['log']): Promise<string[] | null> {
  let projects: Dirent[]
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const found = await Promise.all(
    projects.filter(mayBeFolder).map((project) => projectLogs(path.join(root, project.name), log)),
  )
  return found.flat()
}

/** The files that changed since their cursors, with the bytes left to read in each. */
async function changedLogs(files: string[], context: ScanContext): Promise<Pending[]> {
  const pending = await Promise.all(
    files.map(async (file): Promise<Pending | null> => {
      let info
      try {
        info = await stat(file, { bigint: true })
      } catch (error) {
        if (!isMissing(error)) {
          context.log('warn', `Could not check ${file}: ${(error as Error).message}`)
        }
        return null
      }
      if (!info.isFile()) return null
      const size = Number(info.size)
      const cursor = context.cursor(file)
      if (unchanged(cursor, size, info.mtimeNs)) return null
      const bytes = cursor && cursor.offset <= size ? size - cursor.offset : size
      return { file, cursor, bytes }
    }),
  )
  return pending.filter((item) => item !== null)
}

/** Anything but a non-negative integer counts as 0, as in cc-switch. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** cc-switch's choice among a message's lines: one with a stop_reason, then the most output. */
function replaces(known: Message | undefined, stopped: boolean, output: number): boolean {
  if (!known) return true
  if (stopped !== known.stopped) return stopped
  return output > known.row.output
}

function readLine(
  json: string,
  messages: Map<string, Message>,
  fallbackAt: number,
  held: Held,
): void {
  let line: Line | null
  try {
    line = JSON.parse(json) as Line | null
  } catch {
    return
  }
  // A sidechain's context is its own, which the main thread's requests do not carry.
  const main = line?.isSidechain !== true
  if (line?.type === 'system' && line.subtype === 'compact_boundary') {
    held.count = 0
    held.bytes = 0
    return
  }
  if (line?.type === 'user') {
    if (main) holdImages(line.message?.content, held)
    return
  }
  const message = line?.message
  const usage = message?.usage
  if (line?.type !== 'assistant' || typeof message?.id !== 'string' || usage == null) return
  const id = message.id
  const stopped = typeof message.stop_reason === 'string'
  const output = count(usage.output_tokens)
  const known = messages.get(id)
  if (!replaces(known, stopped, output)) return
  // The images as the message's first line found them, which its request carried.
  const images = known ? (known.row.images ?? 0) : main ? held.count : 0
  const imageBytes = known ? (known.row.imageBytes ?? 0) : main ? held.bytes : 0
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
  messages.set(id, {
    stopped,
    row: {
      key: `claude:${id}`,
      source: 'log',
      agentId: AGENT_ID,
      sessionId: text(line.sessionId),
      project: text(line.cwd),
      model: normalizeModel(text(message.model)),
      at: Number.isFinite(at) ? at : fallbackAt,
      input: count(usage.input_tokens),
      output,
      reasoning: null,
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      // Read apart only here; the total still includes it.
      cacheWrite1h: count(usage.cache_creation?.ephemeral_1h_input_tokens),
      turn: 0,
      ...(images > 0 ? { images, imageBytes } : {}),
    },
  })
}

/** One log's rows since its cursor, and the cursor after them. */
export async function readLog(
  file: string,
  cursor: FileCursor | null,
  signal: AbortSignal,
): Promise<{ rows: UsageRow[]; cursor: FileCursor }> {
  const log = await openLog(file)
  const start = await resumeOffset(log.source, cursor)
  const messages = new Map<string, Message>()
  const held = heldOf(cursor, start)
  // For a line without a usable timestamp, which no Claude Code log seen so far has.
  const fallbackAt = Number(log.mtimeNs / 1_000_000n)
  const offset = await eachLine(
    log.source,
    start,
    (json) => readLine(json, messages, fallbackAt, held),
    { contains: NEEDLES, signal },
  )
  const rows: UsageRow[] = []
  for (const { row } of messages.values()) {
    // Requests that end without a stop_reason still count when they used anything.
    if (row.input > 0 || row.output > 0 || row.cacheRead > 0 || row.cacheWrite > 0) rows.push(row)
  }
  return {
    rows,
    cursor: {
      id: file,
      agentId: AGENT_ID,
      size: log.size,
      mtimeNs: log.mtimeNs,
      offset,
      tail: await tailHash(log.source, offset),
      state: held.count > 0 ? JSON.stringify({ images: held.count, imageBytes: held.bytes }) : null,
    },
  }
}

export const claudeReader: LogReader = {
  agentId: AGENT_ID,

  locations: (env, home) => [projectsFolder(env, home, process.platform)],

  async scan(context) {
    const files = await listLogs(
      projectsFolder(context.env, context.home, context.platform),
      context.log,
    )
    if (!files) return false
    const pending = await changedLogs(files, context)
    context.plan(
      pending.length,
      pending.reduce((sum, item) => sum + item.bytes, 0),
    )
    for (const item of pending) {
      context.signal.throwIfAborted()
      let read
      try {
        read = await readLog(item.file, item.cursor, context.signal)
      } catch (error) {
        if (context.signal.aborted) throw error
        // Not committed, so the next scan tries the file again.
        context.log('warn', `Could not read ${item.file}: ${(error as Error).message}`)
      }
      if (read) context.commit(read.rows, read.cursor)
      context.done(item.bytes)
    }
    return true
  },
}

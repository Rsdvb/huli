// Huli: the import from the agents, Settings › General › Import from agents. It lists every past
// session of an agent across all the folders it ran in, so they can be imported with
// `sessions.import` in one go instead of a project at a time. Claude Code's transcripts are read
// here, only their heads and tails; Codex's threads and an ACP agent's sessions come from the agent,
// asked without a folder. Nothing of the agents' is ever written. Huli's own; see
// tools/huli/README.md.

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CANNOT_LIST,
  type AgentHistoryPage,
  type AgentHistorySession,
  type HistoryCopyOutcome,
  type HistoryCopyPlan,
  type HistorySource,
} from '@shared/agent-history'
import { harnessOf, type AgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import {
  locateTranscript,
  readDesktopIndex,
  type DesktopSession,
  type DesktopTranscript,
} from './claude-desktop'
import {
  folderSource,
  LISTED_FILES,
  planCopy,
  runCopy,
  scanCodexRollouts,
  writtenFiles,
  type FolderHarness,
  type FolderScan,
  type PlannedCopy,
} from './agent-history-folder'
import { agentError, type AgentRuntime } from './agents'
import { AgentRequestError, type ListedEverywhere } from './connection'
import { HostError, invalidParams } from './errors'
import { t } from './i18n'
import type { KeptField } from './sessions'
import type { LogFn, SessionRecord } from './storage'

/** What is read of a transcript's start: its first records name its folder and first prompt. */
export const HEAD_BYTES = 64 * 1024
/** And of its end, where Claude Code appends titles, moves and the latest times. */
export const TAIL_BYTES = 64 * 1024
/** Transcripts read at once. */
const READS = 16
/** Sessions a page of Claude Code's carries. */
export const CLAUDE_PAGE = 500
/** The titles and times kept for imports, newest listed last. */
const KEPT = 20_000
const TITLE_CHARS = 200

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
/** Older Claude Code kept a subagent's transcript beside the sessions, named this way. */
const AGENT_FILE = /^agent-[\w-]+\.jsonl$/i

/** A session as an agent recorded it, before the filters. */
export interface HistoryItem {
  sessionId: string
  title: string | null
  cwd: string
  createdAt: number | null
  updatedAt: number | null
  /** Another session started it: a Claude Code sidechain, a Codex subagent's thread. */
  subagent: boolean
  /** It holds a message from the user. */
  prompted: boolean
}

interface Cached {
  size: number
  mtimeMs: number
  item: ClaudeRead | null
}

/** A Claude Code transcript, and how well the folder it sits in fits the folders it names. */
interface ClaudeRead extends HistoryItem {
  /**
   * 0 when its project folder is that of the folder it was moved to, 1 of the folder it ran in
   * last, 2 of the one it started in, 3 of none: the lowest is the copy Claude Code resumes.
   */
  fit: number
}

type Json = Record<string, unknown>

function parse(line: string): Json | null {
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

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** The words of a prompt, without the reminders and command tags Claude Code wraps around it. */
function promptText(content: unknown): string | null {
  let raw: string | null = null
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    const parts = content.flatMap((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Json).type === 'text' &&
      typeof (block as Json).text === 'string'
        ? [(block as Json).text as string]
        : [],
    )
    raw = parts.length > 0 ? parts.join(' ') : null
  }
  if (raw === null) return null
  const cleaned = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<[^>\n]{1,60}>/g, ' ')
  return titleOf(cleaned)
}

function titleOf(value: string | null): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (collapsed === '') return null
  const chars = Array.from(collapsed)
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : collapsed
}

/** The name Claude Code gives a folder's project folder; a long one it cuts and hashes. */
export function claudeFolderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function sameFolderName(cwd: string, folder: string, platform: Platform): boolean {
  const encoded = claudeFolderName(cwd)
  const a = platform === 'win32' ? encoded.toLowerCase() : encoded
  const b = platform === 'win32' ? folder.toLowerCase() : folder
  return a === b || (a.length > 200 && b.length >= 200 && b.startsWith(a.slice(0, 200)))
}

/** `\\?\C:\x` as `C:\x`: Codex records long-path forms on Windows. */
export function plainPath(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  return value
}

async function readRange(
  file: string,
  size: number,
): Promise<{ head: string; tail: string | null }> {
  const handle = await open(file, 'r')
  try {
    const headLength = Math.min(size, HEAD_BYTES)
    const head = Buffer.alloc(headLength)
    await handle.read(head, 0, headLength, 0)
    if (size <= HEAD_BYTES) return { head: head.toString('utf8'), tail: null }
    const start = Math.max(HEAD_BYTES, size - TAIL_BYTES)
    const tail = Buffer.alloc(size - start)
    await handle.read(tail, 0, tail.length, start)
    return { head: head.toString('utf8'), tail: tail.toString('utf8') }
  } finally {
    await handle.close()
  }
}

/**
 * Reads one transcript's head and tail. Null when it names no folder; a sidechain or one with no
 * prompt is returned marked, to be counted.
 */
export async function readClaudeTranscript(
  file: string,
  folder: string,
  size: number,
  mtimeMs: number,
  platform: Platform,
): Promise<ClaudeRead | null> {
  const name = path.basename(file)
  const id = SESSION_FILE.exec(name)?.[1]
  if (!id) return null
  const { head, tail } = await readRange(file, size)
  const headLines = head.split('\n')
  // The last line of a cut head runs on past it.
  if (tail !== null) headLines.pop()
  let sidechain: boolean | null = null
  let firstCwd: string | null = null
  let createdAt: number | null = null
  let prompted = false
  let firstPrompt: string | null = null
  for (const line of headLines) {
    const record = parse(line)
    if (!record) continue
    if (sidechain === null && typeof record.isSidechain === 'boolean') {
      sidechain = record.isSidechain
    }
    firstCwd ??= text(record.cwd)
    createdAt ??= time(record.timestamp)
    if (record.type === 'user') {
      prompted = true
      const message = record.message as Json | undefined
      if (firstPrompt === null && record.isMeta !== true) firstPrompt = promptText(message?.content)
    }
  }
  // A first prompt larger than the head is cut off, but its record still says what it is.
  if (!prompted && /"type":"user"/.test(head)) prompted = true
  if (firstCwd === null) {
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head)
    if (match) firstCwd = text(JSON.parse(match[1]!))
  }
  if (sidechain === null) sidechain = /"isSidechain":true/.test(head)

  const tailLines = tail === null ? headLines : tail.split('\n').slice(1)
  let customTitle: string | null = null
  let agentName: string | null = null
  let aiTitle: string | null = null
  let summary: string | null = null
  let lastPrompt: string | null = null
  let relocated: string | null = null
  let lastCwd: string | null = null
  let updatedAt: number | null = null
  for (const line of tailLines) {
    const record = parse(line)
    if (!record) continue
    switch (record.type) {
      case 'custom-title':
        customTitle = text(record.customTitle) ?? customTitle
        break
      case 'agent-name':
        agentName = text(record.agentName) ?? agentName
        break
      case 'ai-title':
        aiTitle = text(record.aiTitle) ?? aiTitle
        break
      case 'summary':
        summary = text(record.summary) ?? summary
        break
      case 'last-prompt':
        lastPrompt = text(record.lastPrompt) ?? lastPrompt
        break
      case 'relocated':
        relocated = text(record.relocatedCwd) ?? relocated
        break
      case 'user':
        prompted = true
        break
    }
    lastCwd = text(record.cwd) ?? lastCwd
    updatedAt = time(record.timestamp) ?? updatedAt
  }

  // The folder it ran in last; a copy Claude Code left behind when it moved the session names
  // another folder than the one it sits in.
  const named = [relocated, lastCwd, firstCwd]
  const found = named.findIndex((value) => !!value && sameFolderName(value, folder, platform))
  const fit = found === -1 ? named.length : found
  const cwd = named[fit] ?? named.find((value) => !!value)
  if (!cwd) return null
  return {
    sessionId: id,
    title: titleOf(customTitle ?? agentName ?? aiTitle ?? summary ?? firstPrompt ?? lastPrompt),
    cwd,
    createdAt,
    updatedAt: updatedAt ?? (Number.isFinite(mtimeMs) ? Math.round(mtimeMs) : null),
    subagent: sidechain,
    prompted,
    fit,
  }
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
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

/**
 * Every session under Claude Code's `projects` folder, newest first. Only each project folder's
 * own transcripts are read: subagents' are in `<session>/subagents`, which is never entered. A
 * session copied to another folder when Claude Code moved it is listed once, from the folder it
 * names. `cache` keeps what was read by path, size and time, so a second look reads only changes.
 */
export async function scanClaudeHistory(
  configDir: string,
  platform: Platform,
  cache: Map<string, Cached>,
  log: LogFn,
): Promise<ClaudeScan> {
  return scanClaudeProjects(path.join(configDir, 'projects'), platform, cache, log)
}

/**
 * Huli: the sessions under a `projects` folder `root`, as `scanClaudeHistory`; `only` names the
 * one project folder under it to read, for a chosen folder that is a project's.
 */
export async function scanClaudeProjects(
  root: string,
  platform: Platform,
  cache: Map<string, Cached>,
  log: LogFn,
  only: string | null = null,
): Promise<ClaudeScan> {
  const files: { file: string; folder: string }[] = []
  let oldSubagents = 0
  const folders = (await entries(root)).filter(
    (entry) => entry.isDirectory() && (only === null || entry.name === only),
  )
  await eachLimited(folders, READS, async (entry) => {
    for (const child of await entries(path.join(root, entry.name)).catch(() => [])) {
      if (!child.isFile()) continue
      if (SESSION_FILE.test(child.name)) {
        files.push({ file: path.join(root, entry.name, child.name), folder: entry.name })
      } else if (AGENT_FILE.test(child.name)) oldSubagents++
    }
  })
  const seen = new Set<string>()
  const byId = new Map<string, ClaudeRead>()
  const fileOf = new Map<string, string>()
  const copies = new Map<string, number>()
  await eachLimited(files, READS, async ({ file, folder }) => {
    seen.add(file)
    try {
      const info = await stat(file)
      let item: ClaudeRead | null
      const cached = cache.get(file)
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        item = cached.item
      } else {
        item = await readClaudeTranscript(file, folder, info.size, info.mtimeMs, platform)
        cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, item })
      }
      if (!item) return
      copies.set(item.sessionId, (copies.get(item.sessionId) ?? 0) + 1)
      const other = byId.get(item.sessionId)
      if (
        !other ||
        item.fit < other.fit ||
        (item.fit === other.fit && (item.updatedAt ?? 0) > (other.updatedAt ?? 0))
      ) {
        byId.set(item.sessionId, item)
        fileOf.set(item.sessionId, file)
      }
    } catch (error) {
      log('warn', `Could not read Claude Code transcript ${file}: ${(error as Error).message}`)
    }
  })
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file)
  const items = [...byId.values()].map((read): HistoryItem => {
    const { sessionId, title, cwd, createdAt, updatedAt, subagent, prompted } = read
    return { sessionId, title, cwd, createdAt, updatedAt, subagent, prompted }
  })
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const copied = new Set([...copies].filter(([, count]) => count > 1).map(([id]) => id))
  return { items, oldSubagents, copied, files: fileOf }
}

export interface ClaudeScan {
  /** Newest first. */
  items: HistoryItem[]
  /** Subagents' transcripts an older Claude Code kept beside the sessions, `agent-*.jsonl`. */
  oldSubagents: number
  /** Huli: the sessions with a transcript in more than one project folder. */
  copied: ReadonlySet<string>
  /** Huli: the transcript each listed session was read from. */
  files: ReadonlyMap<string, string>
}

/** A session an agent listed across its folders, in the import's terms. */
export function historyItemOf(listed: ListedEverywhere): HistoryItem {
  return {
    sessionId: listed.sessionId,
    title: titleOf(listed.title),
    cwd: plainPath(listed.cwd),
    createdAt: listed.createdAt === null ? null : time(listed.createdAt),
    updatedAt: listed.updatedAt === null ? null : time(listed.updatedAt),
    subagent: listed.subagent,
    prompted: listed.prompted,
  }
}

/**
 * The page the dialog shows: subagents' sessions and ones without a prompt are counted and left
 * out, and each is marked imported when a session here has its id, and missing when its folder is
 * gone.
 */
export function historyPage(
  items: readonly HistoryItem[],
  imported: ReadonlySet<string>,
  folderGone: ReadonlySet<string>,
  nextCursor: string | null,
): AgentHistoryPage {
  const hidden = { subagents: 0, empty: 0 }
  const sessions: AgentHistorySession[] = []
  for (const item of items) {
    if (item.subagent) hidden.subagents++
    else if (!item.prompted) hidden.empty++
    else {
      sessions.push({
        acpSessionId: item.sessionId,
        title: item.title,
        cwd: item.cwd,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        imported: imported.has(item.sessionId),
        missing: folderGone.has(item.cwd),
      })
    }
  }
  return { sessions, nextCursor, hidden }
}

export interface AgentHistoryDeps {
  platform: Platform
  agents: {
    has(agentId: AgentId): boolean
    assertEnabled(agentId: AgentId): void
    name(agentId: AgentId): string
    /** The agent's own configuration folder, as for Claude Code `CLAUDE_CONFIG_DIR`. */
    configFolder(agentId: AgentId): string | null
    /** Huli: every agent here, for the Claude Code sessions any of them has. */
    ids?(): AgentId[]
    ensureReady(agentId: AgentId): Promise<Pick<AgentRuntime, 'connection' | 'init'>>
  }
  sessions: {
    /** The ids here of the agent's sessions, and of the agents' that share its history. */
    agentSessionIds(agentId: AgentId): Set<string>
    /** Huli: how another folder's copy of an imported session's transcript stands to its own. */
    outsideCopy?(agentId: AgentId, acpSessionId: string): Promise<'newer' | 'fork' | null>
    /** Huli: deleted here while the agent keeps its copy, so it is not offered again. */
    wasDeleted?(agentId: AgentId, acpSessionId: string): boolean
  }
  /** Huli: the Claude desktop app's data folders that hold its index of Code sessions. */
  desktopFolders?(): Promise<string[]>
  isDirectory?(folder: string): Promise<boolean>
  log: LogFn
  now?(): number
}

type Kept = Partial<Pick<SessionRecord, KeptField>>

/** Huli: a chosen folder's last listing, which its later pages and its copy plans come from. */
interface FolderListing extends FolderScan {
  oldSubagents: number
  /** The folder its sessions were read from, inside the chosen one. */
  source: string
}

/**
 * Huli: what an ACP agent answers `session/list` without a folder with when it lists only a
 * folder's sessions: JSON-RPC's invalid params and method not found.
 */
const NO_FOLDER_REFUSED: ReadonlySet<number> = new Set([-32602, -32601])

/** Huli: how long a copy plan waits for the user's confirmation. */
const PLAN_MS = 15 * 60 * 1000
/** Huli: the chosen folders' listings and the plans kept at once. */
const KEPT_FOLDERS = 4
const KEPT_PLANS = 8

function pageOf<T>(items: readonly T[], cursor: string | null) {
  const offset = cursor === null ? 0 : Math.max(0, Number(cursor) || 0)
  const end = offset + CLAUDE_PAGE
  return {
    offset,
    items: items.slice(offset, end),
    nextCursor: end < items.length ? String(end) : null,
  }
}

function keepAtMost<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) map.delete(map.keys().next().value!)
}

/** Whether `child` is `parent` or inside it, compared as the platform compares paths. */
async function inside(child: string, parent: string, platform: Platform): Promise<boolean> {
  const real = async (value: string) =>
    (await realpath(value).catch(() => path.resolve(value))).replace(/[\\/]+$/, '')
  let [a, b] = await Promise.all([real(child), real(parent)])
  if (platform === 'win32') {
    a = a.toLowerCase()
    b = b.toLowerCase()
  }
  return a === b || a.startsWith(`${b}${path.sep}`)
}

export class AgentHistory {
  private readonly claudeCache = new Map<string, Map<string, Cached>>()
  /** A Claude Code agent's last scan, which its later pages are cut from. */
  private readonly scans = new Map<AgentId, ClaudeScan>()
  private readonly kept = new Map<string, Kept>()
  /** Huli: what the Claude desktop app's index kept of the sessions it listed. */
  private readonly desktopKept = new Map<string, Kept>()
  private readonly folders = new Map<string, FolderListing>()
  private readonly plans = new Map<
    string,
    { agentId: AgentId; created: number; copies: PlannedCopy[] }
  >()

  constructor(private readonly deps: AgentHistoryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * An agent's past sessions; Huli: with `folder`, those of another folder of the agent's kind
   * rather than its own, which an import copies into its own with `planCopy` and `copy`; with
   * `index`, those another app's index lists, as the Claude desktop app's.
   */
  async list(
    agentId: AgentId,
    cursor: string | null,
    folder: string | null = null,
    index: HistorySource | null = null,
  ): Promise<AgentHistoryPage> {
    const { agents } = this.deps
    if (!agents.has(agentId)) throw invalidParams(`Unknown agent ${agentId}`)
    agents.assertEnabled(agentId)
    if (index === 'claude-desktop') return this.desktopPage(agentId)
    let items: HistoryItem[]
    let nextCursor: string | null
    let oldSubagents = 0
    let copied: ReadonlySet<string> = new Set()
    let source: string | undefined
    if (folder !== null) {
      const listing = await this.folderListing(agentId, folder, cursor === null)
      const page = pageOf(listing.items, cursor)
      items = page.items
      nextCursor = page.nextCursor
      oldSubagents = page.offset === 0 ? listing.oldSubagents : 0
      source = listing.source
    } else if (harnessOf(agentId) === 'claude-code') {
      ;({ items, nextCursor, oldSubagents, copied } = await this.claudePage(agentId, cursor))
    } else {
      const runtime = await agents.ensureReady(agentId)
      const connection = runtime.connection
      if (!runtime.init.capabilities.listSessions || !connection.listAllSessions) {
        throw this.cannotList(agentId)
      }
      let page
      try {
        page = await connection.listAllSessions(cursor)
      } catch (error) {
        // Huli: an ACP agent that lists only a folder's sessions says so by refusing no folder.
        if (error instanceof AgentRequestError && NO_FOLDER_REFUSED.has(error.code ?? 0)) {
          throw this.cannotList(agentId)
        }
        throw agentError(error)
      }
      items = page.sessions.map(historyItemOf)
      nextCursor = page.nextCursor
    }
    // Huli: one deleted here whose agent keeps its copy stays deleted; another folder's is a
    // backup the user chose, so it is offered.
    const wasDeleted = this.deps.sessions.wasDeleted?.bind(this.deps.sessions)
    if (wasDeleted && folder === null) {
      items = items.filter((item) => !wasDeleted(agentId, item.sessionId))
    }
    const gone = await this.goneFolders(items)
    const result = historyPage(items, this.deps.sessions.agentSessionIds(agentId), gone, nextCursor)
    result.hidden.subagents += oldSubagents
    if (source !== undefined) result.source = source
    for (const session of result.sessions) this.keep(agentId, session)
    const outsideCopy = this.deps.sessions.outsideCopy?.bind(this.deps.sessions)
    if (outsideCopy && folder === null) {
      const twice = result.sessions.filter((s) => s.imported && copied.has(s.acpSessionId))
      await eachLimited(twice, READS, async (session) => {
        const state = await outsideCopy(agentId, session.acpSessionId).catch(() => null)
        if (state) session.outside = state
      })
    }
    return result
  }

  /**
   * Huli: what copying the chosen sessions of a folder `list` read writes into the agent's own
   * folder, for the user to confirm; `copy` runs it. Nothing is written yet.
   */
  async planCopy(
    agentId: AgentId,
    folder: string,
    sessionIds: readonly string[],
  ): Promise<HistoryCopyPlan> {
    const { agents } = this.deps
    if (!agents.has(agentId)) throw invalidParams(`Unknown agent ${agentId}`)
    agents.assertEnabled(agentId)
    const harness = this.folderHarness(agentId)
    const listing = this.folders.get(`${agentId}\n${folder}`)
    if (!listing) throw new HostError('not_found', t('agentHistory.listAgain'))
    const target = agents.configFolder(agentId)
    if (!target) throw this.cannotList(agentId)
    const byId = new Map(listing.items.map((item) => [item.sessionId, item]))
    const chosen = [...new Set(sessionIds)].flatMap((id) => {
      const item = byId.get(id)
      const file = listing.files.get(id)
      return item && file ? [{ item, file }] : []
    })
    if (chosen.length === 0) throw invalidParams('None of these sessions is in the folder listed')
    const gone = await this.goneFolders(chosen.map((entry) => entry.item))
    const now = this.now()
    const planned = new Map<string, PlannedCopy>()
    await eachLimited(chosen, READS, async ({ item, file }) => {
      planned.set(
        item.sessionId,
        await planCopy({ harness, target, session: item, file, missing: gone.has(item.cwd), now }),
      )
    })
    const copies = chosen.map((entry) => planned.get(entry.item.sessionId)!)
    for (const [token, plan] of this.plans) {
      if (now - plan.created > PLAN_MS) this.plans.delete(token)
    }
    const token = randomUUID()
    this.plans.set(token, { agentId, created: now, copies })
    keepAtMost(this.plans, KEPT_PLANS)
    return {
      token,
      target,
      items: copies.map((copy) => {
        const files = writtenFiles(copy)
        return {
          acpSessionId: copy.acpSessionId,
          title: copy.title,
          cwd: copy.cwd,
          action: copy.action,
          files: files.slice(0, LISTED_FILES),
          moreFiles: Math.max(0, files.length - LISTED_FILES),
          backup: copy.replaced?.backup ?? null,
        }
      }),
    }
  }

  /** Huli: runs a plan `planCopy` made, once. */
  async copy(token: string): Promise<{ items: HistoryCopyOutcome[] }> {
    const plan = this.plans.get(token)
    this.plans.delete(token)
    if (!plan || this.now() - plan.created > PLAN_MS) {
      throw new HostError('not_found', t('agentHistory.planGone'))
    }
    this.deps.agents.assertEnabled(plan.agentId)
    const items: HistoryCopyOutcome[] = []
    for (const copy of plan.copies) items.push(await runCopy(copy))
    const written = items.reduce((sum, item) => sum + item.written, 0)
    this.deps.log(
      'info',
      `Copied ${written} files of ${items.length} sessions from another folder into ${plan.agentId}'s own`,
    )
    for (const item of items) {
      if (item.status === 'failed') {
        this.deps.log('warn', `Could not copy session ${item.acpSessionId}: ${item.message ?? ''}`)
      }
    }
    return { items }
  }

  private folderHarness(agentId: AgentId): FolderHarness {
    const harness = harnessOf(agentId)
    if (harness === 'claude-code' || harness === 'codex') return harness
    throw new HostError(
      'agent_unavailable',
      t('agentHistory.folderUnsupported', { agent: this.deps.agents.name(agentId) }),
    )
  }

  /** A chosen folder's sessions, read again when `fresh`. */
  private async folderListing(
    agentId: AgentId,
    folder: string,
    fresh: boolean,
  ): Promise<FolderListing> {
    const key = `${agentId}\n${folder}`
    const kept = fresh ? undefined : this.folders.get(key)
    if (kept) return kept
    const harness = this.folderHarness(agentId)
    const agent = this.deps.agents.name(agentId)
    const info = await stat(folder).catch(() => null)
    if (!info?.isDirectory()) {
      throw new HostError('not_found', t('agentHistory.notFolder', { folder }))
    }
    const source = await folderSource(folder, harness)
    if (!source) throw new HostError('not_found', t('agentHistory.noSessionsIn', { agent, folder }))
    const own = this.deps.agents.configFolder(agentId)
    if (own && (await inside(source.root, own, this.deps.platform))) {
      throw new HostError('invalid_params', t('agentHistory.ownFolder', { agent }))
    }
    const started = Date.now()
    let listing: FolderListing
    if (source.harness === 'claude-code') {
      const scan = await scanClaudeProjects(
        source.root,
        this.deps.platform,
        this.cacheFor(`folder\n${source.root}`),
        this.deps.log,
        source.only,
      )
      listing = {
        items: scan.items,
        files: scan.files,
        oldSubagents: scan.oldSubagents,
        source: source.only === null ? source.root : path.join(source.root, source.only),
      }
    } else {
      const scan = await scanCodexRollouts(source, this.deps.log)
      listing = { ...scan, oldSubagents: 0, source: source.root }
    }
    this.deps.log(
      'info',
      `Listed ${listing.items.length} ${agent} sessions of another folder in ${Date.now() - started} ms`,
    )
    if (listing.items.length === 0 && listing.oldSubagents === 0) {
      throw new HostError('not_found', t('agentHistory.noSessionsIn', { agent, folder }))
    }
    this.folders.delete(key)
    this.folders.set(key, listing)
    keepAtMost(this.folders, KEPT_FOLDERS)
    return listing
  }

  private cacheFor(key: string): Map<string, Cached> {
    let cache = this.claudeCache.get(key)
    if (!cache) {
      cache = new Map()
      this.claudeCache.set(key, cache)
    }
    return cache
  }

  /**
   * What an import of a listed session takes over from the listing: its title and times. Nothing
   * for one this host has not listed. Huli: with `source`, chosen among the Claude desktop app's
   * sessions, the app's title, times and archive win over its transcript's; chosen from the
   * agent's own listing, they are not applied.
   */
  keptFor(agentId: AgentId, acpSessionId: string, source: HistorySource | null = null): Kept {
    const key = `${agentId}\n${acpSessionId}`
    const desktop = source === 'claude-desktop' ? this.desktopKept.get(key) : undefined
    return { ...this.kept.get(key), ...desktop }
  }

  private cannotList(agentId: AgentId): HostError {
    return new HostError(
      'agent_unavailable',
      t('session.cannotList', { agent: this.deps.agents.name(agentId) }),
      { reason: CANNOT_LIST },
    )
  }

  /**
   * Huli: the Claude Code agents that could import the Claude desktop app's sessions, one for each
   * configuration folder, `agentId` first; a disabled one is left out unless it is `agentId`.
   */
  private desktopCandidates(agentId: AgentId): { agentId: AgentId; configDir: string }[] {
    const { agents, platform } = this.deps
    const candidates: { agentId: AgentId; configDir: string }[] = []
    const seen = new Set<string>()
    for (const id of [agentId, ...(agents.ids?.() ?? []).filter((other) => other !== agentId)]) {
      if (harnessOf(id) !== 'claude-code') continue
      if (id !== agentId) {
        try {
          agents.assertEnabled(id)
        } catch {
          continue
        }
      }
      const configDir = agents.configFolder(id)
      if (!configDir) continue
      const resolved = path.resolve(configDir)
      const key = platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ agentId: id, configDir })
    }
    return candidates
  }

  /**
   * Huli: the Claude desktop app's Code sessions, from its own index, each as the Claude Code
   * session whose transcript the agent's folder holds. One the app deleted is not listed; one it
   * archived, one in its scratch folder and one whose transcript is gone are marked. Sessions that
   * run the same Claude Code session are listed once, the latest. The app runs Claude Code with a
   * configuration folder its own settings may name, which are not read: of the Claude Code agents
   * here, the one whose folder holds the most of its transcripts imports them.
   */
  private async desktopPage(asked: AgentId): Promise<AgentHistoryPage> {
    const candidates = this.desktopCandidates(asked)
    if (candidates.length === 0) throw this.cannotList(asked)
    const started = Date.now()
    const index = await readDesktopIndex((await this.deps.desktopFolders?.()) ?? [])
    let best: {
      agentId: AgentId
      located: Map<string, DesktopTranscript | null>
      found: number
    } | null = null
    for (const { agentId: candidate, configDir } of candidates) {
      const projects = path.join(configDir, 'projects')
      const located = new Map<string, DesktopTranscript | null>()
      let found = 0
      await eachLimited(index.sessions, READS, async (session) => {
        const transcript = await locateTranscript(session, projects).catch(() => null)
        located.set(session.id, transcript)
        if (transcript?.found) found++
      })
      if (!best || found > best.found) best = { agentId: candidate, located, found }
      if (found === index.sessions.length) break
    }
    const agentId = best!.agentId
    const here = this.deps.sessions.agentSessionIds(agentId)
    const rows = new Map<string, { row: AgentHistorySession; session: DesktopSession }>()
    for (const session of index.sessions) {
      const transcript = best!.located.get(session.id) ?? null
      const acpSessionId = transcript?.acpSessionId ?? session.id
      const folder = transcript?.folder ?? session.cwd
      const row: AgentHistorySession = {
        acpSessionId,
        title: session.title,
        cwd: folder,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        imported: [acpSessionId, session.cliSessionId, session.lastAssistantCliSessionId].some(
          (id) => id !== null && here.has(id),
        ),
        missing: false,
        ...(session.archived ? { archived: true as const } : {}),
        ...(session.scratch && folder === session.cwd ? { scratch: true as const } : {}),
        ...(transcript?.found ? {} : { unavailable: true as const }),
      }
      // Of two that run one session, the one whose transcript is found, then the latest.
      const other = rows.get(acpSessionId)?.row
      const better =
        !other ||
        (other.unavailable === true && row.unavailable === undefined) ||
        (other.unavailable === row.unavailable && (row.updatedAt ?? 0) > (other.updatedAt ?? 0))
      if (better) rows.set(acpSessionId, { row, session })
    }
    const listed = [...rows.values()].sort(
      (a, b) => (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0),
    )
    const gone = await this.goneFolders(listed.map(({ row }) => row))
    for (const { row, session } of listed) {
      row.missing = gone.has(row.cwd)
      if (!row.unavailable) this.keepDesktop(agentId, row, session)
    }
    this.deps.log(
      'info',
      `Listed ${listed.length} Claude desktop app sessions of ${index.folders.length} data folders in ${Date.now() - started} ms` +
        (index.unreadable > 0 ? `; ${index.unreadable} index files left out` : ''),
    )
    return {
      sessions: listed.map(({ row }) => row),
      nextCursor: null,
      hidden: { subagents: 0, empty: 0 },
      ...(index.folders.length > 0 ? { source: index.folders.join('\n') } : {}),
      agentId,
    }
  }

  /** Huli: what an import of a desktop app's session takes over from the app's index. */
  private keepDesktop(agentId: AgentId, row: AgentHistorySession, session: DesktopSession): void {
    const key = `${agentId}\n${row.acpSessionId}`
    const title = row.title
    this.desktopKept.delete(key)
    this.desktopKept.set(key, {
      ...(title
        ? session.userTitle
          ? { customTitle: title }
          : { title, titleSource: 'agent' as const }
        : {}),
      ...(row.createdAt !== null ? { createdAt: row.createdAt } : {}),
      ...(row.updatedAt !== null ? { updatedAt: row.updatedAt } : {}),
      ...(row.archived ? { archivedAt: row.updatedAt ?? this.now() } : {}),
    })
    if (this.desktopKept.size > KEPT) this.desktopKept.delete(this.desktopKept.keys().next().value!)
  }

  private async claudePage(
    agentId: AgentId,
    cursor: string | null,
  ): Promise<{
    items: HistoryItem[]
    nextCursor: string | null
    oldSubagents: number
    copied: ReadonlySet<string>
  }> {
    let scan = cursor === null ? undefined : this.scans.get(agentId)
    if (!scan) {
      const configDir = this.deps.agents.configFolder(agentId)
      if (!configDir) throw this.cannotList(agentId)
      const started = Date.now()
      scan = await scanClaudeHistory(
        configDir,
        this.deps.platform,
        this.cacheFor(configDir),
        this.deps.log,
      )
      this.deps.log(
        'info',
        `Listed ${scan.items.length} Claude Code sessions of every folder in ${Date.now() - started} ms`,
      )
      this.scans.set(agentId, scan)
    }
    const page = pageOf(scan.items, cursor)
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      oldSubagents: page.offset === 0 ? scan.oldSubagents : 0,
      copied: scan.copied,
    }
  }

  private async goneFolders(items: readonly { cwd: string }[]): Promise<Set<string>> {
    const folders = [...new Set(items.filter((item) => item.cwd !== '').map((item) => item.cwd))]
    const gone = new Set<string>()
    const isDirectory =
      this.deps.isDirectory ??
      ((folder: string) =>
        stat(folder).then(
          (info) => info.isDirectory(),
          () => false,
        ))
    await eachLimited(folders, READS, async (folder) => {
      if (!path.isAbsolute(folder) || !(await isDirectory(folder))) gone.add(folder)
    })
    return gone
  }

  private keep(agentId: AgentId, session: AgentHistorySession): void {
    const key = `${agentId}\n${session.acpSessionId}`
    this.kept.delete(key)
    this.kept.set(key, {
      ...(session.title ? { title: session.title, titleSource: 'agent' as const } : {}),
      ...(session.createdAt !== null ? { createdAt: session.createdAt } : {}),
      ...(session.updatedAt !== null ? { updatedAt: session.updatedAt } : {}),
    })
    if (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!)
  }
}

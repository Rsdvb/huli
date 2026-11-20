// Huli: the Claude desktop app's Code sessions, for the import from the agents. The app runs Claude
// Code itself, whose transcripts go where any Claude Code's do, and keeps an index of its own in its
// data folder: one JSON file per session under `claude-code-sessions/<account>/<organization>/`,
// with the app's title and times, its archive and the Claude Code session it runs. Only that index
// is read, never written, and of each file only the fields below. Huli's own; see
// tools/huli/README.md.

import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { pathKey } from './paths'
import { claudeProjectFolder } from './prompt-cache'

/** Names the app's data folders to read instead of looking for them, as a test copy does. */
export const DESKTOP_DATA_VARIABLE = 'KITE_CLAUDE_DESKTOP_DATA'

export const DESKTOP_SESSIONS_FOLDER = 'claude-code-sessions'
const INDEX_FILE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i
const DELETED_FILE = /^deleted_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const ARCHIVED_FILE = 'archived-sessions.idx'
/** The archive list's format this reads; another is left alone, `isArchived` still counting. */
const ARCHIVED_VERSION = 1
const CLI_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An index file larger than this is no session's. */
const INDEX_BYTES = 4 * 1024 * 1024
const ARCHIVED_BYTES = 4 * 1024 * 1024
/** The sessions read at most, across every folder. */
export const DESKTOP_SESSIONS = 5000
const READS = 16
const TITLE_CHARS = 200

/** A Code session of the Claude desktop app, as its index records it. */
export interface DesktopSession {
  /** The app's own id, `local_<uuid>`. */
  id: string
  /** The Claude Code session it runs now. */
  cliSessionId: string | null
  /** The Claude Code session that wrote its last reply, which may be another. */
  lastAssistantCliSessionId: string | null
  /** The folder Claude Code runs in. */
  cwd: string
  /** Where it started and the folder the app shows it under, when they differ from `cwd`. */
  origins: string[]
  title: string | null
  /** The user named it in the app. */
  userTitle: boolean
  /** Epoch ms. */
  createdAt: number | null
  updatedAt: number | null
  archived: boolean
  /** `cwd` is one of the app's scratch folders, made for a session without a project. */
  scratch: boolean
}

export interface DesktopIndex {
  sessions: DesktopSession[]
  /** The data folders whose index was read. */
  folders: string[]
  /** Index files left out: unreadable, too large, or of a shape this does not know. */
  unreadable: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** An absolute path on any of the platforms the app runs on. */
function absolute(value: unknown): string | null {
  const s = text(value)
  if (!s || s.includes('\0')) return null
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || /^[\\/]{2}[^\\/]/.test(s) ? s : null
}

/** A time the app wrote: epoch ms as a number or a string of digits, else an ISO date. */
export function desktopTime(value: unknown): number | null {
  const ms = (n: number): number | null =>
    Number.isFinite(n) && n > 0 ? Math.round(n < 1e11 ? n * 1000 : n) : null
  if (typeof value === 'number') return ms(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return ms(Number(trimmed))
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? at : null
}

function titleOf(value: unknown): string | null {
  const collapsed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (collapsed === '') return null
  const chars = Array.from(collapsed)
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : collapsed
}

/**
 * Whether a folder is one of the app's scratch folders,
 * `<data>/scratch-workspaces/<account>/<organization>/scratch-<day>-<hex>`, or inside one.
 */
export function isDesktopScratch(folder: string): boolean {
  const parts = folder.split(/[\\/]+/).filter(Boolean)
  const at = parts.map((part) => part.toLowerCase()).lastIndexOf('scratch-workspaces')
  return at >= 0 && parts.length >= at + 4 && /^scratch-/i.test(parts[at + 3]!)
}

/**
 * One index file's session, `uuid` its name's. Null for a file of a shape this does not know: not
 * an object, another session's id, or no folder.
 */
export function parseDesktopSession(value: unknown, uuid: string): DesktopSession | null {
  if (!isRecord(value)) return null
  const id = `local_${uuid.toLowerCase()}`
  if (value.sessionId !== undefined && String(value.sessionId).toLowerCase() !== id) return null
  const cwd = absolute(value.cwd)
  if (!cwd) return null
  const cli = (key: string): string | null => {
    const v = text(value[key])
    return v && CLI_SESSION.test(v) ? v.toLowerCase() : null
  }
  const place = isRecord(value.folderPlace) ? value.folderPlace : {}
  const origins: string[] = []
  for (const candidate of [absolute(value.originCwd), absolute(place.cwd)]) {
    if (candidate && candidate !== cwd && !origins.includes(candidate)) origins.push(candidate)
  }
  const createdAt = desktopTime(value.createdAt)
  const updatedAt =
    desktopTime(value.lastActivityAt) ??
    desktopTime(value.lastTurnEdgeAt) ??
    desktopTime(value.lastFocusedAt) ??
    createdAt
  return {
    id,
    cliSessionId: cli('cliSessionId'),
    lastAssistantCliSessionId: cli('lastAssistantCliSessionId'),
    cwd,
    origins,
    title: titleOf(value.title),
    userTitle: value.titleSource === 'user',
    createdAt,
    updatedAt,
    archived: value.isArchived === true,
    scratch: isDesktopScratch(cwd),
  }
}

/** The app ids `archived-sessions.idx` lists; null for a version this does not know. */
export function parseArchivedIndex(content: string): Set<string> | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.v !== ARCHIVED_VERSION || !Array.isArray(value.archived)) {
    return null
  }
  return new Set(
    value.archived
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.toLowerCase()),
  )
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

/** Reads a small file whole, or null when it is not one. */
async function smallFile(file: string, limit: number): Promise<string | null> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > limit) return null
  return readFile(file, 'utf8').catch(() => null)
}

/** The sessions of one `<account>/<organization>` folder of the index. */
async function readOrganization(
  folder: string,
  room: number,
): Promise<{ sessions: DesktopSession[]; unreadable: number }> {
  const names = (await entries(folder)).filter((entry) => entry.isFile()).map((e) => e.name)
  const deleted = new Set(
    names.flatMap((name) => {
      const uuid = DELETED_FILE.exec(name)?.[1]
      return uuid ? [uuid.toLowerCase()] : []
    }),
  )
  const archivedFile = names.includes(ARCHIVED_FILE)
    ? await smallFile(path.join(folder, ARCHIVED_FILE), ARCHIVED_BYTES)
    : null
  const archived = archivedFile === null ? null : parseArchivedIndex(archivedFile)
  const files = names
    .flatMap((name) => {
      const uuid = INDEX_FILE.exec(name)?.[1]?.toLowerCase()
      return uuid && !deleted.has(uuid) ? [{ name, uuid }] : []
    })
    .slice(0, room)
  const sessions: DesktopSession[] = []
  let unreadable = 0
  await eachLimited(files, READS, async ({ name, uuid }) => {
    const content = await smallFile(path.join(folder, name), INDEX_BYTES)
    let session: DesktopSession | null = null
    if (content !== null) {
      try {
        session = parseDesktopSession(JSON.parse(content), uuid)
      } catch {
        session = null
      }
    }
    if (!session) {
      unreadable++
      return
    }
    if (archived?.has(session.id)) session.archived = true
    sessions.push(session)
  })
  return { sessions, unreadable }
}

/** Every session the index of each data folder lists, deleted ones left out. */
export async function readDesktopIndex(folders: readonly string[]): Promise<DesktopIndex> {
  const sessions: DesktopSession[] = []
  const read: string[] = []
  let unreadable = 0
  for (const folder of folders) {
    const root = path.join(folder, DESKTOP_SESSIONS_FOLDER)
    if (!(await isDirectory(root))) continue
    read.push(folder)
    for (const account of await entries(root)) {
      if (!account.isDirectory()) continue
      for (const organization of await entries(path.join(root, account.name))) {
        if (!organization.isDirectory()) continue
        const room = DESKTOP_SESSIONS - sessions.length
        if (room <= 0) break
        const found = await readOrganization(path.join(root, account.name, organization.name), room)
        sessions.push(...found.sessions)
        unreadable += found.unreadable
      }
    }
  }
  return { sessions, folders: read, unreadable }
}

/**
 * The folders the app may keep its data in, newest layout first, each either a data folder or one
 * whose folders are (`children`): the Microsoft Store app moves its data out of its package into
 * `%LOCALAPPDATA%\Claude-Data\<package family>`, which an older one kept virtualized under its
 * package as `%APPDATA%\Claude`; the installer's app keeps `%APPDATA%\Claude`; builds for other
 * providers add `-3p`.
 */
export async function desktopCandidates(options: {
  platform: Platform
  env: Record<string, string | undefined>
  home: string
}): Promise<{ folder: string; children: boolean }[]> {
  const { platform, env, home } = options
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const packages = path.join(local, 'Packages')
    const family = /^(?:[\w-]+\.)?Claude[\w-]*_\w+$/i
    const packaged = (await entries(packages))
      .filter((entry) => entry.isDirectory() && family.test(entry.name))
      .flatMap((entry) =>
        ['Claude', 'Claude-3p'].map((name) => ({
          folder: path.join(packages, entry.name, 'LocalCache', 'Roaming', name),
          children: false,
        })),
      )
    return [
      { folder: path.join(local, 'Claude-Data'), children: true },
      { folder: path.join(local, 'Claude-3p'), children: true },
      { folder: path.join(local, 'Claude-3p'), children: false },
      { folder: path.join(roaming, 'Claude'), children: false },
      { folder: path.join(roaming, 'Claude-3p'), children: false },
      ...packaged,
    ]
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    return ['Claude', 'Claude-3p', 'Claude Nest', 'Claude Nest-3p'].map((name) => ({
      folder: path.join(support, name),
      children: false,
    }))
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return ['Claude', 'Claude-3p'].map((name) => ({
    folder: path.join(config, name),
    children: false,
  }))
}

/**
 * The app's data folders on this computer that hold its index of Code sessions, or those
 * `KITE_CLAUDE_DESKTOP_DATA` names instead, each once.
 */
export async function claudeDesktopFolders(options: {
  platform: Platform
  env: Record<string, string | undefined>
  home: string
}): Promise<string[]> {
  const { platform, env } = options
  const named = env[DESKTOP_DATA_VARIABLE]
  let folders: string[]
  if (named !== undefined && named.trim() !== '') {
    folders = named
      .split(platform === 'win32' ? ';' : ':')
      .map((item) => item.trim())
      .filter((item) => item !== '' && path.isAbsolute(item))
  } else {
    folders = []
    for (const candidate of await desktopCandidates(options)) {
      if (!candidate.children) folders.push(candidate.folder)
      else {
        for (const entry of await entries(candidate.folder)) {
          if (entry.isDirectory()) folders.push(path.join(candidate.folder, entry.name))
        }
      }
    }
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const folder of folders) {
    if (!(await isDirectory(path.join(folder, DESKTOP_SESSIONS_FOLDER)))) continue
    const key = pathKey(await realpath(folder).catch(() => folder), platform)
    if (seen.has(key)) continue
    seen.add(key)
    found.push(folder)
  }
  return found
}

/** Where a desktop session's conversation is for Claude Code to resume it. */
export interface DesktopTranscript {
  /** The Claude Code session to import: of the ones it ran, the one written last. */
  acpSessionId: string
  /** The folder it resumes in, whose project folder holds that transcript. */
  folder: string
  /** False when no transcript of it is under `projects`: it cannot be imported. */
  found: boolean
}

/**
 * Finds a session's transcript under Claude Code's `projects` folder, in the project folder of the
 * folder it runs in. One in a scratch folder may have moved on to the project it started in, which
 * is looked in next. Null for a session that never ran Claude Code.
 */
export async function locateTranscript(
  session: DesktopSession,
  projects: string,
): Promise<DesktopTranscript | null> {
  const ids = [session.cliSessionId, session.lastAssistantCliSessionId].filter(
    (id, index, all): id is string => id !== null && all.indexOf(id) === index,
  )
  if (ids.length === 0) return null
  const folders = [
    session.cwd,
    ...(session.scratch ? session.origins.filter((folder) => !isDesktopScratch(folder)) : []),
  ]
  for (const folder of folders) {
    const real = await realpath(folder).catch(() => folder)
    const names = [...new Set([real, folder].map((f) => claudeProjectFolder(f.normalize('NFC'))))]
    let best: { id: string; mtimeMs: number } | null = null
    for (const id of ids) {
      for (const name of names) {
        const info = await stat(path.join(projects, name, `${id}.jsonl`)).catch(() => null)
        if (!info?.isFile()) continue
        if (!best || info.mtimeMs > best.mtimeMs) best = { id, mtimeMs: info.mtimeMs }
      }
    }
    if (best) return { acpSessionId: best.id, folder, found: true }
  }
  return { acpSessionId: ids[0]!, folder: session.cwd, found: false }
}

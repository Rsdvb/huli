// Huli: the recycle bin (回收站). Deleting a session, a session folder, a project, a task, a
// routine, a workflow or a memory entry marks it deleted (`deletedAt`) where it is stored instead of
// removing it, so every list and lookup leaves it out while a restore puts it back as it was. The
// agent host deletes it for good once the settings' days have passed, or when the user asks.
// Artifacts keep their own 最近删除, which the bin lists as one more kind.

import type { AgentId } from './thread'

export const BIN_KINDS = [
  'session',
  'folder',
  'project',
  'task',
  'routine',
  'workflow',
  'memory',
  'artifact',
] as const
export type BinKind = (typeof BIN_KINDS)[number]

export function isBinKind(value: unknown): value is BinKind {
  return (BIN_KINDS as readonly unknown[]).includes(value)
}

/** How many days Settings › General may keep what is in the bin; null never empties it. */
export const BIN_KEEP_DAYS = [7, 30, 90] as const
export type BinKeepDays = (typeof BIN_KEEP_DAYS)[number]

export interface RecycleBinSettings {
  /** Days an item stays before the host deletes it for good; null keeps it until the user does. */
  keepDays: BinKeepDays | null
}

export const DEFAULT_RECYCLE_BIN: RecycleBinSettings = { keepDays: 30 }

export function isBinKeepDays(value: unknown): value is BinKeepDays | null {
  return value === null || (BIN_KEEP_DAYS as readonly unknown[]).includes(value)
}

export const BIN_DAY_MS = 24 * 60 * 60_000

/**
 * Whether a host moves what is deleted to the recycle bin, as its `HostInfo` says: true or false
 * once it has said, null while its info is unknown. A host older than the bin says nothing of it
 * and deletes for good, so nothing may promise a restore from there.
 */
export function binSupported(info: { recycleBin?: unknown } | null | undefined): boolean | null {
  if (info === null || info === undefined) return null
  return info.recycleBin === true
}

/** When an item deleted at `deletedAt` is deleted for good; null while the bin keeps it. */
export function purgeAt(deletedAt: number, settings: RecycleBinSettings): number | null {
  return settings.keepDays === null ? null : deletedAt + settings.keepDays * BIN_DAY_MS
}

/**
 * An item's key in the bin: its kind and its own id, `session:<id>`, `project:<folder>`,
 * `memory:<scope>:<id>`. A client knows it from what it deleted, so Undo needs no answer.
 */
export function binKey(kind: BinKind, id: string): string {
  return `${kind}:${id}`
}

/** The kind and id of a key, or null for one that names no kind. */
export function parseBinKey(key: string): { kind: BinKind; id: string } | null {
  const at = key.indexOf(':')
  if (at <= 0) return null
  const kind = key.slice(0, at)
  const id = key.slice(at + 1)
  return isBinKind(kind) && id !== '' ? { kind, id } : null
}

/** The most keys one request names; a page selects at most what it lists. */
export const MAX_BIN_KEYS = 2_000
/** The longest key: a kind and an id, a project's folder at most. */
export const BIN_KEY_CHARS = 4_200

/** A session's project as its restore finds it: in the projects, in the bin, or gone. */
export type BinProjectState = 'listed' | 'binned' | 'gone' | 'none'

/** One thing in the bin, as the page lists it. */
export interface BinItem {
  key: string
  kind: BinKind
  id: string
  /** Its name as the user saw it; null for one that had none (an untitled session). */
  title: string | null
  deletedAt: number
  /** When the host deletes it for good by itself; null while the settings keep it. */
  purgeAt: number | null
  /** Bytes it holds on disk, when known: a session's stored thread, a workflow's files. */
  size: number | null
  /** A session's, a task's or a project's folder; a routine's project. */
  projectPath?: string | null
  /** A session's agent. */
  agentId?: AgentId
  /** What it took along: a session's sub-sessions, a project's or a folder's sessions. */
  count?: number
  /** A session's project now: in the bin or gone asks the user before a restore. */
  project?: BinProjectState
  /** A memory entry's scope: the user's own, or a project's. */
  scope?: string
}

export interface BinList {
  items: BinItem[]
  keepDays: BinKeepDays | null
}

/**
 * What a restore does with a session whose project is in the bin or gone: `restore` brings the
 * project back too (adds its folder again when gone), `noProject` lists the session under No
 * project, in the folder it had. Absent: such a session is left in the bin and named in `held`.
 */
export type BinProjectChoice = 'restore' | 'noProject'

export interface BinRestoreResult {
  restored: string[]
  /** Sessions left in the bin because their project is in the bin or gone, and no choice came. */
  held: { key: string; projectPath: string; project: BinProjectState }[]
}

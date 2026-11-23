// Huli: the user's folders of sessions, kept in `state/session-folders.json` and told to every
// port when they change. A session is in one folder at most (clients move top-level ones);
// sessions that went away are dropped from it as it is read. Huli's own; see tools/huli/README.md.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HostMethod } from '@shared/agent-host'
import {
  FOLDER_MOVE_SESSIONS,
  FOLDER_NAME_CHARS,
  MAX_FOLDERS,
  type SessionFolder,
} from '@shared/session-folders'
import { HostError, invalidParams, notFound } from './errors'
import type { Validators } from './rpc'
import { JsonFile, type LogFn } from './storage'

export interface SessionFoldersFile {
  version: 1
  folders: SessionFolder[]
}

export const SESSION_FOLDERS_VERSION = 1

const ID_CHARS = 256

function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function folderRecord(item: unknown): SessionFolder | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > ID_CHARS) return null
  if (typeof o.name !== 'string') return null
  const name = cleanName(o.name).slice(0, FOLDER_NAME_CHARS)
  if (!name) return null
  const ids = Array.isArray(o.sessionIds)
    ? o.sessionIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= ID_CHARS,
      )
    : []
  return {
    id: o.id,
    name,
    pinned: o.pinned === true,
    collapsed: o.collapsed === true,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
    sessionIds: [...new Set(ids)],
    ...(o.manual === true ? { manual: true } : {}),
  }
}

/** Reads the file's folders, leaving out a malformed one and a session a folder before holds. */
export function parseSessionFoldersFile(
  data: Record<string, unknown>,
): SessionFoldersFile | string {
  if (!Array.isArray(data.folders)) return 'folders is not a list'
  const seenFolders = new Set<string>()
  const seenSessions = new Set<string>()
  const folders: SessionFolder[] = []
  for (const item of data.folders) {
    const folder = folderRecord(item)
    if (!folder || seenFolders.has(folder.id)) continue
    seenFolders.add(folder.id)
    folder.sessionIds = folder.sessionIds.filter((id) => {
      if (seenSessions.has(id)) return false
      seenSessions.add(id)
      return true
    })
    folders.push(folder)
  }
  return { version: 1, folders }
}

export function sessionFoldersFile(userDataPath: string, log: LogFn): JsonFile<SessionFoldersFile> {
  return new JsonFile<SessionFoldersFile>({
    file: path.join(userDataPath, 'state', 'session-folders.json'),
    version: SESSION_FOLDERS_VERSION,
    migrations: {},
    parse: parseSessionFoldersFile,
    empty: () => ({ version: 1, folders: [] }),
    log,
    debounceMs: 200,
  })
}

export interface SessionFoldersDeps {
  file: JsonFile<SessionFoldersFile>
  /** Whether a session by this id is on the host. */
  isSession(sessionId: string): boolean
  changed(folders: SessionFolder[]): void
  now?: () => number
  newId?: () => string
}

export class SessionFolders {
  private folders: SessionFolder[] = []

  constructor(private readonly deps: SessionFoldersDeps) {}

  async load(): Promise<void> {
    this.folders = (await this.deps.file.load()).folders
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  /**
   * Every folder in the user's order, holding only the sessions still on the host; `manual` is
   * always there, so a client tells this host from one that cannot keep a folder's order.
   */
  list(): SessionFolder[] {
    return this.folders.map((folder) => ({
      ...folder,
      sessionIds: folder.sessionIds.filter((id) => this.deps.isSession(id)),
      manual: folder.manual === true,
    }))
  }

  create(name: string, sessionIds: readonly string[] = []): SessionFolder {
    if (this.folders.length >= MAX_FOLDERS) {
      throw new HostError('conflict', `There are ${MAX_FOLDERS} folders already`)
    }
    const folder: SessionFolder = {
      id: (this.deps.newId ?? randomUUID)(),
      name: checkedName(name),
      pinned: false,
      collapsed: false,
      createdAt: (this.deps.now ?? Date.now)(),
      sessionIds: [],
    }
    this.folders.push(folder)
    this.place(sessionIds, folder)
    this.commit()
    return { ...folder, sessionIds: [...folder.sessionIds], manual: false }
  }

  rename(folderId: string, name: string): void {
    const folder = this.find(folderId)
    const next = checkedName(name)
    if (folder.name === next) return
    folder.name = next
    this.commit()
  }

  update(folderId: string, change: { pinned?: boolean; collapsed?: boolean }): void {
    const folder = this.find(folderId)
    let changed = false
    if (change.pinned !== undefined && folder.pinned !== change.pinned) {
      folder.pinned = change.pinned
      changed = true
    }
    if (change.collapsed !== undefined && folder.collapsed !== change.collapsed) {
      folder.collapsed = change.collapsed
      changed = true
    }
    if (changed) this.commit()
  }

  /** Removes the folder; its sessions are not touched, only ungrouped. */
  delete(folderId: string): void {
    this.find(folderId)
    this.folders = this.folders.filter((folder) => folder.id !== folderId)
    this.commit()
  }

  reorder(folderIds: readonly string[]): void {
    const byId = new Map(this.folders.map((folder) => [folder.id, folder]))
    const first: SessionFolder[] = []
    for (const id of folderIds) {
      const folder = byId.get(id)
      if (!folder) continue
      byId.delete(id)
      first.push(folder)
    }
    const next = [...first, ...this.folders.filter((folder) => byId.has(folder.id))]
    if (next.every((folder, index) => folder === this.folders[index])) return
    this.folders = next
    this.commit()
  }

  /** Into the folder, first in it, or out of every folder with null. */
  move(sessionIds: readonly string[], folderId: string | null): void {
    const folder = folderId === null ? null : this.find(folderId)
    this.place(sessionIds, folder)
    this.commit()
  }

  /**
   * The folder's sessions in the order named, kept as the user's from now on; ones it holds that
   * are not named stay first, as sessions moved in later are, and named ones it does not hold are
   * skipped. Null goes back to latest activity and keeps the order the folder has.
   */
  order(folderId: string, sessionIds: readonly string[] | null): void {
    const folder = this.find(folderId)
    if (sessionIds === null) {
      if (!folder.manual) return
      delete folder.manual
      this.commit()
      return
    }
    const held = new Set(folder.sessionIds)
    const named = sessionIds.filter((id) => held.has(id))
    const naming = new Set(named)
    const next = [...folder.sessionIds.filter((id) => !naming.has(id)), ...named]
    if (folder.manual && next.every((id, index) => id === folder.sessionIds[index])) return
    folder.sessionIds = next
    folder.manual = true
    this.commit()
  }

  private place(sessionIds: readonly string[], folder: SessionFolder | null): void {
    const moving = new Set(sessionIds.filter((id) => this.deps.isSession(id)))
    if (moving.size === 0) return
    for (const other of this.folders) {
      other.sessionIds = other.sessionIds.filter((id) => !moving.has(id) && this.deps.isSession(id))
    }
    if (folder) folder.sessionIds = [...moving, ...folder.sessionIds]
  }

  private find(folderId: string): SessionFolder {
    const folder = this.folders.find((f) => f.id === folderId)
    if (!folder) throw notFound(`No folder ${folderId}`)
    return folder
  }

  private commit(): void {
    this.deps.file.save({ version: 1, folders: this.folders })
    this.deps.changed(this.list())
  }
}

type FolderMethod = Extract<HostMethod, `folders.${string}`>

function record(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams('params must be an object')
  }
  return params as Record<string, unknown>
}

function id(o: Record<string, unknown>, key: string): string {
  const value = o[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_CHARS) {
    throw invalidParams(`${key} must be an id`)
  }
  return value
}

function ids(o: Record<string, unknown>, key: string, max: number): string[] {
  const value = o[key]
  if (!Array.isArray(value) || value.length > max) {
    throw invalidParams(`${key} must be an array of at most ${max} ids`)
  }
  return [
    ...new Set(
      value.map((item: unknown, index) => {
        const at = `${key}[${index}]`
        return id({ [at]: item }, at)
      }),
    ),
  ]
}

function checkedName(value: unknown): string {
  if (typeof value !== 'string') throw invalidParams('name must be a string')
  const name = cleanName(value)
  if (!name) throw invalidParams('name must not be empty')
  if (name.length > FOLDER_NAME_CHARS) {
    throw invalidParams(`name is longer than ${FOLDER_NAME_CHARS} characters`)
  }
  return name
}

function optionalFlag(o: Record<string, unknown>, key: string): boolean | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalidParams(`${key} must be a boolean`)
  return value
}

/** The guards of the folder methods, which `createValidators` takes in. */
export const folderValidators: Pick<Validators, FolderMethod> = {
  'folders.list': (params) => {
    if (params === undefined || params === null) return
    if (Object.keys(record(params)).length > 0) throw invalidParams('This method takes no params')
  },
  'folders.create': (params) => {
    const o = record(params)
    const name = checkedName(o.name)
    if (o.sessionIds === undefined) return { name }
    return { name, sessionIds: ids(o, 'sessionIds', FOLDER_MOVE_SESSIONS) }
  },
  'folders.rename': (params) => {
    const o = record(params)
    return { folderId: id(o, 'folderId'), name: checkedName(o.name) }
  },
  'folders.update': (params) => {
    const o = record(params)
    const pinned = optionalFlag(o, 'pinned')
    const collapsed = optionalFlag(o, 'collapsed')
    return {
      folderId: id(o, 'folderId'),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(collapsed !== undefined ? { collapsed } : {}),
    }
  },
  'folders.delete': (params) => ({ folderId: id(record(params), 'folderId') }),
  'folders.reorder': (params) => ({ folderIds: ids(record(params), 'folderIds', MAX_FOLDERS) }),
  'folders.move': (params) => {
    const o = record(params)
    return {
      sessionIds: ids(o, 'sessionIds', FOLDER_MOVE_SESSIONS),
      folderId: o.folderId === null ? null : id(o, 'folderId'),
    }
  },
  'folders.order': (params) => {
    const o = record(params)
    return {
      folderId: id(o, 'folderId'),
      sessionIds: o.sessionIds === null ? null : ids(o, 'sessionIds', FOLDER_MOVE_SESSIONS),
    }
  },
}

// Huli: the sessions deleted in Kite whose agent still keeps its own copy, kept in
// `state/deleted-sessions.json`, so that neither Import from agents nor the sidebar's Import
// sessions offers them again. Doubao CLI has no delete and keeps every conversation on its
// servers; an ACP agent without `session/delete` keeps its own; a removal of an agent's files can
// fail. Importing one by its id takes it back. Huli's own; see tools/huli/README.md.

import path from 'node:path'
import { isAgentId, type AgentId } from '@shared/thread'
import { JsonFile, type LogFn } from './storage'

export interface DeletedSession {
  agentId: AgentId
  acpSessionId: string
  /** When it was deleted, epoch ms. */
  at: number
}

export interface DeletedSessionsFile {
  version: 1
  sessions: DeletedSession[]
}

export const DELETED_SESSIONS_VERSION = 1

/** The most kept; the oldest go first. */
export const MAX_DELETED_SESSIONS = 10_000
const ID_CHARS = 512

function entryOf(item: unknown): DeletedSession | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  if (typeof o.agentId !== 'string' || !isAgentId(o.agentId)) return null
  if (typeof o.acpSessionId !== 'string' || o.acpSessionId === '') return null
  if (o.acpSessionId.length > ID_CHARS) return null
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  return { agentId: o.agentId, acpSessionId: o.acpSessionId, at }
}

/** Reads the file's sessions, leaving out a malformed entry and a repeated one. */
export function parseDeletedSessionsFile(
  data: Record<string, unknown>,
): DeletedSessionsFile | string {
  if (!Array.isArray(data.sessions)) return 'sessions is not a list'
  const seen = new Set<string>()
  const sessions: DeletedSession[] = []
  for (const item of data.sessions) {
    const entry = entryOf(item)
    if (!entry) continue
    const key = keyOf(entry.agentId, entry.acpSessionId)
    if (seen.has(key)) continue
    seen.add(key)
    sessions.push(entry)
  }
  return { version: 1, sessions: sessions.slice(-MAX_DELETED_SESSIONS) }
}

export function deletedSessionsFile(
  userDataPath: string,
  log: LogFn,
): JsonFile<DeletedSessionsFile> {
  return new JsonFile<DeletedSessionsFile>({
    file: path.join(userDataPath, 'state', 'deleted-sessions.json'),
    version: DELETED_SESSIONS_VERSION,
    migrations: {},
    parse: parseDeletedSessionsFile,
    empty: () => ({ version: 1, sessions: [] }),
    log,
  })
}

function keyOf(agentId: AgentId, acpSessionId: string): string {
  return `${agentId}\n${acpSessionId}`
}

export class DeletedSessions {
  /** Oldest first, as the file keeps them. */
  private readonly byKey = new Map<string, DeletedSession>()

  constructor(
    private readonly file: JsonFile<DeletedSessionsFile>,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const data = await this.file.load()
    this.byKey.clear()
    for (const entry of data.sessions)
      this.byKey.set(keyOf(entry.agentId, entry.acpSessionId), entry)
  }

  has(agentId: AgentId, acpSessionId: string): boolean {
    return this.byKey.has(keyOf(agentId, acpSessionId))
  }

  /** The ids kept out for any of `agentIds`, for a listing to leave out in one pass. */
  idsOf(agentIds: readonly AgentId[]): Set<string> {
    const agents = new Set(agentIds)
    const ids = new Set<string>()
    for (const entry of this.byKey.values()) {
      if (agents.has(entry.agentId)) ids.add(entry.acpSessionId)
    }
    return ids
  }

  /** Keeps a deleted session from being offered again. */
  add(agentId: AgentId, acpSessionId: string): void {
    if (acpSessionId === '') return
    const key = keyOf(agentId, acpSessionId)
    this.byKey.delete(key)
    this.byKey.set(key, { agentId, acpSessionId, at: this.now() })
    while (this.byKey.size > MAX_DELETED_SESSIONS) {
      this.byKey.delete(this.byKey.keys().next().value!)
    }
    this.save()
  }

  /** Offers it again, as when it is imported by its id. */
  forget(agentId: AgentId, acpSessionId: string): void {
    if (this.byKey.delete(keyOf(agentId, acpSessionId))) this.save()
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private save(): void {
    this.file.save({ version: 1, sessions: [...this.byKey.values()] })
  }
}

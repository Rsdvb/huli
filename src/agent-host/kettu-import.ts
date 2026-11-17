// Huli: the sessions of an official Kettu on the same computer, brought over. Kettu's index is
// copied out of its data folder and read from the copy, so nothing of Kettu's is ever opened for
// writing, locked or changed; each session is then imported as the sidebar's Import sessions does,
// through its agent's own session, which Huli resumes. Huli's own; see tools/huli/README.md.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type {
  KettuImportFailure,
  KettuImportResult,
  KettuImportScan,
  KettuProject,
  KettuSession,
  KettuSkipReason,
} from '@shared/kettu-import'
import type { Platform } from '@shared/platform'
import { HostError } from './errors'
import { currentLocale } from './i18n'
import { folderName, isInside, pathKey } from './paths'
import type { KeptField } from './sessions'
import {
  JsonFile,
  migrate,
  parseProjectsFile,
  parseSessionsFile,
  PROJECTS_MIGRATIONS,
  PROJECTS_VERSION,
  SESSIONS_MIGRATIONS,
  SESSIONS_VERSION,
  type LogFn,
  type ProjectRecord,
  type SessionRecord,
} from './storage'

/** The name of Kettu's data folder, as Electron names it after the product. */
export const KETTU_APP_NAME = 'Kettu'

/**
 * Where an installed Kettu keeps its data: `%APPDATA%\Kettu` on Windows, `~/Library/Application
 * Support/Kettu` on macOS, `$XDG_CONFIG_HOME/Kettu` (`~/.config/Kettu`) on Linux.
 * `HULI_KETTU_DATA` points elsewhere, such as at a copy to try an import on.
 */
export function kettuDataFolder(
  platform: Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.HULI_KETTU_DATA
  if (override) return override
  if (platform === 'win32') {
    return path.win32.join(
      env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'),
      KETTU_APP_NAME,
    )
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', KETTU_APP_NAME)
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), KETTU_APP_NAME)
}

/** Which of Kettu's sessions were imported as which of this app's. */
export interface KettuImportFile {
  version: 1
  imported: { kettuId: string; sessionId: string }[]
}

export const KETTU_IMPORT_VERSION = 1

export function parseKettuImportFile(data: Record<string, unknown>): KettuImportFile | string {
  if (!Array.isArray(data.imported)) return 'imported is not a list'
  const imported = data.imported.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const { kettuId, sessionId } = item as Record<string, unknown>
    return typeof kettuId === 'string' && typeof sessionId === 'string'
      ? [{ kettuId, sessionId }]
      : []
  })
  return { version: 1, imported }
}

export function kettuImportFile(userDataPath: string, log: LogFn): JsonFile<KettuImportFile> {
  return new JsonFile<KettuImportFile>({
    file: path.join(userDataPath, 'state', 'kettu-import.json'),
    version: KETTU_IMPORT_VERSION,
    migrations: {},
    parse: parseKettuImportFile,
    empty: () => ({ version: 1, imported: [] }),
    log,
    debounceMs: 0,
  })
}

/** What the import asks of this app's sessions. */
export interface ImportSessions {
  list(): SessionSummary[]
  importSession(
    params: { agentId: AgentId; projectPath: string; acpSessionId: string; fork?: boolean },
    kept: Partial<Pick<SessionRecord, KeptField>>,
  ): Promise<SessionSummary>
}

/** What the import asks of this app's projects. */
export interface ImportProjects {
  find(value: string): ProjectRecord | undefined
  add(value: string): Promise<unknown>
}

export interface KettuImportDeps {
  /** Kettu's data folder, which is only ever read. */
  source: string
  /** This app's own data folder: when it is the source, as in a build named Kettu, nothing is found. */
  ownData: string
  platform: Platform
  ledger: JsonFile<KettuImportFile>
  sessions: ImportSessions
  projects: ImportProjects
  /** Whether an agent of this id is set up here. */
  hasAgent(agentId: AgentId): boolean
  /** Where the copies of Kettu's index are read from; the system's temporary folder by default. */
  tempDir?: string
  isDirectory?(folder: string): Promise<boolean>
  progress(done: number, total: number, title: string | null): void
  log: LogFn
}

/** Kettu's index as read from a copy. */
interface KettuIndex {
  sessions: SessionRecord[]
  projects: ProjectRecord[]
}

type ReadIndex =
  { kind: 'missing' } | { kind: 'newer' | 'unreadable' } | { kind: 'ok'; index: KettuIndex }

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory()
  } catch {
    return false
  }
}

const MESSAGES = {
  en: {
    busy: 'An import from Kettu is already running.',
    notFound: 'Kettu no longer has this session.',
    unreadable: "Kettu's sessions could not be read.",
  },
  'zh-CN': {
    busy: '已经在从 Kettu 导入了。',
    notFound: 'Kettu 里已经没有这个会话了。',
    unreadable: '读不了 Kettu 的会话。',
  },
} as const

function message(key: keyof (typeof MESSAGES)['en']): string {
  return (currentLocale() === 'zh-CN' ? MESSAGES['zh-CN'] : MESSAGES.en)[key]
}

export class KettuImport {
  private ledger: KettuImportFile | null = null
  private running = false
  private readonly isDirectory: (folder: string) => Promise<boolean>

  constructor(private readonly deps: KettuImportDeps) {
    this.isDirectory = deps.isDirectory ?? isDirectory
  }

  private async imported(): Promise<KettuImportFile> {
    this.ledger ??= await this.deps.ledger.load()
    return this.ledger
  }

  /** Kettu's index, read from copies of its files in a folder of the import's own. */
  private async readIndex(): Promise<ReadIndex> {
    const { source, ownData, platform } = this.deps
    if (pathKey(path.resolve(source), platform) === pathKey(path.resolve(ownData), platform)) {
      return { kind: 'missing' }
    }
    const temp = await mkdtemp(path.join(this.deps.tempDir ?? os.tmpdir(), 'huli-kettu-'))
    try {
      const sessions = await copyAndRead(source, 'sessions.json', temp)
      if (sessions === null) return { kind: 'missing' }
      const projects = await copyAndRead(source, 'projects.json', temp)
      const sessionsFile = parseIndexFile(
        sessions,
        SESSIONS_VERSION,
        SESSIONS_MIGRATIONS,
        parseSessionsFile,
      )
      if (typeof sessionsFile === 'string') return { kind: sessionsFile }
      const projectsFile =
        projects === null
          ? { projects: [] }
          : parseIndexFile(projects, PROJECTS_VERSION, PROJECTS_MIGRATIONS, parseProjectsFile)
      if (typeof projectsFile === 'string') return { kind: projectsFile }
      return {
        kind: 'ok',
        index: { sessions: sessionsFile.sessions, projects: projectsFile.projects },
      }
    } catch (error) {
      this.deps.log('warn', `Could not read Kettu's sessions: ${(error as Error).message}`)
      return { kind: 'unreadable' }
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }

  async scan(): Promise<KettuImportScan> {
    const read = await this.readIndex()
    const empty: KettuImportScan = {
      found: false,
      path: this.deps.source,
      error: null,
      projects: [],
      sessions: [],
      counts: { sessions: 0, subagents: 0, importable: 0, imported: 0 },
    }
    if (read.kind === 'missing') return empty
    if (read.kind !== 'ok') return { ...empty, found: true, error: read.kind }
    const sessions = await this.describe(read.index)
    const top = sessions.filter((session) => session.origin !== 'subagent')
    return {
      found: true,
      path: this.deps.source,
      error: null,
      projects: this.projectsOf(read.index, top),
      sessions,
      counts: {
        sessions: top.length,
        subagents: sessions.length - top.length,
        importable: top.filter((session) => !session.imported && session.skip === null).length,
        imported: top.filter((session) => session.imported).length,
      },
    }
  }

  async run(sessionIds: readonly string[]): Promise<KettuImportResult> {
    if (this.running) throw new HostError('busy', message('busy'))
    this.running = true
    try {
      return await this.runNow(sessionIds)
    } finally {
      this.running = false
    }
  }

  private async runNow(sessionIds: readonly string[]): Promise<KettuImportResult> {
    const read = await this.readIndex()
    if (read.kind !== 'ok') {
      throw new HostError(
        read.kind === 'missing' ? 'not_found' : 'unavailable',
        message('unreadable'),
      )
    }
    const described = new Map((await this.describe(read.index)).map((s) => [s.id, s]))
    const result: KettuImportResult = { imported: 0, forked: 0, skipped: 0, failed: [] }
    const wanted: KettuSession[] = []
    for (const id of new Set(sessionIds)) {
      const session = described.get(id)
      if (!session) {
        result.failed.push({ sessionId: id, title: null, message: message('notFound') })
      } else if (session.imported || session.skip !== null) {
        result.skipped++
      } else {
        wanted.push(session)
      }
    }
    // The oldest first, as they were made.
    wanted.sort((a, b) => a.createdAt - b.createdAt)
    const records = new Map(read.index.sessions.map((record) => [record.id, record]))
    const ledger = await this.imported()
    const added = new Set<string>()
    for (const [index, session] of wanted.entries()) {
      this.deps.progress(index, wanted.length, session.title)
      const record = records.get(session.id)!
      try {
        const key = pathKey(record.projectPath, this.deps.platform)
        if (!added.has(key)) {
          await this.deps.projects.add(record.projectPath)
          added.add(key)
        }
        const { summary, forked } = await this.importOne(record)
        ledger.imported.push({ kettuId: record.id, sessionId: summary.id })
        this.deps.ledger.save({ version: 1, imported: [...ledger.imported] })
        result.imported++
        if (forked) result.forked++
      } catch (error) {
        result.failed.push(failure(session, error))
      }
    }
    this.deps.progress(wanted.length, wanted.length, null)
    await this.deps.ledger.flush()
    this.deps.log(
      'info',
      `Imported ${result.imported} of Kettu's sessions (${result.forked} as copies), skipped ${result.skipped}, ${result.failed.length} failed`,
    )
    return result
  }

  /**
   * One session, through the agent's own session; one that another program has open, such as
   * Kettu itself, as a copy of it, since two programs writing one transcript tangle it.
   */
  private async importOne(
    record: SessionRecord,
  ): Promise<{ summary: SessionSummary; forked: boolean }> {
    const params = {
      agentId: record.agentId,
      projectPath: record.projectPath,
      acpSessionId: record.acpSessionId,
    }
    const kept = keptOf(record)
    try {
      return { summary: await this.deps.sessions.importSession(params, kept), forked: false }
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== 'busy') throw error
    }
    return {
      summary: await this.deps.sessions.importSession({ ...params, fork: true }, kept),
      forked: true,
    }
  }

  /** Each session of the index as the scan shows it: whether it is here already, or why not. */
  private async describe(index: KettuIndex): Promise<KettuSession[]> {
    const { platform, source } = this.deps
    const ledger = await this.imported()
    const here = this.deps.sessions.list()
    const ids = new Set(here.map((summary) => summary.id))
    const byAcp = new Set(
      here.flatMap((summary) =>
        summary.acpSessionId ? [`${summary.agentId}\n${summary.acpSessionId}`] : [],
      ),
    )
    // An imported session counts while its session here is kept, archived or not.
    const taken = new Set(
      ledger.imported.filter((item) => ids.has(item.sessionId)).map((item) => item.kettuId),
    )
    const children = new Map<string, number>()
    for (const record of index.sessions) {
      if (record.origin === 'subagent' && record.parentId !== null) {
        children.set(record.parentId, (children.get(record.parentId) ?? 0) + 1)
      }
    }
    const folders = new Map<string, Promise<boolean>>()
    const exists = (folder: string): Promise<boolean> => {
      const key = pathKey(folder, platform)
      let found = folders.get(key)
      if (!found) {
        found = this.isDirectory(folder)
        folders.set(key, found)
      }
      return found
    }
    const sessions = await Promise.all(
      index.sessions.map(async (record): Promise<KettuSession> => {
        const subagent = record.origin === 'subagent'
        const imported =
          !subagent &&
          (taken.has(record.id) ||
            (record.acpSessionId !== '' && byAcp.has(`${record.agentId}\n${record.acpSessionId}`)))
        let skip: KettuSkipReason | null = null
        if (subagent) skip = 'subagent'
        else if (record.acpSessionId === '') skip = 'noAgentSession'
        else if (record.worktree) skip = 'worktree'
        else if (isInside(record.projectPath, source, platform)) skip = 'scratch'
        else if (!this.deps.hasAgent(record.agentId)) skip = 'unknownAgent'
        else if (!imported && !(await exists(record.projectPath))) skip = 'missingFolder'
        return {
          id: record.id,
          title: record.customTitle ?? record.title,
          agentId: record.agentId,
          acpSessionId: record.acpSessionId,
          projectPath: record.projectPath,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          pinned: record.pinnedAt !== undefined,
          archived: record.archivedAt !== undefined,
          origin: record.origin,
          parentId: record.parentId,
          subagents: children.get(record.id) ?? 0,
          imported,
          skip: imported ? null : skip,
        }
      }),
    )
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Kettu's projects and those its sessions name, with how many top-level sessions each has. */
  private projectsOf(index: KettuIndex, top: readonly KettuSession[]): KettuProject[] {
    const { platform } = this.deps
    const projects = new Map<string, KettuProject>()
    const note = (folder: string, name: string): KettuProject => {
      const key = pathKey(folder, platform)
      let project = projects.get(key)
      if (!project) {
        project = {
          path: folder,
          name,
          sessions: 0,
          added: this.deps.projects.find(folder) !== undefined,
        }
        projects.set(key, project)
      }
      return project
    }
    for (const record of index.projects) note(record.path, record.name)
    for (const session of top) {
      note(session.projectPath, folderName(session.projectPath, platform)).sessions++
    }
    return [...projects.values()]
  }
}

/** A copy of one of Kettu's state files in `temp`, read back; null when Kettu has none. */
async function copyAndRead(source: string, name: string, temp: string): Promise<string | null> {
  let text: string
  try {
    // Read through Node's own open, which shares the file with Kettu's writes and renames.
    text = await readFile(path.join(source, 'state', name), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const copy = path.join(temp, name)
  await writeFile(copy, text, 'utf8')
  return readFile(copy, 'utf8')
}

function parseIndexFile<T>(
  text: string,
  version: number,
  migrations: Parameters<typeof migrate>[2],
  parse: (data: Record<string, unknown>) => T | string,
): T | 'newer' | 'unreadable' {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'unreadable'
  }
  const migrated = migrate(raw, version, migrations)
  if (migrated.kind === 'newer') return 'newer'
  if (migrated.kind === 'invalid') return 'unreadable'
  const parsed = parse(migrated.data)
  return typeof parsed === 'string' ? 'unreadable' : parsed
}

/** What Kettu kept of the session that the new record takes over. */
export function keptOf(record: SessionRecord): Partial<Pick<SessionRecord, KeptField>> {
  return {
    title: record.title,
    ...(record.titleSource ? { titleSource: record.titleSource } : {}),
    ...(record.customTitle ? { customTitle: record.customTitle } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.pinnedAt !== undefined && record.archivedAt === undefined
      ? { pinnedAt: record.pinnedAt }
      : {}),
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
  }
}

function failure(session: KettuSession, error: unknown): KettuImportFailure {
  return {
    sessionId: session.id,
    title: session.title,
    message: error instanceof Error ? error.message : String(error),
  }
}

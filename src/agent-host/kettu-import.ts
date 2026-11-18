// Huli: the sessions of an official Kettu on the same computer, brought over, with its memory and
// artifacts. Kettu's index is copied out of its data folder and read from the copy, so nothing of
// Kettu's is ever opened for writing, locked or changed; each session is then imported as the
// sidebar's Import sessions does, through its agent's own session, which Huli resumes. Memory and
// artifacts come through kettu-import-memory.ts and kettu-import-artifacts.ts. Huli's own; see
// tools/huli/README.md.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type {
  KettuArtifactsError,
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
import {
  checkKettuArtifacts,
  copyKettuDatabase,
  countNewArtifacts,
  importKettuArtifacts,
  kettuDatabaseSignature,
  NoSpaceError,
  type ArtifactCaller,
  type ArtifactLedgerItem,
  type KettuArtifactsRead,
} from './kettu-import-artifacts'
import {
  countNewMemory,
  importKettuMemory,
  readKettuMemory,
  type KettuMemoryRead,
  type MemoryImportDeps,
  type MemoryLedgerItem,
} from './kettu-import-memory'
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

/** Which of Kettu's sessions, memory entries and artifacts were imported, as which of this app's. */
export interface KettuImportFile {
  version: 1
  imported: { kettuId: string; sessionId: string }[]
  memory: MemoryLedgerItem[]
  artifacts: ArtifactLedgerItem[]
}

export const KETTU_IMPORT_VERSION = 1

/** The items of a list whose two fields are strings; none when it is no list. */
function pairs<A extends string, B extends string>(
  value: unknown,
  a: A,
  b: B,
): ({ [K in A]: string } & { [K in B]: string })[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const fields = item as Record<string, unknown>
    const first = fields[a]
    const second = fields[b]
    return typeof first === 'string' && typeof second === 'string'
      ? [{ [a]: first, [b]: second } as { [K in A]: string } & { [K in B]: string }]
      : []
  })
}

export function parseKettuImportFile(data: Record<string, unknown>): KettuImportFile | string {
  if (!Array.isArray(data.imported)) return 'imported is not a list'
  return {
    version: 1,
    imported: pairs(data.imported, 'kettuId', 'sessionId'),
    // Added later: a file from before has neither.
    memory: pairs(data.memory, 'key', 'hash'),
    artifacts: pairs(data.artifacts, 'kettuId', 'artifactId'),
  }
}

export function kettuImportFile(userDataPath: string, log: LogFn): JsonFile<KettuImportFile> {
  return new JsonFile<KettuImportFile>({
    file: path.join(userDataPath, 'state', 'kettu-import.json'),
    version: KETTU_IMPORT_VERSION,
    migrations: {},
    parse: parseKettuImportFile,
    empty: () => ({ version: 1, imported: [], memory: [], artifacts: [] }),
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
  memory: MemoryImportDeps['memory']
  /** This app's thread database, which keeps the artifacts; null when it is not open. */
  threads: ArtifactCaller | null
  /** Artifacts came over, for the clients' lists. */
  artifactsChanged(): void
  /** Whether an agent of this id is set up here. */
  hasAgent(agentId: AgentId): boolean
  /** Where the copies of Kettu's index are read from; the system's temporary folder by default. */
  tempDir?: string
  isDirectory?(folder: string): Promise<boolean>
  progress(done: number, total: number, title: string | null): void
  log: LogFn
}

/** What a run brings beside the sessions. */
export interface KettuImportParts {
  memory: boolean
  artifacts: boolean
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
    memory: "Kettu's memory could not be read.",
  },
  'zh-CN': {
    busy: '已经在从 Kettu 导入了。',
    notFound: 'Kettu 里已经没有这个会话了。',
    unreadable: '读不了 Kettu 的会话。',
    memory: '读不了 Kettu 的记忆。',
  },
} as const

function message(key: keyof (typeof MESSAGES)['en']): string {
  return (currentLocale() === 'zh-CN' ? MESSAGES['zh-CN'] : MESSAGES.en)[key]
}

export class KettuImport {
  private ledger: KettuImportFile | null = null
  private running = false
  private readonly isDirectory: (folder: string) => Promise<boolean>
  /** The artifacts last read, while Kettu's database is as it was then. */
  private artifactsRead: { signature: string; read: KettuArtifactsRead } | null = null

  constructor(private readonly deps: KettuImportDeps) {
    this.isDirectory = deps.isDirectory ?? isDirectory
  }

  private async imported(): Promise<KettuImportFile> {
    this.ledger ??= await this.deps.ledger.load()
    return this.ledger
  }

  private saveLedger(ledger: KettuImportFile): void {
    this.deps.ledger.save({
      version: 1,
      imported: [...ledger.imported],
      memory: [...ledger.memory],
      artifacts: [...ledger.artifacts],
    })
  }

  /** The session here that Kettu's became; null when it was not imported or is gone. */
  private sessionOf(ledger: KettuImportFile): (kettuId: string) => string | null {
    const here = new Set(this.deps.sessions.list().map((summary) => summary.id))
    const map = new Map(ledger.imported.map((item) => [item.kettuId, item.sessionId]))
    return (kettuId) => {
      const id = map.get(kettuId)
      return id !== undefined && here.has(id) ? id : null
    }
  }

  /** Whether the source is this app's own folder, as in a build named Kettu. */
  private isOwn(): boolean {
    const { source, ownData, platform } = this.deps
    return pathKey(path.resolve(source), platform) === pathKey(path.resolve(ownData), platform)
  }

  private tempFolder(): Promise<string> {
    return mkdtemp(path.join(this.deps.tempDir ?? os.tmpdir(), 'huli-kettu-'))
  }

  /** Kettu's memory, from copies of its files. */
  private async readMemory(): Promise<KettuMemoryRead> {
    const temp = await this.tempFolder()
    try {
      return await readKettuMemory(this.deps.source, temp, this.deps.platform, this.deps.log)
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }

  private memoryDeps(ledger: KettuImportFile): MemoryImportDeps {
    return {
      memory: this.deps.memory,
      hasProject: (folder) => this.deps.projects.find(folder) !== undefined,
      addProject: (folder) => this.deps.projects.add(folder),
      isDirectory: this.isDirectory,
      sessionOf: this.sessionOf(ledger),
      ledger: ledger.memory,
      platform: this.deps.platform,
    }
  }

  /** Kettu's artifacts, from a copy of its database, read again only when that changed. */
  private async readArtifacts(): Promise<KettuArtifactsRead | KettuArtifactsError> {
    const { threads, source, platform } = this.deps
    if (!threads) return 'unavailable'
    const signature = await kettuDatabaseSignature(source)
    if (this.artifactsRead?.signature === signature) return this.artifactsRead.read
    const temp = await this.tempFolder()
    try {
      const copy = await copyKettuDatabase(source, temp)
      const read = copy
        ? await threads.artifact('readKettu', { file: copy })
        : { kind: 'ok' as const, artifacts: [], deleted: 0, malformed: 0 }
      if (read.kind === 'newer') return 'newer'
      const checked = checkKettuArtifacts(read, source, platform)
      this.artifactsRead = { signature, read: checked }
      return checked
    } catch (error) {
      if (error instanceof NoSpaceError) return 'noSpace'
      this.deps.log('warn', `Could not read Kettu's artifacts: ${(error as Error).message}`)
      return 'unreadable'
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async scanMemory(): Promise<KettuImportScan['memory']> {
    try {
      const read = await this.readMemory()
      const ledger = await this.imported()
      const importable = await countNewMemory(read, this.memoryDeps(ledger))
      return { found: read.entries.length, importable }
    } catch (error) {
      this.deps.log('warn', `Could not read Kettu's memory: ${(error as Error).message}`)
      return { found: 0, importable: 0 }
    }
  }

  private async scanArtifacts(): Promise<KettuImportScan['artifacts']> {
    const read = await this.readArtifacts()
    if (typeof read === 'string') return { found: 0, importable: 0, error: read }
    const ledger = await this.imported()
    const importable = await countNewArtifacts(read, this.deps.threads!, ledger.artifacts).catch(
      () => read.artifacts.length,
    )
    return { found: read.artifacts.length, importable, error: null }
  }

  /** Kettu's index, read from copies of its files in a folder of the import's own. */
  private async readIndex(): Promise<ReadIndex> {
    const { source } = this.deps
    if (this.isOwn()) return { kind: 'missing' }
    const temp = await this.tempFolder()
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
      memory: { found: 0, importable: 0 },
      artifacts: { found: 0, importable: 0, error: null },
    }
    if (read.kind === 'missing') return empty
    if (read.kind !== 'ok') return { ...empty, found: true, error: read.kind }
    const [sessions, memory, artifacts] = await Promise.all([
      this.describe(read.index),
      this.scanMemory(),
      this.scanArtifacts(),
    ])
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
      memory,
      artifacts,
    }
  }

  async run(
    sessionIds: readonly string[],
    parts: KettuImportParts = { memory: false, artifacts: false },
  ): Promise<KettuImportResult> {
    if (this.running) throw new HostError('busy', message('busy'))
    this.running = true
    try {
      return await this.runNow(sessionIds, parts)
    } finally {
      this.running = false
    }
  }

  private async runNow(
    sessionIds: readonly string[],
    parts: KettuImportParts,
  ): Promise<KettuImportResult> {
    const read = await this.readIndex()
    if (read.kind !== 'ok') {
      throw new HostError(
        read.kind === 'missing' ? 'not_found' : 'unavailable',
        message('unreadable'),
      )
    }
    const described = new Map((await this.describe(read.index)).map((s) => [s.id, s]))
    const result: KettuImportResult = {
      imported: 0,
      forked: 0,
      skipped: 0,
      failed: [],
      memory: null,
      memoryError: null,
      artifacts: null,
      artifactsError: null,
    }
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
        this.saveLedger(ledger)
        result.imported++
        if (forked) result.forked++
      } catch (error) {
        result.failed.push(failure(session, error))
      }
    }
    this.deps.progress(wanted.length, wanted.length, null)
    // After the sessions, so memory and artifacts name the sessions they became here.
    if (parts.memory) {
      try {
        const brought = await importKettuMemory(await this.readMemory(), this.memoryDeps(ledger))
        result.memory = brought.result
        ledger.memory.push(...brought.ledger)
        this.saveLedger(ledger)
      } catch (error) {
        this.deps.log('warn', `Could not import Kettu's memory: ${(error as Error).message}`)
        result.memoryError = message('memory')
      }
    }
    if (parts.artifacts) {
      const read = await this.readArtifacts()
      if (typeof read === 'string') result.artifactsError = read
      else {
        try {
          const brought = await importKettuArtifacts(read, {
            threads: this.deps.threads!,
            source: this.deps.source,
            sessionOf: this.sessionOf(ledger),
            ledger: ledger.artifacts,
            progress: (done, total, title) => this.deps.progress(done, total, title || null),
          })
          result.artifacts = brought.result
          ledger.artifacts.push(...brought.ledger)
          this.saveLedger(ledger)
          if (brought.result.imported > 0) this.deps.artifactsChanged()
        } catch (error) {
          this.deps.log('warn', `Could not import Kettu's artifacts: ${(error as Error).message}`)
          result.artifactsError = 'unreadable'
        }
      }
    }
    await this.deps.ledger.flush()
    this.deps.log(
      'info',
      `Imported ${result.imported} of Kettu's sessions (${result.forked} as copies), skipped ${result.skipped}, ${result.failed.length} failed` +
        (result.memory ? `; ${result.memory.imported} memory entries` : '') +
        (result.artifacts ? `; ${result.artifacts.imported} artifacts` : ''),
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

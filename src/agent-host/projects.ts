// Recent project folders, kept in state/projects.json.

import { realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_PROJECT_FOLDERS, type NoProject, type Project } from '@shared/agent-host'
import { DEFAULT_WORKTREE_SETTINGS, type ProjectWorktreeSettings } from '@shared/git'
import type { ProjectManagerSettings } from '@shared/manager'
import type { Platform } from '@shared/platform'
import type { AutoApprove } from '@shared/risk'
import { sameSandbox, type SandboxChoice } from '@shared/sandbox'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { canonicalizePath, folderName, isAbsolutePath, pathKey } from './paths'
import { folderProblem, type MountProblem } from './sandbox/mounts'
import type { JsonFile, ProjectRecord, ProjectsFile } from './storage'

export interface ProjectsDeps {
  file: JsonFile<ProjectsFile>
  platform: Platform
  now?: () => number
  realpath?: (value: string) => Promise<string>
  isDirectory?: (value: string) => Promise<boolean>
  /**
   * Huli: the home and data folders a further folder may be neither of, nor hold; without them
   * only the file system's roots are refused.
   */
  home?: string
  dataDir?: string
}

/**
 * Huli: what a further folder may not be, as a sandbox's mount may not: a further folder is a
 * place its agents may change and its edits count as the project's, so the computer's roots, the
 * home folder and what holds it, and Kite's own data are refused. Keys and system folders a mount
 * also refuses stay allowed, as a project's own folder may be one; a sandbox still keeps them out.
 */
const REFUSED_FOLDERS = [
  'notAbsolute',
  'devicePath',
  'root',
  'home',
  'aboveHome',
  'kiteData',
] as const
type RefusedFolder = (typeof REFUSED_FOLDERS)[number]

function refused(problem: MountProblem | null): problem is RefusedFolder {
  return (REFUSED_FOLDERS as readonly string[]).includes(problem ?? '')
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, index) => id === b[index])
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

export class Projects {
  private records: ProjectRecord[] = []
  /** Huli: removed projects in the recycle bin, stored with the others, kept out of every lookup. */
  private binned: ProjectRecord[] = []
  private noProjectPinnedAt: number | undefined
  private noProjectSessionOrder: string[] | undefined
  private newProjectParent: string | undefined
  private missing = new Map<string, boolean>()
  private listeners = new Set<(projects: Project[], noProject: NoProject) => void>()
  private readonly now: () => number
  private readonly realpath: (value: string) => Promise<string>
  private readonly isDirectory: (value: string) => Promise<boolean>

  constructor(private readonly deps: ProjectsDeps) {
    this.now = deps.now ?? Date.now
    this.realpath = deps.realpath ?? ((value) => fsRealpath(value))
    this.isDirectory = deps.isDirectory ?? isDirectory
  }

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    this.records = file.projects.filter((record) => record.deletedAt === undefined)
    this.binned = file.projects.filter((record) => record.deletedAt !== undefined)
    this.noProjectPinnedAt = file.noProjectPinnedAt
    this.noProjectSessionOrder = file.noProjectSessionOrder
    this.newProjectParent = file.newProjectParent
    await this.refreshMissing(false)
  }

  private key(value: string): string {
    return pathKey(value, this.deps.platform)
  }

  list(): Project[] {
    return this.ordered().map((record) => ({
      path: record.path,
      name: record.name,
      missing: this.missing.get(this.key(record.path)) ?? false,
      lastOpenedAt: record.lastOpenedAt,
      pinnedAt: record.pinnedAt ?? null,
      order: record.order ?? null,
      autoApprove: record.autoApprove ?? null,
      sandbox: record.sandbox ? { ...record.sandbox } : null,
      folders: (record.folders ?? []).map((folder) => ({
        path: folder,
        name: folderName(folder, this.deps.platform),
        missing: this.missing.get(this.key(folder)) ?? false,
      })),
      ...(record.manager ? { manager: record.manager } : {}),
      sessionOrder: record.sessionOrder ? [...record.sessionOrder] : null,
    }))
  }

  /** The user's order once they moved a project, the latest opened first until then. */
  private ordered(): ProjectRecord[] {
    if (!this.records.some((record) => record.order !== undefined)) {
      return [...this.records].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    }
    // A record without a place, such as one an older version added, goes after the others.
    return [...this.records].sort(
      (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.addedAt - b.addedAt,
    )
  }

  /** The No project group, which holds the sessions started without a project. */
  noProject(): NoProject {
    return {
      pinnedAt: this.noProjectPinnedAt ?? null,
      sessionOrder: this.noProjectSessionOrder ? [...this.noProjectSessionOrder] : null,
    }
  }

  paths(): string[] {
    return this.records.map((record) => record.path)
  }

  /** Huli: the projects' folders, the latest opened first. */
  recentPaths(): string[] {
    return [...this.records]
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map((record) => record.path)
  }

  /** Huli: the folder the user last cloned or made a new project in. */
  lastNewProjectParent(): string | undefined {
    return this.newProjectParent
  }

  setNewProjectParent(value: string): void {
    if (this.newProjectParent === value) return
    this.newProjectParent = value
    this.changed()
  }

  find(value: string): ProjectRecord | undefined {
    const key = this.key(value)
    return this.records.find((record) => this.key(record.path) === key)
  }

  /** Huli: the project's further folders as stored, missing ones included; none for no project. */
  folders(value: string): string[] {
    return [...(this.find(value)?.folders ?? [])]
  }

  /** Huli: the further folders that were there when last looked at, for its sessions' agents. */
  presentFolders(value: string): string[] {
    return this.folders(value).filter((folder) => this.missing.get(this.key(folder)) !== true)
  }

  /** Huli: whether a canonical folder is a further folder of any project. */
  isFolder(value: string): boolean {
    const key = this.key(value)
    return this.records.some((record) =>
      (record.folders ?? []).some((folder) => this.key(folder) === key),
    )
  }

  /**
   * The canonical path of an existing folder, for any request that names one. Rejects
   * relative paths, missing paths and files with `invalid_params`.
   */
  async resolveDirectory(value: string): Promise<string> {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams(t('project.notAbsolute'))
    }
    let canonical: string
    try {
      canonical = await canonicalizePath(value, this.deps.platform, this.realpath)
    } catch {
      throw invalidParams(t('project.notExist', { path: value }))
    }
    if (!(await this.isDirectory(canonical)))
      throw invalidParams(t('project.notFolder', { path: value }))
    return canonical
  }

  /**
   * Adds a folder, or marks an existing project as opened now. Huli: one whose record waits in the
   * recycle bin comes back with its settings; the sessions its removal took stay in the bin.
   */
  async add(value: string): Promise<Project> {
    const canonical = await this.resolveDirectory(value)
    const binned = this.binnedRecord(canonical)
    if (binned) this.unbinRecord(binned)
    const existing = this.find(canonical)
    if (existing) {
      existing.lastOpenedAt = this.now()
      this.missing.set(this.key(existing.path), false)
    } else {
      const now = this.now()
      const places = this.records.flatMap((record) => record.order ?? [])
      this.records.push({
        path: canonical,
        name: folderName(canonical, this.deps.platform),
        addedAt: now,
        lastOpenedAt: now,
        // Once the user has an order, a new project goes to its end.
        ...(places.length > 0 ? { order: Math.max(...places) + 1 } : {}),
      })
      this.missing.set(this.key(canonical), false)
    }
    this.changed()
    return this.list().find((project) => this.key(project.path) === this.key(canonical))!
  }

  /**
   * Huli: adds a further folder to the project: an existing folder, canonical, other than the
   * project's own and none `REFUSED_FOLDERS` names. One already listed changes nothing.
   */
  async addFolder(record: ProjectRecord, value: string): Promise<Project> {
    const canonical = await this.resolveDirectory(value)
    const problem = this.folderProblem(canonical)
    if (problem) throw invalidParams(t(`projectFolders.refused.${problem}`, { folder: canonical }))
    if (this.key(canonical) === this.key(record.path)) {
      throw invalidParams(t('projectFolders.own'))
    }
    const folders = record.folders ?? []
    if (!folders.some((folder) => this.key(folder) === this.key(canonical))) {
      if (folders.length >= MAX_PROJECT_FOLDERS) {
        throw invalidParams(t('projectFolders.tooMany', { count: MAX_PROJECT_FOLDERS }))
      }
      record.folders = [...folders, canonical]
      this.missing.set(this.key(canonical), false)
      this.changed()
    }
    return this.list().find((project) => this.key(project.path) === this.key(record.path))!
  }

  /** Huli: takes a further folder out of the project, matched without realpath; its files stay. */
  removeFolder(record: ProjectRecord, value: string): void {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('folder must be an absolute path')
    }
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const key = this.key(api.resolve(value))
    const folders = record.folders ?? []
    const kept = folders.filter((folder) => this.key(folder) !== key)
    if (kept.length === folders.length) throw notFound(`${value} is not a folder of the project`)
    if (kept.length > 0) record.folders = kept
    else delete record.folders
    if (!this.isFolder(value) && !this.find(value)) this.missing.delete(key)
    this.changed()
  }

  private folderProblem(canonical: string): RefusedFolder | null {
    const { home, dataDir, platform } = this.deps
    if (home === undefined || dataDir === undefined) {
      const api = platform === 'win32' ? path.win32 : path.posix
      return this.key(api.parse(canonical).root) === this.key(canonical) ? 'root' : null
    }
    const problem = folderProblem(canonical, { platform, home, dataDir })
    return refused(problem) ? problem : null
  }

  /** The stored project for a path that may no longer exist, matched without realpath. */
  match(value: string): ProjectRecord {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('path must be an absolute path')
    }
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const record = this.find(api.resolve(value))
    if (!record) throw notFound(t('project.noProject', { path: value }))
    return record
  }

  /** How the project names and prepares its sessions' worktrees, with the defaults filled in. */
  worktreeSettings(value: string): ProjectWorktreeSettings {
    const stored = this.find(value)?.worktree ?? {}
    return { ...DEFAULT_WORKTREE_SETTINGS, ...stored, copy: [...(stored.copy ?? [])] }
  }

  /** Stores only what differs from the defaults; a project that is not listed is refused. */
  setWorktreeSettings(value: string, settings: ProjectWorktreeSettings): void {
    const record = this.find(value)
    if (!record) throw notFound(t('project.noProject', { path: value }))
    const differs: Partial<ProjectWorktreeSettings> = {}
    for (const key of Object.keys(DEFAULT_WORKTREE_SETTINGS) as (keyof ProjectWorktreeSettings)[]) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_WORKTREE_SETTINGS[key])) {
        Object.assign(differs, { [key]: settings[key] })
      }
    }
    if (Object.keys(differs).length > 0) record.worktree = differs
    else delete record.worktree
    this.changed()
  }

  /** Huli: the project's own choice of what the host allows by itself; null keeps the default. */
  autoApprove(value: string): AutoApprove | null {
    return this.find(value)?.autoApprove ?? null
  }

  /** Huli: the project's own manager-mode roster and choices; null keeps the settings'. */
  manager(value: string): ProjectManagerSettings | null {
    return this.find(value)?.manager ?? null
  }

  setManager(record: ProjectRecord, manager: ProjectManagerSettings | null): void {
    if (manager === null) delete record.manager
    else record.manager = structuredClone(manager)
    this.changed()
  }

  setAutoApprove(record: ProjectRecord, level: AutoApprove | null): void {
    if ((record.autoApprove ?? null) === level) return
    if (level === null) delete record.autoApprove
    else record.autoApprove = level
    this.changed()
  }

  /** Huli: the sandbox the project's new sessions start in; null keeps the default. */
  sandbox(value: string): SandboxChoice | null {
    const record = this.find(value)
    return record?.sandbox ? { ...record.sandbox } : null
  }

  setSandbox(record: ProjectRecord, choice: SandboxChoice | null): void {
    const before = record.sandbox ?? null
    if (before === null ? choice === null : choice !== null && sameSandbox(before, choice)) return
    if (choice === null) delete record.sandbox
    else record.sandbox = { ...choice }
    this.changed()
  }

  /** Huli: into the recycle bin, with its settings; `purge` deletes it for good. */
  remove(record: ProjectRecord): void {
    this.records = this.records.filter((item) => item !== record)
    this.missing.delete(this.key(record.path))
    for (const folder of record.folders ?? []) {
      if (!this.isFolder(folder) && !this.find(folder)) this.missing.delete(this.key(folder))
    }
    record.deletedAt = this.now()
    this.binned.push(record)
    this.changed()
  }

  // Huli: the recycle bin's projects.

  /** The removed projects in the recycle bin. */
  binnedRecords(): ProjectRecord[] {
    return [...this.binned]
  }

  /** The binned record of a folder, matched without realpath; undefined when none is binned. */
  binnedRecord(value: string): ProjectRecord | undefined {
    const key = this.key(value)
    return this.binned.find((record) => this.key(record.path) === key)
  }

  /** Puts a binned project back in the list as it was; false when it is not in the bin. */
  restore(value: string): boolean {
    const record = this.binnedRecord(value)
    if (!record) return false
    // A project added again meanwhile is the one listed; the binned one goes.
    if (this.find(record.path)) {
      this.binned = this.binned.filter((item) => item !== record)
      this.changed()
      return true
    }
    this.unbinRecord(record)
    this.changed()
    void this.refreshMissing()
    return true
  }

  private unbinRecord(record: ProjectRecord): void {
    this.binned = this.binned.filter((item) => item !== record)
    delete record.deletedAt
    this.records.push(record)
  }

  /** Deletes binned projects for good, as removing one did before the recycle bin. */
  purge(values: readonly string[]): void {
    const keys = new Set(values.map((value) => this.key(value)))
    const before = this.binned.length
    this.binned = this.binned.filter((record) => !keys.has(this.key(record.path)))
    if (this.binned.length !== before) this.changed()
  }

  touch(record: ProjectRecord): void {
    record.lastOpenedAt = this.now()
    this.changed()
  }

  pin(record: ProjectRecord, pinned: boolean): void {
    if (pinned === (record.pinnedAt !== undefined)) return
    if (pinned) record.pinnedAt = this.now()
    else delete record.pinnedAt
    this.changed()
  }

  /** Puts a project just before `before`, or last with null; every project then has a place. */
  move(record: ProjectRecord, before: ProjectRecord | null): void {
    if (before === record) throw invalidParams(t('project.moveBeforeItself'))
    const ordered = this.ordered().filter((item) => item !== record)
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, record)
    for (const [index, item] of ordered.entries()) item.order = index
    this.changed()
  }

  /**
   * Huli: the user's order of the project's sidebar rows, or of No project's with a null record;
   * null goes back to latest activity. The ids come validated, each once.
   */
  orderSessions(record: ProjectRecord | null, ids: readonly string[] | null): void {
    const before = record ? record.sessionOrder : this.noProjectSessionOrder
    if (ids === null ? before === undefined : sameIds(before, ids)) return
    const next = ids === null ? undefined : [...ids]
    if (!record) this.noProjectSessionOrder = next
    else if (next) record.sessionOrder = next
    else delete record.sessionOrder
    this.changed()
  }

  pinNoProject(pinned: boolean): void {
    if (pinned === (this.noProjectPinnedAt !== undefined)) return
    this.noProjectPinnedAt = pinned ? this.now() : undefined
    this.changed()
  }

  /** Marks projects whose folder is gone; they stay listed, so an unmounted drive loses nothing. */
  async refreshMissing(notify = true): Promise<void> {
    let changed = false
    const folders = this.records.flatMap((record) => [record.path, ...(record.folders ?? [])])
    await Promise.all(
      [...new Set(folders)].map(async (folder) => {
        const missing = !(await this.isDirectory(folder))
        const key = this.key(folder)
        if (this.missing.get(key) !== missing) {
          this.missing.set(key, missing)
          changed = true
        }
      }),
    )
    if (changed && notify) this.notify()
  }

  onChange(listener: (projects: Project[], noProject: NoProject) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.deps.file.save({
      version: 1,
      projects: [...this.records, ...this.binned].map((record) => ({ ...record })),
      ...(this.noProjectPinnedAt === undefined
        ? {}
        : { noProjectPinnedAt: this.noProjectPinnedAt }),
      ...(this.noProjectSessionOrder === undefined
        ? {}
        : { noProjectSessionOrder: [...this.noProjectSessionOrder] }),
      ...(this.newProjectParent === undefined ? {} : { newProjectParent: this.newProjectParent }),
    })
    this.notify()
  }

  private notify(): void {
    const projects = this.list()
    const noProject = this.noProject()
    for (const listener of this.listeners) listener(projects, noProject)
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }
}

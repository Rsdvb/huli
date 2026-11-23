// Huli: Add project's two new kinds of project, made on this computer: a clone of a Git repository
// and an empty folder with Git. A paired device names only a folder `places` offers to make one
// in; the window names any. Either way the folder is resolved here, and an existing one that is not
// empty, a file or a link is refused. The clone runs git with only HTTPS and SSH allowed, no
// transport helper, no hook and no submodule, through Kite's proxy as the rest of its git does,
// and with the computer's own Git sign-in, which Kite never sees or keeps.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import {
  lstat,
  mkdir,
  readdir,
  realpath as fsRealpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import {
  cloneUrlProblem,
  MAX_PROJECT_PLACES,
  projectNameProblem,
  withoutUrlCredentials,
  type ClonePhase,
  type CloneProgress,
  type GitignorePreset,
  type ProjectCloneParams,
  type ProjectCreateParams,
  type ProjectPlace,
  type ProjectPlaces,
} from '@shared/project-create'
import { HostError, invalidParams } from './errors'
import { cloneArgs, CLONE_ENV, noHooksPath } from './git/clone'
import { CHILD_ENV, GIT_TIMEOUT_MS, stopTree, type Exec } from './git/exec'
import { t } from './i18n'
import { canonicalizePath, isInside, pathKey, samePath } from './paths'
import type { ProcessControl } from './process-tree'

/** How long a clone may run before it is ended. */
const CLONE_MS = 30 * 60_000
/** Clones running at once on this computer. */
const MAX_CLONES = 4
/** Projects whose folders are looked at for places; the rest are older. */
const PLACE_CANDIDATES = 40
/** The least time between two progress events of one clone. */
const PROGRESS_MS = 250
/** What is kept of git's own words for a failure. */
const MESSAGE_LINES = 12
const MESSAGE_CHARS = 2_000

/** What the service takes from the project list. */
export interface ProjectList {
  add(value: string): Promise<Project>
  recentPaths(): string[]
  lastNewProjectParent(): string | undefined
  setNewProjectParent(value: string): void
}

export interface ProjectCreateDeps {
  platform: Platform
  home: string
  /** Kite's data folder: the clone's hooks path names a folder in it that is never made. */
  dataDir: string
  projects: ProjectList
  /** The agents' environment once ready: the resolved PATH and Kite's proxy. */
  env(): Promise<NodeJS.ProcessEnv>
  /** git's full path in that environment, or null when it is not installed. */
  findGit(env: NodeJS.ProcessEnv): Promise<string | null>
  /** Runs git init and the like. */
  exec: Exec
  control: ProcessControl
  progress(portId: string, progress: CloneProgress): void
  log(level: 'info' | 'warn', message: string): void
  spawn?: typeof nodeSpawn
  realpath?: (value: string) => Promise<string>
}

/** Who asks: a window of this computer, or a paired device, which chooses among the places. */
export interface Asker {
  portId: string
  device: boolean
}

interface Target {
  parent: string
  path: string
  /** It was an empty folder already, which a failure leaves as it was. */
  existed: boolean
}

interface Clone {
  cancelled: boolean
  child: ChildProcess | null
}

function api(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

export class ProjectCreate {
  private readonly clones = new Map<string, Clone>()
  private readonly spawn: typeof nodeSpawn
  private readonly realpath: (value: string) => Promise<string>

  constructor(private readonly deps: ProjectCreateDeps) {
    this.spawn = deps.spawn ?? nodeSpawn
    this.realpath = deps.realpath ?? ((value) => fsRealpath(value))
  }

  /**
   * The folders a new project may go in: the last one chosen, the home folder, then the folders
   * the latest projects are in. Each is resolved and there now, and listed once.
   */
  async places(): Promise<ProjectPlaces> {
    const { platform } = this.deps
    const p = api(platform)
    const last = this.deps.projects.lastNewProjectParent()
    const candidates: ProjectPlace[] = [
      ...(last ? [{ path: last, kind: 'last' as const }] : []),
      { path: this.deps.home, kind: 'home' },
      ...this.deps.projects
        .recentPaths()
        .slice(0, PLACE_CANDIDATES)
        .map((project) => ({ path: p.dirname(project), kind: 'project' as const })),
    ]
    const seen = new Set<string>()
    const unique = candidates.filter((place) => {
      const key = pathKey(place.path, platform)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const resolved = await Promise.all(
      unique.map(async (place) => {
        const folder = await this.folder(place.path)
        return folder === null ? null : { ...place, path: folder }
      }),
    )
    const places: ProjectPlace[] = []
    const kept = new Set<string>()
    for (const place of resolved) {
      if (place === null) continue
      const key = pathKey(place.path, platform)
      if (kept.has(key)) continue
      kept.add(key)
      places.push(place)
      if (places.length >= MAX_PROJECT_PLACES) break
    }
    const lastPlace = places.find((place) => place.kind === 'last')
    return { places, last: lastPlace?.path ?? null }
  }

  /** The folder resolved, or null when it is not one now. */
  private async folder(value: string): Promise<string | null> {
    try {
      const canonical = await canonicalizePath(value, this.deps.platform, this.realpath)
      return (await stat(canonical)).isDirectory() ? canonical : null
    } catch {
      return null
    }
  }

  /** The folder a new project goes in, resolved: one of the places for a device. */
  async parentFor(value: string, asker: Asker): Promise<string> {
    const parent = await this.folder(value)
    if (parent === null) {
      throw invalidParams(t('newProject.parentMissing', { path: value }), { field: 'parent' })
    }
    if (asker.device) {
      const { places } = await this.places()
      if (!places.some((place) => samePath(place.path, parent, this.deps.platform))) {
        throw new HostError('forbidden', t('newProject.parentNotOffered'), { field: 'parent' })
      }
    }
    return parent
  }

  /** The new project's folder in `parent`: not there yet, or an empty folder. */
  async targetFor(parent: string, name: string): Promise<Target> {
    const problem = projectNameProblem(name)
    if (problem !== null) {
      throw invalidParams(t(`newProject.name.${problem}`), { field: 'name', problem })
    }
    const target = api(this.deps.platform).join(parent, name)
    if (!isInside(target, parent, this.deps.platform)) {
      throw invalidParams(t('newProject.name.chars'), { field: 'name', problem: 'chars' })
    }
    let existing: Awaited<ReturnType<typeof lstat>>
    try {
      existing = await lstat(target)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { parent, path: target, existed: false }
      throw error
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new HostError('conflict', t('newProject.targetTaken', { name }), { field: 'name' })
    }
    // A junction or mount point reads as a folder; its real place must be where it is named.
    const real = await canonicalizePath(target, this.deps.platform, this.realpath).catch(() => null)
    if (real === null || !samePath(real, target, this.deps.platform)) {
      throw new HostError('conflict', t('newProject.targetTaken', { name }), { field: 'name' })
    }
    if ((await readdir(target)).length > 0) {
      throw new HostError('conflict', t('newProject.targetNotEmpty', { name }), { field: 'name' })
    }
    return { parent, path: target, existed: true }
  }

  /** Clones the repository into a new project and adds it; the asker's port hears its progress. */
  async clone(params: ProjectCloneParams, asker: Asker): Promise<Project> {
    const problem = cloneUrlProblem(params.url)
    if (problem !== null) {
      throw invalidParams(t(`newProject.url.${problem}`), { field: 'url', problem })
    }
    if (this.clones.has(params.cloneId)) {
      throw new HostError('conflict', t('newProject.cloneRunning'))
    }
    if (this.clones.size >= MAX_CLONES) throw new HostError('busy', t('newProject.tooManyClones'))
    const clone: Clone = { cancelled: false, child: null }
    this.clones.set(params.cloneId, clone)
    let target: Target | null = null
    try {
      const parent = await this.parentFor(params.parent, asker)
      target = await this.targetFor(parent, params.name)
      const env = await this.deps.env()
      const git = await this.deps.findGit(env)
      if (git === null) throw new HostError('unavailable', t('newProject.noGit'))
      if (clone.cancelled) throw cancelled()
      await this.runClone(git, env, params, target, clone, asker)
    } catch (error) {
      if (target !== null) await this.undo(target)
      throw error
    } finally {
      this.clones.delete(params.cloneId)
    }
    return this.added(target)
  }

  /** Ends a clone that runs; one that already ended changes nothing. */
  cancelClone(cloneId: string): void {
    const clone = this.clones.get(cloneId)
    if (!clone) return
    clone.cancelled = true
    const pid = clone.child?.pid
    if (pid !== undefined) void stopTree(this.deps.control, pid)
  }

  /** Makes an empty folder with Git in it, a README and a `.gitignore` if asked, and adds it. */
  async create(params: ProjectCreateParams, asker: Asker): Promise<Project> {
    const parent = await this.parentFor(params.parent, asker)
    const target = await this.targetFor(parent, params.name)
    try {
      if (!target.existed) {
        try {
          await mkdir(target.path)
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error
          throw new HostError('conflict', t('newProject.targetTaken', { name: params.name }), {
            field: 'name',
          })
        }
      }
      await this.deps.env()
      const result = await this.deps.exec('git', ['init', '-q'], {
        cwd: target.path,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      if (result.failure === 'not-found') throw new HostError('unavailable', t('newProject.noGit'))
      if (result.failure !== null || result.code !== 0) {
        throw new HostError(
          'git_error',
          t('newProject.initFailed', { detail: gitWords(result.stderr || result.message) }),
        )
      }
      const p = api(this.deps.platform)
      if (params.readme) {
        await writeFile(p.join(target.path, 'README.md'), `# ${params.name}\n`, { flag: 'wx' })
      }
      if (params.gitignore !== null) {
        await writeFile(p.join(target.path, '.gitignore'), GITIGNORES[params.gitignore], {
          flag: 'wx',
        })
      }
    } catch (error) {
      // A folder made before the request is not this one, so a conflict there leaves it alone.
      if (!(error instanceof HostError && error.code === 'conflict')) await this.undo(target)
      throw error
    }
    return this.added(target)
  }

  private async added(target: Target): Promise<Project> {
    const project = await this.deps.projects.add(target.path)
    this.deps.projects.setNewProjectParent(target.parent)
    return project
  }

  private runClone(
    git: string,
    base: NodeJS.ProcessEnv,
    params: ProjectCloneParams,
    target: Target,
    clone: Clone,
    asker: Asker,
  ): Promise<void> {
    const hooks = noHooksPath(this.deps.dataDir, this.deps.platform)
    const args = cloneArgs(params.url, target.path, hooks, ['--progress'])
    const env: NodeJS.ProcessEnv = {
      ...base,
      ...CHILD_ENV,
      ...CLONE_ENV,
      // The computer's own credential helper may show its sign-in to the user at it; a paired
      // device's user is not there to answer one.
      GCM_INTERACTIVE: asker.device ? 'never' : 'auto',
    }
    const progress = new ProgressReader(params.cloneId, (event) =>
      this.deps.progress(asker.portId, event),
    )
    progress.start()
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawn(git, args, {
          cwd: target.parent,
          env,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch (error) {
        reject(new HostError('git_error', t('newProject.cloneFailed', { detail: String(error) })))
        return
      }
      clone.child = child
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid !== undefined) void stopTree(this.deps.control, child.pid)
      }, CLONE_MS)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => progress.read(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new HostError('git_error', t('newProject.cloneFailed', { detail: error.message })))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (clone.cancelled) return reject(cancelled())
        if (timedOut) return reject(new HostError('git_error', t('newProject.cloneTimedOut')))
        if (code === 0) return resolve()
        this.deps.log('info', `A clone for a new project failed: git exited with ${code}`)
        reject(
          new HostError('git_error', t('newProject.cloneFailed', { detail: progress.message() })),
        )
      })
    })
  }

  /** Takes back what a failed or cancelled new project left: the folder, or what it holds. */
  private async undo(target: Target): Promise<void> {
    const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
    try {
      if (!target.existed) {
        await rm(target.path, options)
        return
      }
      const entries = await readdir(target.path).catch(() => [])
      const p = api(this.deps.platform)
      await Promise.all(entries.map((entry) => rm(p.join(target.path, entry), options)))
    } catch (error) {
      this.deps.log('warn', `A new project's folder was not removed: ${errorCode(error) ?? error}`)
    }
  }
}

function cancelled(): HostError {
  return new HostError('conflict', t('newProject.cancelled'), { reason: 'cancelled' })
}

/** git's own words for the user: the lines that are not progress, with no sign-in in them. */
function gitWords(text: string): string {
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && phaseOf(line) === null && !/^Cloning into /.test(line))
  const kept = withoutUrlCredentials(lines.slice(-MESSAGE_LINES).join('\n'))
  return kept.length > MESSAGE_CHARS ? `${kept.slice(0, MESSAGE_CHARS)}…` : kept
}

const PHASES: [RegExp, ClonePhase][] = [
  [/^(?:remote: )?(?:Enumerating|Counting) objects:\s+(?:(\d+)%)?/, 'counting'],
  [/^(?:remote: )?Compressing objects:\s+(?:(\d+)%)?/, 'compressing'],
  [/^Receiving objects:\s+(?:(\d+)%)?/, 'receiving'],
  [/^Resolving deltas:\s+(?:(\d+)%)?/, 'resolving'],
  [/^(?:Updating files|Checking out files):\s+(?:(\d+)%)?/, 'checkout'],
]

function phaseOf(line: string): { phase: ClonePhase; percent: number | null } | null {
  for (const [pattern, phase] of PHASES) {
    const match = pattern.exec(line)
    if (match) {
      const percent = match[1] === undefined ? null : Math.min(100, Number(match[1]))
      return { phase, percent }
    }
  }
  return null
}

/** git's `--progress` lines as progress events, at most one per PROGRESS_MS but every phase. */
export class ProgressReader {
  private pending = ''
  private text = ''
  private last: CloneProgress | null = null
  private lastAt = 0

  constructor(
    private readonly cloneId: string,
    private readonly emit: (progress: CloneProgress) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.send({ cloneId: this.cloneId, phase: 'connecting', percent: null })
  }

  read(chunk: string): void {
    const parts = (this.pending + chunk).split(/[\r\n]/)
    this.pending = parts.pop() ?? ''
    for (const line of parts) this.line(line)
    // A line still being redrawn says where git is now.
    const shown = phaseOf(this.pending.trim())
    if (shown) this.offer(shown)
  }

  /** git's own words so far, for a failure. */
  message(): string {
    return gitWords(`${this.text}\n${this.pending}`)
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (line === '') return
    const found = phaseOf(line)
    if (found) return this.offer(found)
    this.text = `${this.text}\n${line}`.slice(-MESSAGE_CHARS * 4)
  }

  private offer(found: { phase: ClonePhase; percent: number | null }): void {
    const last = this.last
    if (last && last.phase === found.phase && last.percent === found.percent) return
    const now = this.now()
    const newPhase = last === null || last.phase !== found.phase || found.percent === 100
    if (!newPhase && now - this.lastAt < PROGRESS_MS) return
    this.send({ cloneId: this.cloneId, ...found })
  }

  private send(progress: CloneProgress): void {
    this.last = progress
    this.lastAt = this.now()
    this.emit(progress)
  }
}

/** The `.gitignore` each preset writes: what the system, editors and the toolchain leave behind. */
const COMMON = ['# System and editors', '.DS_Store', 'Thumbs.db', '.idea/', '.vscode/', '*.swp']

const GITIGNORES: Record<GitignorePreset, string> = {
  general: lines(COMMON, ['# Environment', '.env', '.env.*', '*.log']),
  node: lines(COMMON, [
    '# Node.js',
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '.env',
    '.env.*',
    'npm-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
  ]),
  python: lines(COMMON, [
    '# Python',
    '__pycache__/',
    '*.py[cod]',
    '.venv/',
    'venv/',
    'build/',
    'dist/',
    '*.egg-info/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.env',
  ]),
  go: lines(COMMON, ['# Go', '/bin/', '*.exe', '*.test', '*.out', 'coverage.*', '.env']),
  rust: lines(COMMON, ['# Rust', '/target/', '**/*.rs.bk', '.env']),
}

function lines(...groups: string[][]): string {
  return `${groups.map((group) => group.join('\n')).join('\n\n')}\n`
}

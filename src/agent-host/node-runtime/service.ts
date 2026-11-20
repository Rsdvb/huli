// Huli: Kite's own Node.js on this host: its installs, the user's choice between it and their own,
// and the one install, update or removal at a time, whose progress windows and devices hear in
// `environment.changed`. Huli's own; see tools/huli/README.md (Kite's own Node.js).

import path from 'node:path'
import { NODE_CHOICES, type NodeChoice, type NodeTask } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { t } from '../i18n'
import type { ManagedNode, NodeInstallStatus } from '../shell-env'
import { JsonFile, type LogFn } from '../storage'
import {
  installNode,
  listNodeInstalls,
  removeLeftovers,
  removeNodeInstalls,
  type InstallProgress,
  type NodeInstall,
  type NodeInstallOptions,
  type NodeInstallResult,
} from './install'
import { nodeAsset, type NodeAsset } from './release'
import type { Transport } from './transport'

/** Progress reaches the windows at most this often, but for a change of phase. */
const PROGRESS_MS = 250

interface NodeRuntimeFile {
  version: 1
  choice: NodeChoice
}

export function nodeRuntimeFile(userDataPath: string, log: LogFn): JsonFile<NodeRuntimeFile> {
  return new JsonFile<NodeRuntimeFile>({
    file: path.join(userDataPath, 'state', 'node-runtime.json'),
    version: 1,
    migrations: {},
    parse: (data) =>
      NODE_CHOICES.includes(data.choice as NodeChoice)
        ? { version: 1, choice: data.choice as NodeChoice }
        : 'choice must be auto or kite',
    empty: () => ({ version: 1, choice: 'auto' }),
    log,
    debounceMs: 100,
  })
}

/** `<userData>/runtimes/node`, where every version has its folder. */
export function nodeRuntimesFolder(userDataPath: string): string {
  return path.join(userDataPath, 'runtimes', 'node')
}

export interface NodeRuntimeDeps {
  root: string
  file: JsonFile<NodeRuntimeFile>
  platform: Platform
  arch: string
  /** Whether this is Linux on musl, which nodejs.org builds nothing for; asked once. */
  musl?: () => boolean
  required: string | null
  transport: Transport
  log: LogFn
  /** Agents run on what this says from now on; resolves once they were detected again. */
  apply(setup: { managed: ManagedNode | null; choice: NodeChoice }): Promise<void>
  /** The task changed, for the windows and devices. */
  changed(): void
  install?: (options: NodeInstallOptions) => Promise<NodeInstallResult>
}

/** Whether this Linux runs on musl, such as Alpine: its C library has no glibc version. */
export function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
    return !report?.header?.glibcVersionRuntime
  } catch {
    return false
  }
}

function managedOf(installs: readonly NodeInstall[]): ManagedNode | null {
  const newest = installs[0]
  return newest ? { version: newest.version, binDir: newest.binDir } : null
}

export class NodeRuntimeService {
  private installs: NodeInstall[] = []
  private choice: NodeChoice = 'auto'
  private task: NodeTask | null = null
  private running: Promise<NodeInstallResult> | null = null
  private controller: AbortController | null = null
  private lastSent = 0
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private found: { asset: NodeAsset | null } | null = null

  constructor(private readonly deps: NodeRuntimeDeps) {}

  private get asset(): NodeAsset | null {
    this.found ??= {
      asset: nodeAsset(this.deps.platform, this.deps.arch, this.deps.musl?.() ?? false),
    }
    return this.found.asset
  }

  /** Reads the choice and the installs; returns what agents run on, before the first detection. */
  async load(): Promise<{ managed: ManagedNode | null; choice: NodeChoice }> {
    const [file] = await Promise.all([
      this.deps.file.load(),
      removeLeftovers(this.deps.root).catch(() => {}),
    ])
    this.choice = file.choice
    this.installs = await listNodeInstalls(this.deps.root, this.deps.platform)
    return { managed: managedOf(this.installs), choice: this.choice }
  }

  status(): NodeInstallStatus {
    return { installable: this.asset !== null, task: this.task }
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  /** Installs the newest LTS release, or joins the install under way. */
  install(): Promise<NodeInstallResult> {
    if (this.running) return this.running
    if (this.task?.state === 'running') return Promise.reject(new Error(t('nodeRuntime.busy')))
    const asset = this.asset
    if (!asset) return Promise.reject(new Error(t('nodeRuntime.unsupported')))
    const controller = new AbortController()
    this.controller = controller
    this.setTask({
      kind: 'install',
      state: 'running',
      phase: 'checking',
      progress: null,
      version: null,
      source: null,
      error: null,
    })
    const run = (async () => {
      try {
        const result = await (this.deps.install ?? installNode)({
          root: this.deps.root,
          platform: this.deps.platform,
          asset,
          required: this.deps.required,
          transport: this.deps.transport,
          signal: controller.signal,
          onProgress: (progress) => this.progress(progress),
          log: (level, message) => this.deps.log(level, message),
        })
        this.installs = await listNodeInstalls(this.deps.root, this.deps.platform)
        this.deps.log(
          'info',
          result.installed
            ? `Installed Node.js ${result.install.version} from ${result.source}`
            : `Node.js ${result.install.version} is the newest LTS release and installed`,
        )
        // The task stays until agents run on it, so no window offers the install again meanwhile.
        try {
          await this.deps.apply({ managed: managedOf(this.installs), choice: this.choice })
        } finally {
          this.setTask(null)
        }
        return result
      } catch (error) {
        const message = (error as Error).message
        this.deps.log('warn', `Node.js install failed: ${message}`)
        // A stop the user asked for is no failure to show.
        this.setTask(
          controller.signal.aborted
            ? null
            : { ...(this.task ?? emptyTask('install')), state: 'failed', error: message },
        )
        throw error
      } finally {
        this.running = null
        this.controller = null
      }
    })()
    this.running = run
    return run
  }

  /** Stops the install under way, or clears the failed one. */
  cancel(): void {
    if (this.controller) this.controller.abort()
    else if (this.task?.state === 'failed') this.setTask(null)
  }

  /**
   * Removes every install of Kite's own. Agents move to the user's own Node.js first, so none
   * starts on it again; one still running keeps its folder, and the removal says so.
   */
  async remove(): Promise<void> {
    if (this.running || this.task?.state === 'running') throw new Error(t('nodeRuntime.busy'))
    this.setTask({ ...emptyTask('remove'), phase: 'removing' })
    try {
      await this.deps.apply({ managed: null, choice: this.choice })
      await removeNodeInstalls(this.deps.root, this.deps.platform)
      this.installs = await listNodeInstalls(this.deps.root, this.deps.platform)
      this.setTask(null)
      this.deps.log('info', 'Removed Kite’s own Node.js')
    } catch (error) {
      this.installs = await listNodeInstalls(this.deps.root, this.deps.platform)
      this.setTask({ ...emptyTask('remove'), state: 'failed', error: (error as Error).message })
      // What could not be removed still runs agents.
      await this.deps.apply({ managed: managedOf(this.installs), choice: this.choice })
      throw error
    }
  }

  async setChoice(choice: NodeChoice): Promise<void> {
    if (choice === this.choice) return
    this.choice = choice
    this.deps.file.save({ version: 1, choice })
    await this.deps.apply({ managed: managedOf(this.installs), choice })
  }

  private progress(progress: InstallProgress): void {
    const previous = this.task
    if (!previous || previous.state !== 'running') return
    const phaseChanged = previous.phase !== progress.phase
    this.task = { ...previous, ...progress }
    if (phaseChanged) this.send()
    else this.sendSoon()
  }

  private setTask(task: NodeTask | null): void {
    this.task = task
    this.send()
  }

  private send(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendTimer = null
    this.lastSent = Date.now()
    this.deps.changed()
  }

  private sendSoon(): void {
    if (this.sendTimer) return
    const wait = Math.max(0, this.lastSent + PROGRESS_MS - Date.now())
    this.sendTimer = setTimeout(() => this.send(), wait)
    this.sendTimer.unref?.()
  }
}

function emptyTask(kind: NodeTask['kind']): NodeTask {
  return {
    kind,
    state: 'running',
    phase: 'checking',
    progress: null,
    version: null,
    source: null,
    error: null,
  }
}

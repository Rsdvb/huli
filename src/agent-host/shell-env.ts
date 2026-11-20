// The environment agents run in: the login shell's, resolved once the way VS Code does it,
// because apps started from the Dock or a desktop launcher get a minimal PATH.

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { EnvironmentInfo, NodeChoice, NodeRuntimeInfo, NodeTask } from '@shared/agent-host'
import { NODE_NO_PROXY } from '@shared/agent-network'
import type { NodeRuntime } from '@shared/host-control'
import { withLongPaths } from '@shared/git'
import type { Platform } from '@shared/platform'
import type { ProxySettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { deleteEnv, findCommand, getEnv, isExecutableFile, type Env } from './find-command'
import { translate, type HostMessage } from './i18n'
import { quotePosix } from './quote'

export const SHELL_ENV_TIMEOUT_MS = 10_000
/** The first wait before a read that fell back is tried again; each one after it doubles it. */
const RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
const MAX_PROBE_OUTPUT = 8 * 1024 * 1024

export function defaultShell(platform: Platform, env: Env): string {
  const shell = env.SHELL
  if (shell && path.posix.isAbsolute(shell)) return shell
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

/**
 * Arguments that make `shell` print the environment between two markers through `node`, the
 * program that runs as Node.js. csh and tcsh accept `-l` only as their sole flag, so they run
 * interactive without it (`-ic`), as in VS Code; pwsh and nu need their own syntax.
 */
export function shellProbeArgs(shell: string, node: string, mark: string): string[] {
  const name = path.posix.basename(shell).replace(/\.exe$/i, '')
  const exe = quotePosix(node)
  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(name)) {
    const ps = `'${node.replace(/'/g, "''")}'`
    return [
      '-Login',
      '-Command',
      `& ${ps} -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`,
    ]
  }
  const command = `${name === 'nu' ? '^' : ''}${exe} -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`
  if (name === 'tcsh' || name === 'csh') return ['-ic', command]
  return ['-i', '-l', '-c', command]
}

/** The environment printed between the markers, or null when the output has none. */
export function parseProbeOutput(stdout: string, mark: string): Env | null {
  const start = stdout.indexOf(mark)
  if (start < 0) return null
  const end = stdout.indexOf(mark, start + mark.length)
  if (end < 0) return null
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start + mark.length, end))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const env: Env = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') env[key] = value
    }
    return env
  } catch {
    return null
  }
}

/** Removes Electron's variables, which would make an agent's Node.js behave like Electron. */
export function withoutElectronVars(env: Env, platform: Platform): Env {
  const out: Env = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = platform === 'win32' ? key.toUpperCase() : key
    if (upper.startsWith('ELECTRON_') || value === undefined) continue
    out[key] = value
  }
  return out
}

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const

/**
 * A custom proxy replaces the proxy variables in both cases; on Windows, where names are
 * case-insensitive, only the upper-case forms are set so the two cannot disagree.
 */
export function applyProxy(env: Env, proxy: ProxySettings, platform: Platform): Env {
  if (proxy.mode !== 'custom') return env
  const out = { ...env }
  for (const name of PROXY_NAMES) {
    deleteEnv(out, name, platform)
    deleteEnv(out, name.toLowerCase(), platform)
  }
  const values: [string, string][] = [
    ['HTTP_PROXY', proxy.url],
    ['HTTPS_PROXY', proxy.url],
  ]
  if (proxy.noProxy.trim() !== '') values.push(['NO_PROXY', proxy.noProxy.trim()])
  for (const [name, value] of values) {
    out[name] = value
    if (platform !== 'win32') out[name.toLowerCase()] = value
  }
  return out
}

const NODE_PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const

/**
 * An agent that goes through a node: every proxy variable names its own listener on 127.0.0.1, so
 * no inherited one, such as a system proxy client's, is left for a program to prefer. Only
 * loopback, the private ranges and Tailscale go around it.
 */
export function applyNodeProxy(env: Env, port: number, platform: Platform): Env {
  const out = { ...env }
  for (const name of NODE_PROXY_NAMES) {
    deleteEnv(out, name, platform)
    deleteEnv(out, name.toLowerCase(), platform)
  }
  const url = `http://127.0.0.1:${port}`
  const values: [string, string][] = [
    ['HTTP_PROXY', url],
    ['HTTPS_PROXY', url],
    ['ALL_PROXY', url],
    ['NO_PROXY', NODE_NO_PROXY.join(',')],
  ]
  for (const [name, value] of values) {
    out[name] = value
    if (platform !== 'win32') out[name.toLowerCase()] = value
  }
  return out
}

/** An agent's own configuration folder, which wins over the same variable from the shell. */
export function applyConfigFolder(
  env: Env,
  folder: ConfigFolder | undefined,
  platform: Platform,
): Env {
  if (!folder) return env
  const out = { ...env }
  deleteEnv(out, folder.variable, platform)
  out[folder.variable] = folder.path
  return out
}

/** The variable that moves an agent's configuration folder, and the folder picked for it. */
export interface ConfigFolder {
  variable: string
  path: string
}

export interface ShellEnvironment {
  env: Env
  source: EnvironmentInfo['source']
  shell: string | null
  durationMs: number
  // Kept as a message so Settings shows it in the language chosen later.
  warning: HostMessage | null
}

export interface ResolveOptions {
  platform: Platform
  nodeRuntime: NodeRuntime
  baseEnv: Env
  timeoutMs?: number
}

function runProbe(shell: string, options: ResolveOptions, timeoutMs: number): Promise<Env> {
  const mark = randomBytes(8).toString('hex')
  const args = shellProbeArgs(shell, options.nodeRuntime.command, mark)
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      // No controlling terminal, so an interactive profile cannot stop the probe for input.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...options.baseEnv, ...options.nodeRuntime.env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, env?: Env): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(env!)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      finish(new Error(`the login shell did not answer within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      if (stderr.length < 64 * 1024) stderr += data
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      const env = parseProbeOutput(stdout, mark)
      if (env) return finish(null, env)
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      const detail = stderr.trim().split('\n').slice(-3).join(' ')
      finish(
        new Error(
          `${path.posix.basename(shell)} printed no environment (${reason})${detail ? `: ${detail}` : ''}`,
        ),
      )
    })
  })
}

/**
 * The login shell's environment on macOS and Linux, and the inherited one on Windows. On
 * timeout or failure the inherited environment is used, with a warning for Settings.
 */
export async function resolveShellEnvironment(options: ResolveOptions): Promise<ShellEnvironment> {
  const started = Date.now()
  const { platform, baseEnv } = options
  if (platform === 'win32') {
    return {
      env: withoutElectronVars(baseEnv, platform),
      source: 'inherited',
      shell: null,
      durationMs: 0,
      warning: { key: 'environment.inherited' },
    }
  }
  const shell = defaultShell(platform, baseEnv)
  try {
    const env = await runProbe(shell, options, options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS)
    return {
      env: withoutElectronVars(env, platform),
      source: 'login-shell',
      shell,
      durationMs: Date.now() - started,
      warning: null,
    }
  } catch (error) {
    return {
      env: withoutElectronVars(baseEnv, platform),
      source: 'fallback',
      shell,
      durationMs: Date.now() - started,
      warning: {
        key: 'environment.fallback',
        params: { shell, error: (error as Error).message },
      },
    }
  }
}

export interface NodeProbe {
  nodeVersion: string | null
  npmPath: string | null
  nodePath: string | null
}

/** Finds `node` and `npm` and asks `node --version`, with the agent environment. */
export async function probeNode(env: Env, platform: Platform): Promise<NodeProbe> {
  const lookup = { platform, env, isExecutable: (file: string) => isExecutableFile(file, platform) }
  const [nodePath, npmPath] = await Promise.all([
    findCommand('node', lookup),
    findCommand('npm', lookup),
  ])
  if (!nodePath) return { nodeVersion: null, npmPath, nodePath }
  const nodeVersion = await new Promise<string | null>((resolve) => {
    execFile(
      nodePath,
      ['--version'],
      { env: env as NodeJS.ProcessEnv, timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
  })
  return { nodeVersion, npmPath, nodePath }
}

/** Huli: Kite's own Node.js install, as agents use it. */
export interface ManagedNode {
  version: string
  /** The folder that holds `node` and `npm`: the install's own on Windows, its `bin` elsewhere. */
  binDir: string
}

/**
 * Huli: whose Node.js agents run on. The user's own wins while it meets what the agents need,
 * unless Kite's is chosen; Kite's runs when the user's is missing or too old.
 */
export function chooseNode(
  system: NodeProbe,
  managed: boolean,
  choice: NodeChoice,
  required: string | null,
): 'system' | 'kite' | null {
  if (managed && choice === 'kite') return 'kite'
  if (system.nodePath && system.nodeVersion && systemSuitable(system, required)) return 'system'
  if (managed) return 'kite'
  return system.nodePath ? 'system' : null
}

function isInside(dir: string, file: string, platform: Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const relative = p.relative(dir, file)
  return relative !== '' && !relative.startsWith('..') && !p.isAbsolute(relative)
}

function systemSuitable(system: NodeProbe, required: string | null): boolean {
  if (!system.nodePath || !system.nodeVersion) return false
  return required === null || satisfiesNode(system.nodeVersion, required)
}

/**
 * Huli: the environment with Kite's Node.js folder first on PATH, under the name PATH already has
 * there (Windows' `Path`), and no second copy of the folder further on.
 */
export function withNodeBin(env: Env, binDir: string, platform: Platform): Env {
  const separator = platform === 'win32' ? ';' : ':'
  const p = platform === 'win32' ? path.win32 : path.posix
  const same = (entry: string): boolean => {
    const a = p.resolve(entry.replace(/^"(.*)"$/, '$1'))
    const b = p.resolve(binDir)
    return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  const key =
    (platform === 'win32'
      ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH' && env[name] !== undefined)
      : 'PATH') ?? 'PATH'
  const rest = (getEnv(env, 'PATH', platform) ?? '')
    .split(separator)
    .filter((entry) => entry !== '' && !same(entry))
  const out = { ...env }
  deleteEnv(out, 'PATH', platform)
  out[key] = [binDir, ...rest].join(separator)
  return out
}

/** Whether a `v24.1.0`-style version satisfies a `>=22`-style requirement. */
export function satisfiesNode(version: string, requirement: string): boolean {
  const have = /^v?(\d+)(?:\.(\d+))?/.exec(version.trim())
  const need = /^>=\s*(\d+)(?:\.(\d+))?/.exec(requirement.trim())
  if (!have || !need) return false
  const [haveMajor, haveMinor] = [Number(have[1]), Number(have[2] ?? 0)]
  const [needMajor, needMinor] = [Number(need[1]), Number(need[2] ?? 0)]
  return haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor)
}

export interface EnvironmentServiceDeps {
  platform: Platform
  nodeRuntime: NodeRuntime
  baseEnv: Env
  resolve?: (options: ResolveOptions) => Promise<ShellEnvironment>
  probe?: (env: Env, platform: Platform) => Promise<NodeProbe>
}

/** Huli: what decides whose Node.js agents run on, beside the user's own on PATH. */
export interface NodeSetup {
  managed: ManagedNode | null
  choice: NodeChoice
  /** What every built-in agent needs, such as `>=24.9.0`. */
  required: string | null
}

/** Huli: what Kite's own install says of itself, for `info().node`. */
export interface NodeInstallStatus {
  installable: boolean
  task: NodeTask | null
}

/**
 * Resolves the environment once, in the background, and caches it for the life of the
 * host. Agents wait for it; `reload` resolves it again. A read that fell back is tried again in
 * the background until the login shell answers, since one at a busy start can time out.
 */
export class EnvironmentService {
  private resolved: ShellEnvironment | null = null
  private node: NodeProbe = { nodeVersion: null, npmPath: null, nodePath: null }
  /** Huli: the user's own node on PATH, which `node` is unless Kite's runs instead. */
  private systemNode: NodeProbe = { nodeVersion: null, npmPath: null, nodePath: null }
  private nodeSetup: NodeSetup = { managed: null, choice: 'auto', required: null }
  private usingNode: 'system' | 'kite' | null = null
  private installStatus: () => NodeInstallStatus = () => ({ installable: false, task: null })
  private current: Promise<void> | null = null
  private proxy: ProxySettings = { mode: 'environment' }
  private configFolders: Partial<Record<AgentId, ConfigFolder>> = {}
  /** The port of an agent's node listener; null while it uses the system's network. */
  private nodePort: (agentId: AgentId) => number | null = () => null
  private resolvedAt: number | null = null
  private listeners = new Set<(info: EnvironmentInfo) => void>()
  private recoveredListeners = new Set<() => void>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0

  constructor(private readonly deps: EnvironmentServiceDeps) {}

  /** Starts resolving if nothing has yet; returns when the environment is known. */
  ready(): Promise<void> {
    this.current ??= this.run()
    return this.current
  }

  reload(): Promise<void> {
    this.retries = 0
    this.current = this.run()
    return this.current
  }

  private async run(): Promise<void> {
    const resolve = this.deps.resolve ?? resolveShellEnvironment
    this.resolved = await resolve({
      platform: this.deps.platform,
      nodeRuntime: this.deps.nodeRuntime,
      baseEnv: this.deps.baseEnv,
    })
    await this.probeNodes()
    this.resolvedAt = Date.now()
    this.notify()
    this.retryLater()
  }

  /**
   * Huli: finds the user's node on PATH, then picks whose agents run on; Kite's is probed with
   * its folder first on PATH, as agents get it. One that is gone leaves the user's in its place.
   */
  private async probeNodes(): Promise<void> {
    if (!this.resolved) return
    const { platform } = this.deps
    const probe = this.deps.probe ?? probeNode
    const env = this.resolved.env
    this.systemNode = await probe(env, platform)
    const { managed, choice, required } = this.nodeSetup
    const using = chooseNode(this.systemNode, managed !== null, choice, required)
    if (using !== 'kite' || !managed) {
      this.node = this.systemNode
      this.usingNode = using
      return
    }
    const node = await probe(withNodeBin(env, managed.binDir, platform), platform)
    const inside = node.nodePath !== null && isInside(managed.binDir, node.nodePath, platform)
    this.node = inside ? node : this.systemNode
    this.usingNode = inside ? 'kite' : this.systemNode.nodePath ? 'system' : null
  }

  /**
   * Huli: Kite's own Node.js or the choice changed. Probes again with the environment already
   * read, once any read under way is done, and tells the listeners.
   */
  async setNodeSetup(setup: Partial<NodeSetup>): Promise<void> {
    this.nodeSetup = { ...this.nodeSetup, ...setup }
    if (!this.current) return
    const next = this.current.then(
      () => this.probeNodes(),
      () => this.probeNodes(),
    )
    this.current = next
    await next
    this.notify()
  }

  /** Huli: where `info().node` takes the install's own state from. */
  setInstallStatus(status: () => NodeInstallStatus): void {
    this.installStatus = status
  }

  /** Tells the listeners what `info()` says now, as after Kite's install made progress. */
  notify(): void {
    const info = this.info()
    for (const listener of this.listeners) listener(info)
  }

  private retryLater(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.resolved?.source !== 'fallback') {
      this.retries = 0
      return
    }
    const delay = Math.min(RETRY_MS * 2 ** this.retries, MAX_RETRY_MS)
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.current = this.run().then(() => {
        if (this.resolved?.source === 'fallback') return
        for (const listener of this.recoveredListeners) listener()
      })
    }, delay)
    this.retryTimer.unref?.()
  }

  setProxy(proxy: ProxySettings): void {
    this.proxy = proxy
  }

  setNodeRoutes(port: (agentId: AgentId) => number | null): void {
    this.nodePort = port
  }

  setConfigFolders(folders: Partial<Record<AgentId, ConfigFolder>>): void {
    this.configFolders = folders
  }

  /**
   * The environment for agents and git: resolved, without Electron's variables, with the proxy.
   * An agent's own adds its configuration folder, and its node's listener in place of the proxy
   * while it uses one; git, commands and the terminal go without either.
   */
  agentEnv(agentId?: AgentId): Env {
    const { platform } = this.deps
    const resolved = this.resolved?.env ?? withoutElectronVars(this.deps.baseEnv, platform)
    // Huli: Kite's own Node.js runs as `node` and `npm` for agents, their installs and commands.
    const managed = this.usingNode === 'kite' ? this.nodeSetup.managed : null
    const base = managed ? withNodeBin(resolved, managed.binDir, platform) : resolved
    const port = agentId ? this.nodePort(agentId) : null
    const proxied =
      port === null ? applyProxy(base, this.proxy, platform) : applyNodeProxy(base, port, platform)
    // Worktrees sit a level deeper than their projects, which passes MAX_PATH sooner on Windows.
    const env = withLongPaths(proxied, platform)
    return agentId ? applyConfigFolder(env, this.configFolders[agentId], platform) : env
  }

  nodeProbe(): NodeProbe {
    return this.node
  }

  info(): EnvironmentInfo {
    const resolved = this.resolved
    return {
      source: resolved?.source ?? 'pending',
      shell: resolved?.shell ?? null,
      resolvedAt: this.resolvedAt,
      durationMs: resolved?.durationMs ?? null,
      warning: resolved?.warning ? translate(resolved.warning) : null,
      nodeVersion: this.node.nodeVersion,
      npmPath: this.node.npmPath,
      node: this.nodeInfo(),
    }
  }

  private nodeInfo(): NodeRuntimeInfo {
    const { managed, choice, required } = this.nodeSetup
    const system = this.systemNode
    const status = this.installStatus()
    return {
      using: this.usingNode,
      system: system.nodePath
        ? {
            path: system.nodePath,
            version: system.nodeVersion,
            suitable: systemSuitable(system, required),
          }
        : null,
      kite: managed ? { version: managed.version, path: managed.binDir } : null,
      choice,
      required,
      installable: status.installable,
      task: status.task,
    }
  }

  get(name: string, agentId?: AgentId): string | undefined {
    return getEnv(this.agentEnv(agentId), name, this.deps.platform)
  }

  onChange(listener: (info: EnvironmentInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A background read replaced a fallback with the login shell's environment. */
  onRecovered(listener: () => void): () => void {
    this.recoveredListeners.add(listener)
    return () => this.recoveredListeners.delete(listener)
  }
}

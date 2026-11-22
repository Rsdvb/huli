// Huli: the container tier. A sandboxed session's agent runs as a process inside a container of
// its own, which mounts the project folder alone (its `.git` read-only) and a home folder of the
// agent's own that never holds the user's sign-ins. Nothing of it runs until such a session starts:
// the engine is looked for then, the container starts with the session's agent and goes when the
// session lets its agent go. One image serves every agent and is never pulled without the user's
// yes; the agents' packages are installed once into a volume every container reads.
//
// Engines: Docker or Podman on the system; on Windows Docker Desktop's `docker`, else Docker inside
// WSL through `wsl.exe`. A project on a Windows drive is mounted through the engine's file share,
// which measured some two times slower for a build and seven for a search; see SANDBOX_MEASURED.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import type { Platform } from '@shared/platform'
import { SANDBOX_IMAGE_MB, type ContainerEngineKind, type ContainerStatus } from '@shared/sandbox'
import type { StdioTransport } from '../driver'
import { findCommand, isExecutableFile, type Env } from '../find-command'
import { EGRESS_HOST, EGRESS_PORT, EGRESS_SOURCE, TUNNEL_PORT } from './egress'
import { isEngineName } from './mounts'

/**
 * Node.js 22 on Debian 12, by the digest of its multi-platform index as Docker Hub served it on
 * 2026-11-22, so a pull always gets these bytes. 79.9 MB to download for amd64 and arm64.
 */
export const SANDBOX_IMAGE = {
  ref: 'docker.io/library/node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee',
  downloadMb: SANDBOX_IMAGE_MB.download,
  diskMb: SANDBOX_IMAGE_MB.disk,
} as const

/** Where every container finds the project, the agents' installs and the agent's home. */
export const WORKSPACE = '/workspace'
/** Huli: where a container finds the project's further folders, each in a folder of its own. */
export const FOLDERS = '/folders'
const TOOLS = '/tools'
const HOME = '/home/node'
const TOOLS_VOLUME = 'kite-sandbox-tools'
const AGENT_FOLDER = '/opt/kite/agent'
/** The image's own user, which the image's home belongs to. */
const IMAGE_USER = '1000:1000'

const ENGINE_MS = 15_000
const PULL_MS = 30 * 60_000
const INSTALL_MS = 10 * 60_000

export class ContainerError extends Error {
  constructor(
    message: string,
    readonly reason: 'engine' | 'image' | 'install' | 'mount' | 'network',
  ) {
    super(message)
    this.name = 'ContainerError'
  }
}

/** Runs a program to its end; injected so tests run without an engine. */
export type Exec = (
  file: string,
  args: string[],
  options: { env: Env; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>

export const nodeExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: options.env as NodeJS.ProcessEnv,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      },
    )
  })

/** An engine found: the program, the words before the engine's own, and how it names folders. */
export interface Engine {
  kind: ContainerEngineKind
  command: string
  prefix: string[]
  version: string | null
  /** The user containers run as, so the files they write in the project are the user's. */
  user: string
}

/** The engine's command line for `args`, through WSL when Docker lives there. */
export function engineCommand(engine: Engine, args: string[]): { file: string; args: string[] } {
  return { file: engine.command, args: [...engine.prefix, ...args] }
}

interface FindOptions {
  platform: Platform
  env: Env
  exec: Exec
  isExecutable?(file: string): Promise<boolean>
}

/**
 * The first engine that answers: Docker, then Podman, then on Windows Docker inside WSL. One found
 * whose service does not answer is `notRunning`, so the user starts it rather than install one.
 */
export async function findEngine(
  options: FindOptions,
): Promise<Engine | { problem: 'notFound' | 'notRunning' }> {
  const { platform, env, exec } = options
  const isExecutable = options.isExecutable ?? ((file) => isExecutableFile(file, platform))
  let found = false
  for (const kind of ['docker', 'podman'] as const) {
    const command = await findCommand(kind, { platform, env, isExecutable })
    if (!command) continue
    found = true
    const version = await serverVersion(exec, command, [], env)
    if (version !== undefined) {
      return { kind, command, prefix: [], version, user: await localUser(platform, kind) }
    }
  }
  if (platform === 'win32') {
    const wsl = await findCommand('wsl', { platform, env, isExecutable })
    if (wsl) {
      const prefix = ['-e', 'docker']
      const version = await serverVersion(exec, wsl, prefix, env)
      if (version !== undefined) {
        const user = await wslUser(exec, wsl, env)
        return { kind: 'wsl-docker', command: wsl, prefix, version, user }
      }
      // WSL is there; whether Docker is, a failed call cannot tell apart from a stopped one.
      return { problem: found ? 'notRunning' : 'notFound' }
    }
  }
  return { problem: found ? 'notRunning' : 'notFound' }
}

/** The service's version, null when it gives none, undefined when it does not answer. */
async function serverVersion(
  exec: Exec,
  command: string,
  prefix: string[],
  env: Env,
): Promise<string | null | undefined> {
  try {
    const { stdout } = await exec(
      command,
      [...prefix, 'version', '--format', '{{.Server.Version}}'],
      { env, timeoutMs: ENGINE_MS },
    )
    const version = stdout.trim()
    return /^[0-9A-Za-z.+_-]{1,64}$/.test(version) ? version : null
  } catch {
    return undefined
  }
}

async function localUser(platform: Platform, kind: 'docker' | 'podman'): Promise<string> {
  // Docker Desktop's file share and rootless Podman map every file to the user who runs them.
  if (platform !== 'linux' || kind === 'podman') return IMAGE_USER
  const info = os.userInfo()
  return info.uid >= 0 ? `${info.uid}:${info.gid}` : IMAGE_USER
}

async function wslUser(exec: Exec, wsl: string, env: Env): Promise<string> {
  try {
    const { stdout } = await exec(wsl, ['-e', 'id', '-u'], { env, timeoutMs: ENGINE_MS })
    const { stdout: group } = await exec(wsl, ['-e', 'id', '-g'], { env, timeoutMs: ENGINE_MS })
    const uid = stdout.trim()
    const gid = group.trim()
    return /^\d+$/.test(uid) && /^\d+$/.test(gid) ? `${uid}:${gid}` : IMAGE_USER
  } catch {
    return IMAGE_USER
  }
}

/** A Windows folder as WSL names it, by WSL's own `wslpath`, which knows its mount settings. */
export async function wslFolder(
  exec: Exec,
  wsl: string,
  folder: string,
  env: Env,
): Promise<string> {
  const { stdout } = await exec(wsl, ['-e', 'wslpath', '-a', '-u', folder], {
    env,
    timeoutMs: ENGINE_MS,
  })
  const out = stdout.trim()
  if (!out.startsWith('/') || /[\0\r\n]/.test(out)) {
    throw new ContainerError(`WSL could not name ${folder}`, 'mount')
  }
  return out
}

/** What a container for one session runs and mounts. */
export interface ContainerRun {
  name: string
  /** The owner label, which tells this Kite's containers from another copy's. */
  owner: string
  /** The project folder as the engine names it. */
  project: string
  /**
   * Whether the project has a `.git` folder that is mounted read-only over the writable project:
   * false where there is none, or where the user lets the sandbox commit.
   */
  gitDir: boolean
  /**
   * The engine's bridge, for a network held back in nothing; else the session's own network with
   * no way out, where the egress proxy beside it, at EGRESS_HOST, is the only way out.
   */
  network: { kind: 'open' } | { kind: 'egress'; name: string }
  user: string
  /** The agent's own home volume. */
  home: string
  /** Variables the container takes from the engine's environment, by name only. */
  env: string[]
  cpus: number
  memoryMb: number
  /** The command line inside the container. */
  command: string[]
  /** A folder of Kite's own the agent runs from, as a script's, mounted read-only. */
  agentFolder?: string
  /** Huli: the project's further folders, each mounted writable at its place under FOLDERS. */
  folders?: ContainerFolder[]
  podman?: boolean
}

/** Huli: a further folder of the project as a container mounts it. */
export interface ContainerFolder {
  /** The folder as the engine names it. */
  source: string
  /** Its place in the container, a folder of its own under FOLDERS. */
  target: string
  /** Whether its `.git` folder is mounted read-only over it, as the project's is. */
  gitDir: boolean
}

const FOLDER_TARGET = /^\/folders\/[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Huli: the places under FOLDERS of folders with these names: each name in lowercase letters,
 * digits, `.`, `_` and `-`, a number after one that is taken.
 */
export function folderTargets(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 56)
        .replace(/[-.]+$/, '') || 'folder'
    let target = `${FOLDERS}/${slug}`
    for (let n = 2; taken.has(target); n++) target = `${FOLDERS}/${slug}-${n}`
    taken.add(target)
    return target
  })
}

/**
 * The engine's `run` words for a session's container. It keeps stdin open for the agent's protocol,
 * is removed once its process ends, and holds no capability, no new privilege, a read-only root
 * with a private /tmp, and a cap on processes, memory and CPUs. No other folder of the computer and
 * no engine socket is mounted.
 */
export function runArgs(run: ContainerRun): string[] {
  const names = [run.name, run.home, ...(run.network.kind === 'egress' ? [run.network.name] : [])]
  for (const name of names) {
    if (!isEngineName(name)) throw new ContainerError(`Not a container name: ${name}`, 'mount')
  }
  const folders = run.folders ?? []
  for (const folder of [
    run.project,
    ...(run.agentFolder === undefined ? [] : [run.agentFolder]),
    ...folders.map((item) => item.source),
  ]) {
    if (/[,\0\r\n]/.test(folder)) {
      throw new ContainerError(`The folder cannot be mounted: ${folder}`, 'mount')
    }
  }
  for (const folder of folders) {
    if (!FOLDER_TARGET.test(folder.target)) {
      throw new ContainerError(`Not a place for a folder: ${folder.target}`, 'mount')
    }
  }
  const args = [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    run.name,
    '--label',
    'app.kite.sandbox=1',
    '--label',
    `app.kite.owner=${run.owner}`,
    '--network',
    run.network.kind === 'open' ? 'bridge' : run.network.name,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '1024',
    '--memory',
    `${run.memoryMb}m`,
    '--cpus',
    String(run.cpus),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=1g',
    ...(run.podman ? ['--userns', 'keep-id'] : ['--user', run.user]),
    '--mount',
    `type=bind,source=${run.project},target=${WORKSPACE}`,
    ...(run.gitDir
      ? ['--mount', `type=bind,source=${run.project}/.git,target=${WORKSPACE}/.git,readonly`]
      : []),
    '--mount',
    `type=volume,source=${TOOLS_VOLUME},target=${TOOLS},readonly`,
    '--mount',
    `type=volume,source=${run.home},target=${HOME}`,
    ...(run.agentFolder
      ? ['--mount', `type=bind,source=${run.agentFolder},target=${AGENT_FOLDER},readonly`]
      : []),
    ...folders.flatMap((folder) => [
      '--mount',
      `type=bind,source=${folder.source},target=${folder.target}`,
      ...(folder.gitDir
        ? [
            '--mount',
            `type=bind,source=${folder.source}/.git,target=${folder.target}/.git,readonly`,
          ]
        : []),
    ]),
    '-e',
    `HOME=${HOME}`,
    ...(run.network.kind === 'egress' ? proxyVariables() : []),
    ...run.env.flatMap((name) => ['-e', name]),
    '-w',
    WORKSPACE,
    SANDBOX_IMAGE.ref,
    ...run.command,
  ]
  return args
}

/**
 * The proxy variables of an agent behind the egress proxy, in both cases as programs read them,
 * and Node.js's switch that has its own requests follow them.
 */
function proxyVariables(): string[] {
  const url = `http://${EGRESS_HOST}:${EGRESS_PORT}`
  const values: [string, string][] = [
    ['HTTP_PROXY', url],
    ['HTTPS_PROXY', url],
    ['ALL_PROXY', url],
    ['NO_PROXY', 'localhost,127.0.0.1'],
  ]
  return [
    ...values.flatMap(([name, value]) => [
      '-e',
      `${name}=${value}`,
      '-e',
      `${name.toLowerCase()}=${value}`,
    ]),
    '-e',
    'NODE_USE_ENV_PROXY=1',
  ]
}

/** What a session's egress proxy lets through, and the session's names for it. */
export interface EgressRun {
  /** The proxy's container. */
  name: string
  /** The session's network with no way out. */
  network: string
  owner: string
  user: string
  mode: 'allow' | 'tunnel'
  /** For `allow`: the model's addresses. */
  allow: string[]
}

/**
 * The engine's `run` words for a session's egress proxy: on the engine's bridge, with nothing of
 * the computer mounted, no capability, a read-only root and a small cap. In `tunnel` mode its
 * tunnel port is published on the engine's loopback alone, and the token comes by name.
 */
export function egressArgs(run: EgressRun): string[] {
  for (const name of [run.name, run.network]) {
    if (!isEngineName(name)) throw new ContainerError(`Not a container name: ${name}`, 'mount')
  }
  const rules = run.allow.filter((rule) => /^(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/.test(rule))
  return [
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    run.name,
    '--label',
    'app.kite.sandbox=1',
    '--label',
    `app.kite.owner=${run.owner}`,
    '--network',
    'bridge',
    ...(run.mode === 'tunnel' ? ['-p', `127.0.0.1::${TUNNEL_PORT}`] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--read-only',
    '--user',
    run.user,
    '-e',
    `KITE_EGRESS_MODE=${run.mode}`,
    '-e',
    `KITE_EGRESS_ALLOW=${run.mode === 'allow' ? rules.join(',') : ''}`,
    ...(run.mode === 'tunnel' ? ['-e', 'KITE_EGRESS_TOKEN'] : []),
    SANDBOX_IMAGE.ref,
    'node',
    '-e',
    EGRESS_SOURCE,
  ]
}

/** A name of Kite's for an engine object, from ids that may hold other characters. */
export function engineName(prefix: string, id: string): string {
  const clean = id
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .slice(0, 60)
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8)
  return `${prefix}-${clean}-${hash}`
}

/** What a container runs for an agent: an npm package Kite installs, or a script. */
export type ContainerAgent =
  | { kind: 'package'; agentId: string; package: string; version: string; args: string[] }
  | { kind: 'script'; agentId: string; folder: string; file: string; args: string[] }

/** Runs a package's first bin as `npx` would, from the volume of installs, with the given args. */
const RUN_BIN = [
  "import{readFileSync as r}from'node:fs';import{pathToFileURL as u}from'node:url';",
  'const[,d,...a]=process.argv;',
  "const j=JSON.parse(r(d+'/package.json','utf8'));",
  "const b=typeof j.bin==='string'?j.bin:Object.values(j.bin??{})[0];",
  "if(!b)throw new Error('The package has no program');",
  "const f=d+'/'+b;process.argv=[process.argv[0],f,...a];await import(u(f).href)",
].join('')

/** Where an agent's package version is installed in the volume. */
export function installDir(agent: { agentId: string; version: string }): string {
  return `${TOOLS}/${engineName('agent', agent.agentId)}/${agent.version.replace(/[^0-9A-Za-z.+_-]/g, '-')}`
}

/** The command line inside the container. A script's folder is mounted at /opt/kite/agent. */
export function agentCommand(agent: ContainerAgent): string[] {
  if (agent.kind === 'script') return ['node', `${AGENT_FOLDER}/${agent.file}`, ...agent.args]
  const dir = `${installDir(agent)}/node_modules/${agent.package}`
  return ['node', '--input-type=module', '-e', RUN_BIN, dir, ...agent.args]
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/

/** The `run` words of the install of an agent's package into the volume, with the network on. */
export function installArgs(
  agent: Extract<ContainerAgent, { kind: 'package' }>,
  owner: string,
  user: string,
): string[] {
  if (!NPM_NAME.test(agent.package) || !VERSION.test(agent.version)) {
    throw new ContainerError(`Not an npm package: ${agent.package}@${agent.version}`, 'install')
  }
  return [
    'run',
    '--rm',
    '--label',
    'app.kite.sandbox=1',
    '--label',
    `app.kite.owner=${owner}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    user,
    '-e',
    'HOME=/tmp',
    '--mount',
    `type=volume,source=${TOOLS_VOLUME},target=${TOOLS}`,
    SANDBOX_IMAGE.ref,
    'npm',
    'install',
    '--prefix',
    installDir(agent),
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    `${agent.package}@${agent.version}`,
  ]
}

/** The share of the computer a container may use: half its cores and memory, at most 8 GB. */
export function containerLimits(
  cores: number,
  memoryBytes: number,
): { cpus: number; memoryMb: number } {
  const cpus = Math.max(1, Math.floor(cores / 2))
  const half = Math.floor(memoryBytes / 2 / (1024 * 1024))
  return { cpus, memoryMb: Math.max(1024, Math.min(8 * 1024, half)) }
}

/**
 * Maps the project's folder between the computer's name for it and the container's in every
 * string of a message: paths, and `file://` addresses. Everything else is left as it is.
 */
export function mapPaths(value: unknown, from: string, to: string, platform: Platform): unknown {
  return mapFolders(value, [[from, to]], to !== WORKSPACE, platform)
}

/**
 * Huli: `mapPaths` for several folders at once, such as the project's and its further folders':
 * each string by the first pair, longest folder first, that it lies in. `toHost` says which way.
 */
export function mapFolders(
  value: unknown,
  pairs: readonly (readonly [from: string, to: string])[],
  toHost: boolean,
  platform: Platform,
): unknown {
  const sep = toHost && platform === 'win32' ? '\\' : '/'
  const mappers = [...pairs]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => {
      const fromKey = platform === 'win32' && /^[a-zA-Z]:/.test(from) ? from.toLowerCase() : from
      const fromUri = fileUri(from)
      const toUri = fileUri(to)
      return (text: string): string | null => {
        const head = fromKey === from ? text : text.toLowerCase()
        if (head === fromKey || head.startsWith(fromKey + '/') || head.startsWith(fromKey + '\\')) {
          const rest = text.slice(from.length).replace(/[\\/]/g, sep)
          return to + rest
        }
        const uriKey = fromKey === from ? fromUri : fromUri.toLowerCase()
        if (head === uriKey || head.startsWith(uriKey + '/')) {
          return toUri + text.slice(fromUri.length)
        }
        return null
      }
    })
  const one = (text: string): string => {
    for (const map of mappers) {
      const mapped = map(text)
      if (mapped !== null) return mapped
    }
    return text
  }
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return one(item)
    if (Array.isArray(item)) return item.map(walk)
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v)]))
    }
    return item
  }
  return walk(value)
}

function fileUri(folder: string): string {
  const slashed = folder.replace(/\\/g, '/')
  return slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`
}

/** A stream of newline-framed JSON whose every message goes through `map`. */
function lineMapper(map: (message: unknown) => unknown): Transform {
  let rest = ''
  return new Transform({
    transform(chunk: Buffer | string, _encoding, done) {
      const text = rest + chunk.toString()
      const lines = text.split('\n')
      rest = lines.pop() ?? ''
      done(null, lines.map((line) => mapLine(line, map) + '\n').join(''))
    },
    flush(done) {
      done(null, rest === '' ? '' : mapLine(rest, map))
    },
  })
}

function mapLine(line: string, map: (message: unknown) => unknown): string {
  if (line.trim() === '') return line
  try {
    return JSON.stringify(map(JSON.parse(line)))
  } catch {
    return line
  }
}

/**
 * The agent's stdio with the project's folder named as the container names it on the way in and
 * as the computer names it on the way out, so the thread, its diffs and its links show real paths.
 */
export function mappedTransport(
  transport: StdioTransport,
  hostFolder: string,
  platform: Platform,
  folders: readonly { host: string; target: string }[] = [],
): StdioTransport {
  const inward: [string, string][] = [
    [hostFolder, WORKSPACE],
    ...folders.map((folder): [string, string] => [folder.host, folder.target]),
  ]
  const outward = inward.map(([host, inside]): [string, string] => [inside, host])
  // The computer's folder is matched as the computer compares names: without case on Windows.
  const toAgent = lineMapper((message) => mapFolders(message, inward, false, platform))
  const fromAgent = lineMapper((message) => mapFolders(message, outward, true, platform))
  toAgent.pipe(transport.stdin as NodeJS.WritableStream)
  ;(transport.stdout as NodeJS.ReadableStream).pipe(fromAgent)
  return { kind: 'stdio', stdin: toAgent, stdout: fromAgent }
}

/** The owner label of this Kite's containers: its data folder, hashed. */
export function ownerLabel(dataDir: string): string {
  return createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16)
}

export interface ContainerSandboxDeps {
  platform: Platform
  env(): Env
  dataDir: string
  exec?: Exec
  log(level: 'info' | 'warn', message: string): void
}

/**
 * The engine, the image and the containers of this Kite. Made on the first container session or
 * status request; looks for the engine once and again only after it failed.
 */
export class ContainerSandbox {
  private engine: Engine | null = null
  private finding: Promise<Engine | { problem: 'notFound' | 'notRunning' }> | null = null
  private pulling: Promise<void> | null = null
  private swept = false
  readonly owner: string
  private readonly exec: Exec

  constructor(private readonly deps: ContainerSandboxDeps) {
    this.owner = ownerLabel(deps.dataDir)
    this.exec = deps.exec ?? nodeExec
  }

  private async findEngine(): Promise<Engine | { problem: 'notFound' | 'notRunning' }> {
    if (this.engine) return this.engine
    this.finding ??= findEngine({
      platform: this.deps.platform,
      env: this.deps.env(),
      exec: this.exec,
    }).finally(() => (this.finding = null))
    const found = await this.finding
    if ('kind' in found) this.engine = found
    return found
  }

  async requireEngine(): Promise<Engine> {
    const found = await this.findEngine()
    if ('problem' in found) {
      throw new ContainerError(
        found.problem === 'notRunning' ? 'engineNotRunning' : 'engineNotFound',
        'engine',
      )
    }
    return found
  }

  async run(engine: Engine, args: string[], timeoutMs = ENGINE_MS): Promise<string> {
    const { file, args: words } = engineCommand(engine, args)
    const { stdout } = await this.exec(file, words, { env: this.deps.env(), timeoutMs })
    return stdout
  }

  private async imagePresent(engine: Engine): Promise<boolean> {
    return (await this.imageBytes(engine)) !== null
  }

  /** What the image takes on disk as the engine reports it; null while it is not there. */
  private async imageBytes(engine: Engine): Promise<number | null> {
    try {
      const out = await this.run(engine, [
        'image',
        'inspect',
        '--format',
        '{{.Size}}',
        SANDBOX_IMAGE.ref,
      ])
      const bytes = Number(out.trim())
      return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
    } catch {
      return null
    }
  }

  async status(): Promise<ContainerStatus> {
    const found = await this.findEngine()
    const image = {
      ref: SANDBOX_IMAGE.ref,
      present: false,
      downloadMb: SANDBOX_IMAGE.downloadMb,
      diskMb: SANDBOX_IMAGE.diskMb,
    }
    if ('problem' in found) {
      this.engine = null
      return { engine: null, engineProblem: found.problem, image, pulling: false }
    }
    const bytes = await this.imageBytes(found)
    return {
      engine: { kind: found.kind, version: found.version },
      image: {
        ...image,
        present: bytes !== null,
        ...(bytes ? { diskMb: Math.round(bytes / 1e6) } : {}),
      },
      pulling: this.pulling !== null,
    }
  }

  /** Downloads the image, which the window asked the user about with its size first. */
  async pull(): Promise<ContainerStatus> {
    const engine = await this.requireEngine()
    this.pulling ??= this.run(engine, ['pull', SANDBOX_IMAGE.ref], PULL_MS)
      .then(() => this.deps.log('info', `Pulled the sandbox image ${SANDBOX_IMAGE.ref}`))
      .finally(() => (this.pulling = null))
    await this.pulling
    return this.status()
  }

  /** Removes the image and the agents' installs; a running container keeps the image in use. */
  async remove(): Promise<ContainerStatus> {
    const engine = await this.requireEngine()
    await this.run(engine, ['image', 'rm', SANDBOX_IMAGE.ref]).catch(() => '')
    await this.run(engine, ['volume', 'rm', TOOLS_VOLUME]).catch(() => '')
    return this.status()
  }

  /**
   * What a session's container needs before it starts: the engine, the image, the volumes owned by
   * the container's user and the agent's package. Containers this Kite left behind, as after a
   * crash, go first.
   */
  async prepare(agent: ContainerAgent): Promise<Engine> {
    const engine = await this.requireEngine()
    if (!(await this.imagePresent(engine))) throw new ContainerError('imageMissing', 'image')
    if (!this.swept) {
      this.swept = true
      await this.sweep(engine)
    }
    await this.ownedVolume(engine, TOOLS_VOLUME, TOOLS)
    await this.ownedVolume(engine, engineName('kite-sandbox-home', agent.agentId), HOME)
    if (agent.kind === 'package') await this.install(engine, agent)
    return engine
  }

  /** A volume that exists and belongs to the containers' user. */
  private async ownedVolume(engine: Engine, name: string, target: string): Promise<void> {
    const exists = await this.run(engine, [
      'volume',
      'inspect',
      '--format',
      '{{.Name}}',
      name,
    ]).then(
      () => true,
      () => false,
    )
    if (exists) return
    await this.run(engine, ['volume', 'create', '--label', `app.kite.owner=${this.owner}`, name])
    if (engine.kind === 'podman') return
    // A new volume belongs to root; only `chown` runs as root, with no other capability.
    await this.run(engine, [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--mount',
      `type=volume,source=${name},target=${target}`,
      SANDBOX_IMAGE.ref,
      'chown',
      engine.user,
      target,
    ])
  }

  private async install(
    engine: Engine,
    agent: Extract<ContainerAgent, { kind: 'package' }>,
  ): Promise<void> {
    const manifest = `${installDir(agent)}/node_modules/${agent.package}/package.json`
    const installed = await this.run(engine, [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--mount',
      `type=volume,source=${TOOLS_VOLUME},target=${TOOLS},readonly`,
      SANDBOX_IMAGE.ref,
      'test',
      '-f',
      manifest,
    ]).then(
      () => true,
      () => false,
    )
    if (installed) return
    this.deps.log('info', `Installing ${agent.package}@${agent.version} into the sandbox volume`)
    try {
      await this.run(engine, installArgs(agent, this.owner, engine.user), INSTALL_MS)
    } catch (error) {
      throw new ContainerError(
        `${agent.package}@${agent.version}: ${String((error as { stderr?: string }).stderr ?? error).slice(-400)}`,
        'install',
      )
    }
  }

  /** The project's folder as the engine names it. */
  async engineFolder(engine: Engine, folder: string): Promise<string> {
    if (engine.kind === 'wsl-docker')
      return wslFolder(this.exec, engine.command, folder, this.deps.env())
    // Docker Desktop takes Windows paths with forward slashes in a mount.
    return this.deps.platform === 'win32' ? folder.replace(/\\/g, '/') : folder
  }

  /** Removes a container that may still be there, as after a stop that did not end it. */
  async removeContainer(name: string): Promise<void> {
    const engine = this.engine
    if (!engine || !isEngineName(name)) return
    await this.run(engine, ['rm', '-f', name]).catch(() => '')
  }

  private async sweep(engine: Engine): Promise<void> {
    const filter = ['--filter', `label=app.kite.owner=${this.owner}`]
    const ids = (out: string): string[] =>
      out.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/.test(id))
    try {
      const containers = ids(await this.run(engine, ['ps', '-aq', ...filter]))
      if (containers.length > 0) await this.run(engine, ['rm', '-f', ...containers])
      const networks = ids(await this.run(engine, ['network', 'ls', '-q', ...filter]))
      if (networks.length > 0) await this.run(engine, ['network', 'rm', ...networks])
    } catch (error) {
      this.deps.log('warn', `Could not remove old sandbox containers: ${String(error)}`)
    }
  }

  /**
   * The session's network with no way out and its egress proxy on it, under the alias the agent's
   * proxy variables name. In `tunnel` mode, also the port on 127.0.0.1 the agent host dials into.
   * Whatever of it started is removed again when a step fails.
   */
  async startEgress(
    engine: Engine,
    run: Omit<EgressRun, 'owner' | 'user'>,
    env: Env,
  ): Promise<{ tunnelPort: number | null }> {
    try {
      await this.run(engine, [
        'network',
        'create',
        '--internal',
        '--label',
        'app.kite.sandbox=1',
        '--label',
        `app.kite.owner=${this.owner}`,
        run.network,
      ])
      const args = egressArgs({ ...run, owner: this.owner, user: engine.user })
      const { file, args: words } = engineCommand(engine, args)
      const names = run.mode === 'tunnel' ? ['KITE_EGRESS_TOKEN'] : []
      await this.exec(file, words, {
        env: this.engineEnv(engine, env, names),
        timeoutMs: ENGINE_MS,
      })
      await this.run(engine, ['network', 'connect', '--alias', EGRESS_HOST, run.network, run.name])
      if (run.mode !== 'tunnel') return { tunnelPort: null }
      const published = await this.run(engine, ['port', run.name, `${TUNNEL_PORT}/tcp`])
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(published)?.[1])
      if (!Number.isInteger(port) || port <= 0) throw new Error(`No tunnel port: ${published}`)
      return { tunnelPort: port }
    } catch (error) {
      await this.stopEgress(run.name, run.network)
      throw new ContainerError(
        `The sandbox network did not start: ${String((error as { stderr?: string }).stderr ?? error).slice(-300)}`,
        'network',
      )
    }
  }

  async stopEgress(name: string, network: string): Promise<void> {
    const engine = this.engine
    if (!engine || !isEngineName(name) || !isEngineName(network)) return
    await this.run(engine, ['rm', '-f', name]).catch(() => '')
    await this.run(engine, ['network', 'rm', network]).catch(() => '')
  }

  /** The environment of the engine's program, with the named variables passed on into WSL. */
  engineEnv(engine: Engine, env: Env, names: string[]): Env {
    if (engine.kind !== 'wsl-docker' || names.length === 0) return env
    const before = env.WSLENV ? env.WSLENV.split(':').filter(Boolean) : []
    return { ...env, WSLENV: [...new Set([...before, ...names])].join(':') }
  }
}

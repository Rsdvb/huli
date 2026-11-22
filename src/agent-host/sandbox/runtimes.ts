// Huli: an agent process of a session's own, inside its container. It speaks the agent's protocol
// over the container's stdio with the project's folder renamed on the way, and is stopped with the
// session: EOF first, then the engine removes whatever is left of the container.

import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { AgentLauncher, AgentRuntime, LaunchedAgent, LaunchOutput } from '../agents'
import type { AgentDefinition, LaunchSpec } from '../catalog'
import type { AgentConnection, ConnectionHooks } from '../connection'
import type { ProcessDriver, StdioTransport } from '../driver'
import type { Env } from '../find-command'
import {
  agentCommand,
  containerLimits,
  ContainerError,
  engineCommand,
  engineName,
  folderTargets,
  mappedTransport,
  runArgs,
  type ContainerAgent,
  type ContainerSandbox,
} from './container'
import { projectMount } from './mounts'
import { EgressTunnel } from './tunnel'

export interface ContainerStart {
  sessionId: string
  agentId: AgentId
  def: AgentDefinition
  agent: ContainerAgent
  /** The session's folder on the computer. */
  folder: string
  /**
   * Huli: the project's further folders on the computer, each mounted as the session's folder is,
   * after the same checks; one that fails them refuses the start.
   */
  folders?: readonly string[]
  /**
   * `model`: out only to the model's addresses; `agent`: out only through the agent's listener of
   * Agent 网络, at `proxyPort`; `open`: the engine's bridge.
   */
  network: 'model' | 'agent' | 'open'
  /** The model's addresses `model` lets through; empty refuses the start. */
  modelHosts: string[]
  /** The port of the agent's listener of Agent 网络; null refuses `agent`. */
  proxyPort: number | null
  /** The project's `.git` stays writable, as the user let the sandbox commit. */
  gitWritable: boolean
  /** The environment of the engine's program, which holds the values of `keyNames`. */
  env: Env
  /** The variables of the agent's API key that Kite holds, which the container gets by name. */
  keyNames: string[]
  platform: Platform
  /** Kite's data folder, which is never mounted. */
  dataDir: string
  launcher: AgentLauncher
  driver: ProcessDriver
  hooks: ConnectionHooks
  output: LaunchOutput
  appVersion: string
  initializeMs: number
  containers: ContainerSandbox
}

export interface ContainerRuntime {
  readonly runtime: AgentRuntime
  readonly launched: LaunchedAgent
  readonly name: string
  stop(): Promise<void>
}

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export async function startContainerRuntime(start: ContainerStart): Promise<ContainerRuntime> {
  const { containers, platform } = start
  const mountContext = {
    platform,
    home: os.homedir(),
    dataDir: start.dataDir,
    realpath: (value: string) => realpath(value),
  }
  const folder = await projectMount(start.folder, mountContext)
  const further: string[] = []
  for (const item of start.folders ?? []) further.push(await projectMount(item, mountContext))
  if (start.network === 'model' && start.modelHosts.length === 0) {
    throw new ContainerError('noModelHosts', 'network')
  }
  if (start.network === 'agent' && start.proxyPort === null) {
    throw new ContainerError('noExit', 'network')
  }
  const engine = await containers.prepare(start.agent)
  const project = await containers.engineFolder(engine, folder)
  const hasGitDir = (at: string): Promise<boolean> =>
    stat(path.join(at, '.git')).then(
      (info) => info.isDirectory(),
      () => false,
    )
  const gitDir = !start.gitWritable && (await hasGitDir(folder))
  const targets = folderTargets(further.map((item) => path.basename(item)))
  const folders = await Promise.all(
    further.map(async (item, i) => ({
      host: item,
      source: await containers.engineFolder(engine, item),
      target: targets[i]!,
      gitDir: !start.gitWritable && (await hasGitDir(item)),
    })),
  )
  const keyNames = start.keyNames.filter((name) => KEY_NAME.test(name) && start.env[name])
  const name = engineName('kite-sbx', start.sessionId)
  const command = agentCommand(start.agent)
  const agentFolder =
    start.agent.kind === 'script'
      ? await containers.engineFolder(engine, start.agent.folder)
      : undefined
  const egress =
    start.network === 'open'
      ? null
      : {
          name: engineName('kite-sbx-egress', start.sessionId),
          network: engineName('kite-sbx-net', start.sessionId),
          mode: start.network === 'model' ? ('allow' as const) : ('tunnel' as const),
          allow: start.network === 'model' ? start.modelHosts : [],
        }
  const token = randomBytes(24).toString('hex')
  let tunnel: EgressTunnel | null = null
  if (egress) {
    const { tunnelPort } = await containers.startEgress(engine, egress, {
      ...start.env,
      KITE_EGRESS_TOKEN: token,
    })
    if (tunnelPort !== null && start.proxyPort !== null) {
      tunnel = new EgressTunnel({ port: tunnelPort, token, upstream: start.proxyPort })
    }
  }
  const args = runArgs({
    name,
    owner: containers.owner,
    project,
    gitDir,
    network: egress ? { kind: 'egress', name: egress.network } : { kind: 'open' },
    user: engine.user,
    home: engineName('kite-sandbox-home', start.agentId),
    env: keyNames,
    ...containerLimits(os.cpus().length, os.totalmem()),
    command,
    ...(agentFolder ? { agentFolder } : {}),
    ...(folders.length > 0
      ? { folders: folders.map(({ source, target, gitDir }) => ({ source, target, gitDir })) }
      : {}),
    podman: engine.kind === 'podman',
  })
  const line = engineCommand(engine, args)
  const spec: LaunchSpec = {
    command: line.file,
    args: line.args,
    env: {},
    shell: false,
    display: { command: line.file, args: line.args, env: {} },
  }
  const env = containers.engineEnv(engine, start.env, keyNames)
  const unwind = async (): Promise<void> => {
    tunnel?.stop()
    if (egress) await containers.stopEgress(egress.name, egress.network)
  }
  let launched: LaunchedAgent
  try {
    launched = start.launcher.launch(start.def, spec, env, start.output)
  } catch (error) {
    await unwind()
    throw error
  }
  if (launched.transport.kind !== 'stdio') {
    await launched.stop()
    await unwind()
    throw new ContainerError('The agent does not speak over its stdio', 'engine')
  }
  const transport: StdioTransport = mappedTransport(launched.transport, folder, platform, folders)
  const connection: AgentConnection = start.driver.connect(transport, {
    def: start.def,
    hooks: start.hooks,
    spec,
    env,
  })
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = async (): Promise<void> => {
    connection.close()
    await launched.stop()
    await containers.removeContainer(name)
    await unwind()
  }
  try {
    const init = await Promise.race([
      connection.initialize(start.appVersion, abort.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(new ContainerError('The agent in its container did not answer', 'engine'))
        }, start.initializeMs)
      }),
      launched.exited.then((info): never => {
        throw new ContainerError(
          `The container ended before the agent answered (${info.error ?? `code ${String(info.code)}`})`,
          'engine',
        )
      }),
    ])
    // Kite's own MCP servers run on the computer, out of the container's reach.
    const runtime: AgentRuntime = { agentId: start.agentId, connection, init, kettu: false }
    return { runtime, launched, name, stop }
  } catch (error) {
    await stop().catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

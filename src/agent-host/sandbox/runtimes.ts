// Huli: an agent process of a session's own, inside its container. It speaks the agent's protocol
// over the container's stdio with the project's folder renamed on the way, and is stopped with the
// session: EOF first, then the engine removes whatever is left of the container.

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
  mappedTransport,
  runArgs,
  type ContainerAgent,
  type ContainerSandbox,
} from './container'
import { projectMount } from './mounts'

export interface ContainerStart {
  sessionId: string
  agentId: AgentId
  def: AgentDefinition
  agent: ContainerAgent
  /** The session's folder on the computer. */
  folder: string
  network: 'none' | 'open'
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
  const folder = await projectMount(start.folder, {
    platform,
    home: os.homedir(),
    dataDir: start.dataDir,
    realpath: (value) => realpath(value),
  })
  const engine = await containers.prepare(start.agent)
  const project = await containers.engineFolder(engine, folder)
  const gitDir = await stat(path.join(folder, '.git')).then(
    (info) => info.isDirectory(),
    () => false,
  )
  const keyNames = start.keyNames.filter((name) => KEY_NAME.test(name) && start.env[name])
  const name = engineName('kite-sbx', start.sessionId)
  const command = agentCommand(start.agent)
  const agentFolder =
    start.agent.kind === 'script'
      ? await containers.engineFolder(engine, start.agent.folder)
      : undefined
  const args = runArgs({
    name,
    owner: containers.owner,
    project,
    gitDir,
    network: start.network,
    user: engine.user,
    home: engineName('kite-sandbox-home', start.agentId),
    env: keyNames,
    ...containerLimits(os.cpus().length, os.totalmem()),
    command,
    ...(agentFolder ? { agentFolder } : {}),
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
  const launched = start.launcher.launch(start.def, spec, env, start.output)
  if (launched.transport.kind !== 'stdio') {
    await launched.stop()
    throw new ContainerError('The agent does not speak over its stdio', 'engine')
  }
  const transport: StdioTransport = mappedTransport(launched.transport, folder, platform)
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

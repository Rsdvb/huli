// Huli: the agents' network. Owns mihomo as a child of the agent host, writes its configuration,
// picks each group's node through its API, and gives each agent that uses a node the port of its
// own listener. It fails closed: an agent that uses a node gets only its listener in its proxy
// variables, so while mihomo is stopped, starting, restarting or crashed, or its node is missing
// or down, that agent's requests are refused or rejected, never sent another way. Huli's own; see
// tools/huli/README.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, constants, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import {
  agentRoute,
  cleanSubscriptionName,
  isSubscriptionName,
  MAX_SUBSCRIPTIONS,
  type AgentNetworkAgent,
  type AgentNetworkProblem,
  type AgentNetworkSettings,
  type AgentNetworkState,
  type AgentNetworkStatus,
  type LatencyResult,
  type NodeRef,
  type NodeView,
  type SubscriptionUsage,
} from '@shared/agent-network'
import { addLogSecret, removeLogSecret, redactLogText } from '@shared/log/process-log'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { HostError, invalidParams, notFound } from '../errors'
import type { JsonFile, LogFn } from '../storage'
import { MihomoApi } from './api'
import {
  agentGroup,
  DEFAULT_GROUP,
  mihomoConfig,
  nodePrefix,
  providerName,
  serializeConfig,
  subscriptionOfProvider,
  TEST_URL,
} from './config'
import {
  isSubscriptionUrl,
  networkFolder,
  subscriptionHost,
  subscriptionSecrets,
  type NetworkStateFile,
  type StoredSubscription,
  type SubscriptionsFile,
} from './files'
import { detectInterface } from './interface'

/** How often the interface is read again and the groups' nodes checked, while on. */
const CHECK_MS = 60_000
/** How long mihomo has to answer its API after it starts. */
const START_MS = 20_000
const MIN_RESTART_MS = 2_000
const MAX_RESTART_MS = 60_000
/** A run this long counts as healthy, so the next crash restarts it at once again. */
const HEALTHY_MS = 60_000
const LATENCY_TIMEOUT_MS = 5_000
const LATENCY_PARALLEL = 8
const PORT_MIN = 20_000
const PORT_SPAN = 40_000

export interface NodeProxyDeps {
  userDataPath: string
  platform: Platform
  /** The `mihomo` program the app ships; null on a host without one, as the daemon. */
  mihomoPath: string | null
  log: LogFn
  subscriptions: JsonFile<SubscriptionsFile>
  state: JsonFile<NetworkStateFile>
  settings(): AgentNetworkSettings
  /** The agents of the host, which each get a listener while they use a node. */
  agentIds(): AgentId[]
  /** The status changed; it goes to the host's own windows only. */
  changed(status: AgentNetworkStatus): void
  /** The proxy variables these agents start with changed. */
  routesChanged(agentIds: AgentId[]): void
  detect?: (platform: Platform) => Promise<string | null>
}

interface Running {
  child: ChildProcess
  api: MihomoApi
  config: string
  startedAt: number
  /** Set when the host stops it on purpose, so its exit is no crash. */
  stopping: boolean
  exited: Promise<void>
}

interface ProviderState {
  nodes: number
  updatedAt: number | null
  usage: SubscriptionUsage | null
}

/** A port on 127.0.0.1 that nothing listens on now; 0 asks the system for one. */
function freePort(port = 0): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(null))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address()
      const got = typeof address === 'object' && address ? address.port : null
      server.close(() => resolve(got))
    })
  })
}

function randomPort(taken: ReadonlySet<number>): number {
  for (;;) {
    const port = PORT_MIN + (randomBytes(4).readUInt32BE(0) % PORT_SPAN)
    if (!taken.has(port)) return port
  }
}

/** The environment mihomo starts with: enough to run, and no proxy variable it could follow. */
function mihomoEnv(platform: Platform): NodeJS.ProcessEnv {
  const names =
    platform === 'win32'
      ? ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']
      : ['HOME', 'TMPDIR', 'LANG']
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const time = Date.parse(value)
  // mihomo writes the zero time for a provider it never read.
  return Number.isFinite(time) && time > 0 ? time : null
}

export class NodeProxy {
  private subscriptions: StoredSubscription[] = []
  private ports: Partial<Record<AgentId, number>> = {}
  private running: Running | null = null
  private state: AgentNetworkState = 'off'
  private problem: AgentNetworkProblem | null = null
  private detail: string | null = null
  private version: string | null = null
  private available = false
  private detected: string | null = null
  private inUse: string | null = null
  private providers = new Map<string, ProviderState>()
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private sent = ''
  private closed = false
  /** The running mihomo as the state file keeps it. */
  private record: NetworkStateFile['running'] = null

  constructor(private readonly deps: NodeProxyDeps) {}

  private get folder(): string {
    return networkFolder(this.deps.userDataPath)
  }

  async load(): Promise<void> {
    const [subscriptions, state] = await Promise.all([
      this.deps.subscriptions.load(),
      this.deps.state.load(),
    ])
    this.subscriptions = subscriptions.subscriptions
    for (const s of this.subscriptions) this.addSecrets(s.url)
    this.ports = state.ports
    this.available =
      this.deps.mihomoPath !== null &&
      (await access(this.deps.mihomoPath, constants.X_OK).then(
        () => true,
        () => false,
      ))
    if (state.running) await this.stopLeftover(state.running)
    await this.ensurePorts()
  }

  /** Starts mihomo when the settings say so, and checks its interface from then on. */
  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_MS)
    this.timer.unref?.()
    this.reconcile()
  }

  /** The port of the agent's listener while it uses a node; null for the system's network. */
  portFor(agentId: AgentId): number | null {
    if (agentRoute(this.deps.settings(), agentId) === null) return null
    // A harness no agent of the host runs on, as it is detected, is no agent's traffic.
    if (!this.deps.agentIds().includes(agentId)) return null
    const known = this.ports[agentId]
    if (known !== undefined) return known
    // Picked before the free check, which every start of mihomo makes and which moves the agent
    // if the port is taken; an agent never goes without a listener port.
    const port = randomPort(new Set(Object.values(this.ports) as number[]))
    this.ports[agentId] = port
    this.saveState()
    return port
  }

  /** The settings or the agents changed: the agents whose proxy variables change, then applies. */
  async settingsChanged(before: AgentNetworkSettings, agentIds: AgentId[]): Promise<void> {
    const after = this.deps.settings()
    const moved = agentIds.filter(
      (id) => (agentRoute(before, id) === null) !== (agentRoute(after, id) === null),
    )
    await this.ensurePorts()
    if (moved.length > 0) this.deps.routesChanged(moved)
    this.reconcile()
  }

  status(): AgentNetworkStatus {
    const settings = this.deps.settings()
    const agents: AgentNetworkAgent[] = this.usingAgents().map((agentId) => {
      const route = agentRoute(settings, agentId)
      return {
        agentId,
        port: this.ports[agentId] ?? null,
        node: route === null || route === 'default' ? null : route,
      }
    })
    return {
      available: this.available,
      enabled: settings.enabled,
      state: this.state,
      problem: this.problem,
      detail: this.detail,
      version: this.version,
      interface: { inUse: this.inUse, detected: this.detected, override: settings.interface },
      subscriptions: this.subscriptions.map((s) => {
        const provider = this.providers.get(s.id)
        return {
          id: s.id,
          name: s.name,
          host: subscriptionHost(s.url),
          nodes: provider?.nodes ?? null,
          updatedAt: provider?.updatedAt ?? null,
          usage: provider?.usage ?? null,
        }
      }),
      agents,
    }
  }

  async nodes(): Promise<NodeView[]> {
    const api = this.running?.api
    if (!api || this.state !== 'running') return []
    const providers = await api.providers()
    this.readProviders(providers)
    const order = new Map(this.subscriptions.map((s, index) => [s.id, index]))
    return providers
      .flatMap((provider) => {
        const id = subscriptionOfProvider(provider.name)
        const sub = id ? this.subscriptions.find((s) => s.id === id) : undefined
        if (!sub) return []
        const prefix = nodePrefix(sub.name)
        return provider.proxies.map((proxy) => ({
          subscription: sub.id,
          node: proxy.name.startsWith(prefix) ? proxy.name.slice(prefix.length) : proxy.name,
          type: proxy.type,
          delay: proxy.delay ?? null,
        }))
      })
      .sort((a, b) => (order.get(a.subscription) ?? 0) - (order.get(b.subscription) ?? 0))
  }

  async addSubscription(name: string, url: string): Promise<{ id: string }> {
    const clean = this.checkedName(name, null)
    if (!isSubscriptionUrl(url)) throw invalidParams('url must be an http or https address')
    if (this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      throw new HostError('conflict', `There are ${MAX_SUBSCRIPTIONS} subscriptions already`)
    }
    const id = randomBytes(6).toString('hex')
    this.addSecrets(url)
    this.subscriptions = [...this.subscriptions, { id, name: clean, url, addedAt: Date.now() }]
    await this.saveSubscriptions()
    this.reconcile()
    return { id }
  }

  async renameSubscription(id: string, name: string): Promise<void> {
    const sub = this.find(id)
    const clean = this.checkedName(name, id)
    if (clean === sub.name) return
    this.subscriptions = this.subscriptions.map((s) => (s.id === id ? { ...s, name: clean } : s))
    await this.saveSubscriptions()
    this.reconcile()
  }

  async removeSubscription(id: string): Promise<void> {
    const sub = this.find(id)
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id)
    this.providers.delete(id)
    await this.saveSubscriptions()
    this.reconcile()
    await this.queue
    for (const secret of subscriptionSecrets(sub.url)) {
      if (!this.subscriptions.some((s) => s.url.includes(secret))) removeLogSecret(secret)
    }
  }

  /** Reads one subscription again, or every one with null. */
  async refresh(id: string | null): Promise<void> {
    const ids = id === null ? this.subscriptions.map((s) => s.id) : [this.find(id).id]
    const api = this.liveApi()
    const failed: string[] = []
    await Promise.all(
      ids.map((subId) =>
        api.updateProvider(providerName(subId)).catch((error: unknown) => {
          failed.push(this.masked((error as Error).message))
        }),
      ),
    )
    this.readProviders(await api.providers().catch(() => null))
    await this.applySelections()
    this.emit()
    if (failed.length > 0) throw new HostError('unavailable', failed.join('; '))
  }

  async testLatency(nodes: NodeRef[] | null): Promise<LatencyResult[]> {
    const api = this.liveApi()
    const wanted =
      nodes ?? (await this.nodes()).map(({ subscription, node }) => ({ subscription, node }))
    const results: LatencyResult[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < wanted.length) {
        const ref = wanted[next++]!
        const name = this.fullName(ref)
        const delay = name ? await api.delay(name, TEST_URL, LATENCY_TIMEOUT_MS) : null
        results.push({ ...ref, delay })
      }
    }
    await Promise.all(Array.from({ length: LATENCY_PARALLEL }, worker))
    return results
  }

  async shutdown(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    await this.queue.catch(() => {})
    await this.stopChild()
    await Promise.all([this.deps.state.flush(), this.deps.subscriptions.flush()])
  }

  // Applying the settings.

  /** Runs `apply` after whatever runs now, so starts and stops never overlap. */
  private reconcile(): void {
    this.queue = this.queue
      .then(() => this.apply())
      .catch(async (error: unknown) => {
        const said = this.masked((error as Error).message)
        this.deps.log('error', `Agent network: ${said}`)
        // Whatever failed, no mihomo half set up stays, and the start is tried again.
        await this.stopChild().catch(() => {})
        if (this.closed || !this.deps.settings().enabled) return
        this.setState('error', 'start', said)
        this.restartLater(0)
      })
  }

  private async check(): Promise<void> {
    if (!this.deps.settings().enabled || this.closed) return
    const before = this.detected
    await this.detect()
    if (this.detected !== before && this.deps.settings().interface === null) {
      this.deps.log('info', `Agent network: the interface is now ${this.detected ?? 'none'}`)
      this.reconcile()
      return
    }
    if (this.running && this.state === 'running') {
      this.readProviders(await this.running.api.providers().catch(() => null))
      await this.applySelections().catch(() => {})
      this.emit()
    }
  }

  private async detect(): Promise<void> {
    try {
      this.detected = await (this.deps.detect ?? detectInterface)(this.deps.platform)
    } catch (error) {
      this.deps.log(
        'warn',
        `Agent network: could not read the default route: ${(error as Error).message}`,
      )
      this.detected = null
    }
  }

  private async apply(): Promise<void> {
    if (this.closed) return
    const settings = this.deps.settings()
    if (!settings.enabled) {
      await this.stopChild()
      this.setState('off', null, null)
      return
    }
    if (!this.available) {
      await this.stopChild()
      this.setState('error', 'missing', null)
      return
    }
    // Read once here; the regular check reads it again and applies a change.
    if (this.detected === null) await this.detect()
    const networkInterface = settings.interface ?? this.detected
    if (!networkInterface) {
      await this.stopChild()
      this.inUse = null
      this.setState('error', 'interface', null)
      return
    }
    const agents = this.usingAgents()
    const config = this.configText(networkInterface, agents, 0, '')
    if (this.running && this.running.config === config && this.state === 'running') {
      await this.applySelections()
      this.emit()
      return
    }
    await this.stopChild()
    await this.startChild(networkInterface, agents)
  }

  /** The configuration without its controller, to tell whether a change needs a new mihomo. */
  private configText(
    networkInterface: string,
    agents: AgentId[],
    controllerPort: number,
    secret: string,
  ): string {
    return serializeConfig(
      mihomoConfig({
        controllerPort,
        secret,
        networkInterface,
        subscriptions: this.subscriptions,
        agents: agents.map((agentId) => ({ agentId, port: this.ports[agentId]! })),
      }),
    )
  }

  private async startChild(networkInterface: string, agents: AgentId[]): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.inUse = networkInterface
    this.setState('starting', null, null)
    await this.freeListenerPorts(agents)
    const controllerPort = await freePort()
    if (controllerPort === null) throw new Error('no free port for the controller')
    const secret = randomBytes(24).toString('hex')
    addLogSecret(secret)
    const home = path.join(this.folder, 'mihomo')
    await mkdir(path.join(home, 'providers'), { recursive: true })
    const configFile = path.join(home, 'config.yaml')
    // The configuration holds the subscriptions' addresses: readable by the user alone.
    await writeFile(configFile, this.configText(networkInterface, agents, controllerPort, secret), {
      mode: 0o600,
    })
    const child = spawn(this.deps.mihomoPath!, ['-d', home, '-f', configFile], {
      cwd: home,
      env: mihomoEnv(this.deps.platform),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let tail = ''
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-4_000)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const running: Running = {
      child,
      api: new MihomoApi(controllerPort, secret),
      config: this.configText(networkInterface, agents, 0, ''),
      startedAt: Date.now(),
      stopping: false,
      // A program that never started has no close to wait for, only its error.
      exited: new Promise((resolve) => {
        child.once('close', () => resolve())
        child.once('error', () => {
          if (child.pid === undefined) resolve()
        })
      }),
    }
    this.running = running
    child.once('error', (error) => {
      keep(Buffer.from(`\n${error.message}`))
    })
    void running.exited.then(() => {
      removeLogSecret(secret)
      if (this.running === running) this.running = null
      if (running.stopping || this.closed) return
      const said = this.masked(lastLines(tail))
      this.deps.log('error', `Agent network: mihomo stopped: ${said}`)
      this.setState('error', 'exited', said || null)
      this.restartLater(Date.now() - running.startedAt)
    })
    if (child.pid) {
      this.record = { pid: child.pid, controllerPort, secret }
      this.saveState()
    }
    const version = await this.waitForApi(running)
    if (!version) {
      const said = this.masked(lastLines(tail))
      this.deps.log('error', `Agent network: mihomo did not start: ${said}`)
      await this.stopChild()
      this.setState('error', 'start', said || null)
      this.restartLater(0)
      return
    }
    this.version = version
    this.deps.log('info', `Agent network: mihomo ${version} runs on ${networkInterface}`)
    this.readProviders(await running.api.providers().catch(() => null))
    await this.applySelections()
    this.setState('running', null, null)
  }

  private async waitForApi(running: Running): Promise<string | null> {
    const until = Date.now() + START_MS
    let gone = false
    void running.exited.then(() => (gone = true))
    while (Date.now() < until && !gone && this.running === running) {
      const version = await running.api.version().catch(() => null)
      if (version) return version
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return null
  }

  private restartLater(ranMs: number): void {
    if (this.closed || !this.deps.settings().enabled) return
    if (ranMs >= HEALTHY_MS) this.failures = 0
    const delay = Math.min(MIN_RESTART_MS * 2 ** this.failures, MAX_RESTART_MS)
    this.failures++
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.reconcile()
    }, delay)
    this.restartTimer.unref?.()
  }

  private async stopChild(): Promise<void> {
    const running = this.running
    if (!running) return
    running.stopping = true
    running.child.kill()
    const killed = setTimeout(() => running.child.kill('SIGKILL'), 3_000)
    await running.exited
    clearTimeout(killed)
    if (this.running === running) this.running = null
    this.record = null
    this.saveState()
  }

  /** A mihomo a host before this one left running, known by the secret it was given. */
  private async stopLeftover(left: NonNullable<NetworkStateFile['running']>): Promise<void> {
    addLogSecret(left.secret)
    const answered = await new MihomoApi(left.controllerPort, left.secret)
      .version()
      .catch(() => null)
    if (answered) {
      try {
        process.kill(left.pid)
        this.deps.log('info', `Agent network: stopped the mihomo a previous run left (${left.pid})`)
      } catch {
        // It ended on its own.
      }
    }
    removeLogSecret(left.secret)
    this.record = null
    this.saveState()
  }

  /** Every agent that uses a node has a port that was free when checked. */
  private async ensurePorts(): Promise<void> {
    let changed = false
    for (const agentId of this.usingAgents()) {
      if (this.ports[agentId] !== undefined) continue
      const port = await freePort()
      if (port === null) continue
      this.ports[agentId] = port
      changed = true
    }
    if (changed) this.saveState()
  }

  /** Moves a listener whose port another program took; its agent starts again with the new one. */
  private async freeListenerPorts(agents: AgentId[]): Promise<void> {
    const moved: AgentId[] = []
    for (const agentId of agents) {
      const port = this.ports[agentId]!
      if ((await freePort(port)) !== null) continue
      const next = await freePort()
      if (next === null) continue
      this.deps.log('warn', `Agent network: port ${port} is taken; ${agentId} moves to ${next}`)
      this.ports[agentId] = next
      moved.push(agentId)
    }
    if (moved.length > 0) {
      this.saveState()
      this.deps.routesChanged(moved)
    }
  }

  /** The agents of the host that use a node, each with a port. */
  private usingAgents(): AgentId[] {
    const settings = this.deps.settings()
    if (!settings.enabled) return []
    return this.deps
      .agentIds()
      .filter((id) => agentRoute(settings, id) !== null && this.ports[id] !== undefined)
      .sort()
  }

  /** Picks each group's node; one that is gone leaves its group on REJECT. */
  private async applySelections(): Promise<void> {
    const running = this.running
    if (!running) return
    const settings = this.deps.settings()
    const proxies = await running.api.proxies()
    const pick = async (group: string, wanted: string): Promise<void> => {
      const info = proxies.get(group)
      if (!info) return
      const target = info.all?.includes(wanted) ? wanted : 'REJECT'
      if (info.now === target) return
      await running.api.select(group, target).catch((error: unknown) => {
        this.deps.log('warn', `Agent network: could not pick ${group}: ${(error as Error).message}`)
      })
    }
    const defaultName = settings.defaultNode ? this.fullName(settings.defaultNode) : null
    await pick(DEFAULT_GROUP, defaultName ?? 'REJECT')
    for (const agentId of this.usingAgents()) {
      const route = agentRoute(settings, agentId)
      const wanted =
        route === 'default' || route === null ? DEFAULT_GROUP : (this.fullName(route) ?? 'REJECT')
      await pick(agentGroup(agentId), wanted)
    }
  }

  private readProviders(providers: Awaited<ReturnType<MihomoApi['providers']>> | null): void {
    if (!providers) return
    for (const provider of providers) {
      const id = subscriptionOfProvider(provider.name)
      if (!id) continue
      this.providers.set(id, {
        nodes: provider.proxies.length,
        updatedAt: parseTime(provider.updatedAt),
        usage: provider.usage,
      })
    }
  }

  // Helpers.

  private fullName(ref: NodeRef): string | null {
    const sub = this.subscriptions.find((s) => s.id === ref.subscription)
    return sub ? `${nodePrefix(sub.name)}${ref.node}` : null
  }

  private liveApi(): MihomoApi {
    const api = this.running?.api
    if (!api || this.state !== 'running') {
      throw new HostError('unavailable', 'The agent network is not running')
    }
    return api
  }

  private find(id: string): StoredSubscription {
    const sub = this.subscriptions.find((s) => s.id === id)
    if (!sub) throw notFound(`No subscription ${id}`)
    return sub
  }

  private checkedName(name: string, except: string | null): string {
    const clean = cleanSubscriptionName(name)
    if (!isSubscriptionName(clean)) throw invalidParams('name is not a valid subscription name')
    const lower = clean.toLowerCase()
    if (this.subscriptions.some((s) => s.id !== except && s.name.toLowerCase() === lower)) {
      throw new HostError('conflict', 'Another subscription has this name')
    }
    return clean
  }

  private addSecrets(url: string): void {
    for (const secret of subscriptionSecrets(url)) addLogSecret(secret)
  }

  private masked(text: string): string {
    return redactLogText(text)
  }

  private async saveSubscriptions(): Promise<void> {
    this.deps.subscriptions.save({ version: 1, subscriptions: this.subscriptions })
    if (!(await this.deps.subscriptions.flushWritten())) {
      throw new HostError('internal', 'Could not save the subscriptions')
    }
  }

  private saveState(): void {
    this.deps.state.save({ version: 1, ports: this.ports, running: this.record })
  }

  private setState(
    state: AgentNetworkState,
    problem: AgentNetworkProblem | null,
    detail: string | null,
  ): void {
    this.state = state
    this.problem = problem
    this.detail = detail
    if (state === 'off') this.version = null
    this.emit()
  }

  private emit(): void {
    const status = this.status()
    const json = JSON.stringify(status)
    if (json === this.sent) return
    this.sent = json
    this.deps.changed(status)
  }
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-5).join(' ').slice(-800)
}

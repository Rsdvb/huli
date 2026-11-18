// Huli: the agents' network. Owns mihomo as a child of the agent host, writes its configuration,
// picks each group's node through its API, and gives each agent that uses a node the port of its
// own listener. It fails closed: an agent that uses a node gets only its listener in its proxy
// variables, so while mihomo is stopped, starting, restarting or crashed, or its node is missing
// or down, that agent's requests are refused or rejected, never sent another way. Kite downloads
// the subscriptions itself, the way its own requests go, and hands mihomo their nodes as files.
// Huli's own; see tools/huli/README.md.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import {
  agentRoute,
  cleanSubscriptionName,
  isSubscriptionName,
  MAX_SUBSCRIPTIONS,
  type AgentNetworkAgent,
  type AgentNetworkDeviceStatus,
  type AgentNetworkProblem,
  type AgentNetworkSettings,
  type AgentNetworkState,
  type AgentNetworkStatus,
  type ExitIp,
  type LatencyResult,
  type NodeRef,
  type NodeView,
  type SubscriptionUsage,
  type SubscriptionView,
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
import { parseUserinfo, readSubscription } from './content'
import { downloadSubscription, routeFor, type Downloaded, type ProxyVariables } from './download'
import {
  EMPTY_RECORD,
  isSubscriptionUrl,
  networkFolder,
  providerFile,
  subscriptionHost,
  subscriptionSecrets,
  writeFileAtomic,
  type NetworkStateFile,
  type StoredSubscription,
  type SubscriptionRecord,
  type SubscriptionsFile,
} from './files'
import { bypassesProxy, fetchTrace, parseTrace, proxyHop, type ProxyHop } from './exit-ip'
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
/** When the subscriptions are read again after a start, for those mihomo was still reading. */
const SETTLE_MS = [2_000, 8_000, 20_000]
const LATENCY_PARALLEL = 8
/** How long an exit check stands before a request for it checks again. */
const EXIT_FRESH_MS = 60_000
/** How often a subscription from a link is downloaded again. */
const REFRESH_MS = 12 * 60 * 60 * 1000
/** How soon a download that failed is tried again, without a request for it. */
const RETRY_MS = 30 * 60 * 1000
const NO_PROXY_VARIABLES: ProxyVariables = { http: null, https: null, all: null, noProxy: null }
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
  /** The proxy variables an agent on the system's network starts with. */
  systemProxy?: (agentId: AgentId) => { proxy: string | null; noProxy: string | null }
  /** Fetches the trace page; tests replace it. */
  trace?: (hop: ProxyHop | null) => Promise<string>
  /** The proxy variables of Kite's own requests, which the subscriptions are downloaded through. */
  ownProxy?: () => ProxyVariables
  /** Downloads a subscription; tests replace it. */
  download?: (url: string) => Promise<Downloaded>
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
  /** The nodes mihomo read of each subscription. */
  private mihomoNodes = new Map<string, number>()
  private records: Record<string, SubscriptionRecord> = {}
  /** The downloads under way, by subscription. */
  private updating = new Map<string, Promise<void>>()
  private exits = new Map<AgentId, ExitIp>()
  private checking = new Map<AgentId, Promise<ExitIp>>()
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
    for (const s of this.subscriptions) if (s.url !== null) this.addSecrets(s.url)
    this.ports = state.ports
    for (const s of this.subscriptions) {
      const record = state.subscriptions[s.id]
      if (record) this.records[s.id] = record
    }
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
    if (this.deps.settings().enabled) this.refreshDue()
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

  /** Gives every agent that uses a node a port checked free, before anything asks for one. */
  portsReady(): Promise<void> {
    return this.ensurePorts()
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
    const changed = agentIds.filter((id) => exitKey(before, id) !== exitKey(after, id))
    if (changed.length === 0) return
    for (const id of changed) this.exits.delete(id)
    this.emit()
    // Once mihomo has the new choice, see where those agents leave from now.
    void this.queue.then(() => {
      const settings = this.deps.settings()
      for (const id of changed.filter((id) => agentRoute(settings, id) !== null)) {
        void this.exitIp(id, true).catch(() => {})
      }
    })
  }

  /**
   * Where the agent's traffic leaves from, by a request sent its way: through its listener while
   * it uses a node, so a node that is down, or mihomo stopped, shows no address and never the
   * system's. A check younger than a minute stands unless `fresh`.
   */
  async exitIp(agentId: AgentId, fresh = false): Promise<ExitIp> {
    if (!this.deps.agentIds().includes(agentId)) throw notFound(`No agent ${agentId}`)
    const via = this.portFor(agentId) === null ? 'system' : 'node'
    const known = this.exits.get(agentId)
    if (!fresh && known && known.via === via && Date.now() - known.checkedAt < EXIT_FRESH_MS) {
      return known
    }
    const running = this.checking.get(agentId)
    if (running) return running
    const check = this.checkExit(agentId).finally(() => this.checking.delete(agentId))
    this.checking.set(agentId, check)
    return check
  }

  private async checkExit(agentId: AgentId): Promise<ExitIp> {
    const port = this.portFor(agentId)
    let hop: ProxyHop | null | 'unsupported'
    if (port !== null) hop = { host: '127.0.0.1', port, auth: null }
    else {
      const system = this.deps.systemProxy?.(agentId) ?? { proxy: null, noProxy: null }
      hop = bypassesProxy(system.noProxy) ? null : proxyHop(system.proxy)
    }
    const result: ExitIp = {
      agentId,
      via: port === null ? 'system' : 'node',
      ip: null,
      country: null,
      failure: null,
      checkedAt: Date.now(),
    }
    if (hop === 'unsupported') result.failure = 'unsupported'
    else {
      try {
        const trace = parseTrace(await (this.deps.trace ?? fetchTrace)(hop))
        if (trace) Object.assign(result, trace)
        else result.failure = 'unreachable'
      } catch {
        result.failure = 'unreachable'
      }
    }
    result.checkedAt = Date.now()
    // A change of the agent's way while this ran makes the answer stale: keep it out.
    const now = this.portFor(agentId) === null ? 'system' : 'node'
    if (now === result.via) {
      this.exits.set(agentId, result)
      this.emit()
    }
    return result
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
      subscriptions: this.subscriptions.map((s) => this.view(s)),
      agents,
      exits: this.currentExits(),
    }
  }

  /**
   * What a paired device may see: no subscription's address or host, no mihomo message, only
   * names, counts, choices and exits. The phone shows and switches nodes from it.
   */
  async deviceStatus(): Promise<AgentNetworkDeviceStatus> {
    const settings = this.deps.settings()
    const nodes = await this.nodes().catch(() => [])
    return {
      available: this.available,
      enabled: settings.enabled,
      state: this.state,
      problem: this.problem,
      interface: this.inUse,
      subscriptions: this.subscriptions.map((s) => {
        const { id, name, nodes, usage } = this.view(s)
        return { id, name, nodes, usage }
      }),
      nodes: nodes.map(({ subscription, node, delay }) => ({ subscription, node, delay })),
      defaultNode: settings.defaultNode,
      agents: this.deps.agentIds().map((agentId) => ({
        agentId,
        choice: settings.agents[agentId] ?? 'default',
      })),
      exits: this.currentExits(),
    }
  }

  private view(s: StoredSubscription): SubscriptionView {
    const record = this.records[s.id] ?? EMPTY_RECORD
    return {
      id: s.id,
      name: s.name,
      source: s.url === null ? 'file' : 'url',
      host: s.url === null ? null : subscriptionHost(s.url),
      nodes: this.mihomoNodes.get(s.id) ?? record.nodes,
      updatedAt: record.updatedAt,
      usage: record.usage,
      error: record.error,
      failedAt: record.failedAt,
    }
  }

  private currentExits(): ExitIp[] {
    const ids = new Set(this.deps.agentIds())
    return [...this.exits.values()]
      .filter((exit) => ids.has(exit.agentId))
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
  }

  async nodes(): Promise<NodeView[]> {
    const api = this.running?.api
    if (!api || this.state !== 'running') return []
    const providers = await api.providers()
    this.readProviders(providers)
    this.emit()
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

  /** Adds a subscription from a link once its first download gave nodes, which mihomo then reads. */
  async addSubscription(name: string, url: string): Promise<{ id: string }> {
    this.checkedName(name, null)
    if (!isSubscriptionUrl(url)) throw invalidParams('url must be an http or https address')
    this.checkRoom()
    const id = randomBytes(6).toString('hex')
    this.addSecrets(url)
    try {
      let record: SubscriptionRecord
      try {
        record = await this.download(id, url)
      } catch (error) {
        const said = this.masked((error as Error).message)
        throw new HostError('unavailable', `Could not download the subscription: ${said}`)
      }
      await this.addStored({ id, name, url, addedAt: Date.now() }, record)
    } catch (error) {
      this.dropSecrets(url)
      throw error
    }
    return { id }
  }

  /** Adds a subscription from a file's content, Clash YAML or a list of node links. */
  async importSubscription(name: string, content: string): Promise<{ id: string }> {
    this.checkedName(name, null)
    this.checkRoom()
    const id = randomBytes(6).toString('hex')
    const record = await this.writeNodes(id, content, null, true)
    await this.addStored({ id, name, url: null, addedAt: Date.now() }, record)
    return { id }
  }

  /** Replaces the nodes of a subscription imported from a file. */
  async reimportSubscription(id: string, content: string): Promise<void> {
    const sub = this.find(id)
    if (sub.url !== null) {
      throw new HostError('conflict', 'This subscription comes from a link: refresh it instead')
    }
    const record = await this.writeNodes(id, content, null, true)
    if (!this.subscriptions.some((s) => s.id === id)) return
    this.records[id] = record
    this.saveState()
    await this.reload(id)
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
    this.mihomoNodes.delete(id)
    delete this.records[id]
    await this.saveSubscriptions()
    this.saveState()
    this.reconcile()
    await this.queue
    await rm(providerFile(this.deps.userDataPath, id), { force: true }).catch(() => {})
    if (sub.url !== null) this.dropSecrets(sub.url)
  }

  /**
   * Downloads one subscription from a link again, or every one with null, and has mihomo read it
   * again. A download that fails keeps the nodes the last one gave.
   */
  async refresh(id: string | null): Promise<void> {
    const subs = id === null ? this.subscriptions.filter((s) => s.url !== null) : [this.find(id)]
    if (subs.some((s) => s.url === null)) {
      throw new HostError(
        'conflict',
        'This subscription comes from a file: import it again instead',
      )
    }
    const failed: string[] = []
    await Promise.all(
      subs.map((sub) =>
        this.update(sub).catch((error: unknown) => {
          const said = (error as Error).message
          failed.push(subs.length > 1 ? `${sub.name}: ${said}` : said)
        }),
      ),
    )
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
    this.refreshDue()
    const before = this.detected
    await this.detect()
    if (this.detected !== before && this.deps.settings().interface === null) {
      this.deps.log('info', `Agent network: the interface is now ${this.detected ?? 'none'}`)
      this.reconcile()
      return
    }
    await this.refreshInfo()
  }

  /** Reads the subscriptions' state again and picks the groups' nodes, which may have come. */
  private async refreshInfo(): Promise<void> {
    const running = this.running
    if (!running || this.state !== 'running' || this.closed) return
    this.readProviders(await running.api.providers().catch(() => null))
    await this.applySelections().catch(() => {})
    this.emit()
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
        subscriptions: this.subscriptions.map(({ id, name }) => ({ id, name })),
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
    // The configuration holds the API's secret: readable by the user alone.
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
    // A subscription mihomo had not read yet comes in its own time; look again soon after.
    for (const ms of SETTLE_MS) {
      setTimeout(() => {
        if (this.running === running) void this.refreshInfo()
      }, ms).unref?.()
    }
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
    const settings = this.deps.settings()
    for (const agentId of this.deps.agentIds()) {
      if (agentRoute(settings, agentId) === null || this.ports[agentId] !== undefined) continue
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
      this.mihomoNodes.set(id, provider.proxies.length)
    }
  }

  // Subscriptions' nodes.

  /** Downloads every subscription from a link whose nodes are older than the interval. */
  private refreshDue(): void {
    const now = Date.now()
    for (const sub of this.subscriptions) {
      if (sub.url === null || this.updating.has(sub.id)) continue
      const record = this.records[sub.id] ?? EMPTY_RECORD
      const stale = record.updatedAt === null || now - record.updatedAt >= REFRESH_MS
      const failedLately =
        record.failedAt !== null &&
        record.failedAt > (record.updatedAt ?? 0) &&
        now - record.failedAt < RETRY_MS
      if (stale && !failedLately) void this.update(sub).catch(() => {})
    }
  }

  /** Downloads the subscription again, once at a time, and has mihomo read it. */
  private update(sub: StoredSubscription): Promise<void> {
    const running = this.updating.get(sub.id)
    if (running) return running
    const job = this.runUpdate(sub).finally(() => this.updating.delete(sub.id))
    this.updating.set(sub.id, job)
    return job
  }

  private async runUpdate(sub: StoredSubscription): Promise<void> {
    let record: SubscriptionRecord
    try {
      record = await this.download(sub.id, sub.url!)
    } catch (error) {
      const said = this.masked((error as Error).message)
      this.deps.log('warn', `Agent network: could not download ${sub.name}: ${said}`)
      if (this.subscriptions.some((s) => s.id === sub.id)) {
        const last = this.records[sub.id] ?? EMPTY_RECORD
        this.records[sub.id] = { ...last, error: said, failedAt: Date.now() }
        this.saveState()
        this.emit()
      }
      throw new Error(said, { cause: error })
    }
    if (!this.subscriptions.some((s) => s.id === sub.id)) {
      // Removed while it downloaded.
      await rm(providerFile(this.deps.userDataPath, sub.id), { force: true }).catch(() => {})
      return
    }
    this.records[sub.id] = record
    this.saveState()
    await this.reload(sub.id)
  }

  /** Downloads the subscription the way Kite's own requests go, and writes its nodes. */
  private async download(id: string, url: string): Promise<SubscriptionRecord> {
    const download =
      this.deps.download ??
      ((address: string) =>
        downloadSubscription(address, {
          route: routeFor(this.deps.ownProxy?.() ?? NO_PROXY_VARIABLES),
        }))
    const fetched = await download(url)
    const text = fetched.body.toString('utf8')
    return this.writeNodes(id, text, parseUserinfo(fetched.userinfo), false)
  }

  /**
   * Writes the subscription's nodes for mihomo, whole, once they are known to hold one; else
   * throws and leaves the file as it was. An import's content is the caller's, so its fault is
   * invalid params.
   */
  private async writeNodes(
    id: string,
    text: string,
    usage: SubscriptionUsage | null,
    imported: boolean,
  ): Promise<SubscriptionRecord> {
    let content: ReturnType<typeof readSubscription>
    try {
      content = readSubscription(text)
    } catch (error) {
      if (imported) throw invalidParams((error as Error).message)
      throw error
    }
    try {
      await writeFileAtomic(providerFile(this.deps.userDataPath, id), content.data)
    } catch (error) {
      throw new HostError('internal', `Could not save the nodes: ${(error as Error).message}`)
    }
    return { updatedAt: Date.now(), usage, nodes: content.nodes, error: null, failedAt: null }
  }

  /** Keeps a new subscription whose nodes are written, and starts mihomo again with it. */
  private async addStored(sub: StoredSubscription, record: SubscriptionRecord): Promise<void> {
    try {
      // Again: another subscription may have come while this one downloaded.
      const name = this.checkedName(sub.name, null)
      this.checkRoom()
      this.subscriptions = [...this.subscriptions, { ...sub, name }]
      this.records[sub.id] = record
      await this.saveSubscriptions()
    } catch (error) {
      this.subscriptions = this.subscriptions.filter((s) => s.id !== sub.id)
      delete this.records[sub.id]
      await rm(providerFile(this.deps.userDataPath, sub.id), { force: true }).catch(() => {})
      throw error
    }
    this.saveState()
    this.reconcile()
  }

  /** Has a running mihomo read the subscription's file again, and picks the groups' nodes anew. */
  private async reload(id: string): Promise<void> {
    const running = this.running
    if (running && this.state === 'running') {
      await running.api.updateProvider(providerName(id)).catch((error: unknown) => {
        const said = this.masked((error as Error).message)
        this.deps.log('warn', `Agent network: mihomo could not read ${providerName(id)}: ${said}`)
      })
      this.readProviders(await running.api.providers().catch(() => null))
      // A node the new list lacks leaves its groups on REJECT.
      await this.applySelections().catch(() => {})
    }
    this.emit()
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

  private checkRoom(): void {
    if (this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      throw new HostError('conflict', `There are ${MAX_SUBSCRIPTIONS} subscriptions already`)
    }
  }

  private addSecrets(url: string): void {
    for (const secret of subscriptionSecrets(url)) addLogSecret(secret)
  }

  /** Forgets the address's secrets, but those another subscription's address still holds. */
  private dropSecrets(url: string): void {
    for (const secret of subscriptionSecrets(url)) {
      if (!this.subscriptions.some((s) => s.url?.includes(secret))) removeLogSecret(secret)
    }
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
    this.deps.state.save({
      version: 1,
      ports: this.ports,
      running: this.record,
      subscriptions: this.records,
    })
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
    // What the agents on nodes saw went through a mihomo that is gone now.
    if (state !== 'running') {
      for (const [id, exit] of this.exits) if (exit.via === 'node') this.exits.delete(id)
    }
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

/** What an agent's exit depends on: the system's network, or the node it ends up on. */
function exitKey(settings: AgentNetworkSettings, agentId: AgentId): string {
  const route = agentRoute(settings, agentId)
  if (route === null) return 'system'
  const node = route === 'default' ? settings.defaultNode : route
  return node ? `node:${node.subscription}:${node.node}` : 'node:none'
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-5).join(' ').slice(-800)
}

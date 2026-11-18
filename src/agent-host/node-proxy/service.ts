// Huli: the agents' network. Owns mihomo as a child of the agent host, writes its configuration,
// picks each group's node through its API, and gives each agent that uses a node the port of its
// own listener. It fails closed: an agent that uses a node gets only its listener in its proxy
// variables, so while mihomo is stopped, starting, restarting or crashed, or its node is missing
// or down, that agent's requests are refused or rejected, never sent another way. Kite downloads
// the subscriptions itself, the way its own requests go, and hands mihomo their nodes as files.
// Every agent's listener is in the nodes' mihomo; an agent bound to a network interface leaves it
// through a hop to a mihomo of its own bound to that interface, which alone starts and stops as
// the agent's binding changes, so the nodes' mihomo and its connections never notice; see
// `interfaceConfig`. Huli's own; see tools/huli/README.md.

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
  routeInterface,
  type AgentNetworkAgent,
  type AgentNetworkDeviceStatus,
  type AgentNetworkProblem,
  type AgentNetworkSettings,
  type AgentNetworkState,
  type AgentNetworkStatus,
  type ExitIp,
  type LatencyResult,
  type NetworkInterfaceView,
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
  hopName,
  INTERFACE_PROXY,
  interfaceConfig,
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
import {
  detectInterface,
  InterfaceWatch,
  listInterfaces,
  loopbackInterface,
  presentInterfaces,
  type InterfaceChange,
} from './interface'

/** How often the interface is read again and the groups' nodes checked, while on. */
const CHECK_MS = 60_000
/** How often the interfaces agents are bound to are looked at, while some are. */
const WATCH_MS = 2_500
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
/** How old a list of the interfaces a device's status shows may be. */
const DEVICE_INTERFACES_MS = 10_000

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
  /** Lists the computer's network interfaces; tests replace it. */
  listInterfaces?: (platform: Platform) => Promise<NetworkInterfaceView[]>
  /** The names of the interfaces up now, read cheaply and often; tests replace it. */
  presentInterfaces?: () => Iterable<string>
  /** The proxy variables an agent on the system's network starts with. */
  systemProxy?: (agentId: AgentId) => { proxy: string | null; noProxy: string | null }
  /** Fetches the trace page; tests replace it. */
  trace?: (hop: ProxyHop | null) => Promise<string>
  /** The proxy variables of Kite's own requests, which the subscriptions are downloaded through. */
  ownProxy?: () => ProxyVariables
  /** Downloads a subscription; tests replace it. */
  download?: (url: string) => Promise<Downloaded>
}

type ChildRecord = NonNullable<NetworkStateFile['running']>

/** One mihomo the host started: the nodes' one, or one interface's. */
interface Unit {
  child: ChildProcess
  api: MihomoApi
  secret: string
  /** Ends when the process has, or with its error when it never started. */
  exited: Promise<void>
  /** The end of what it wrote. */
  tail(): string
  record: ChildRecord | null
}

/** The mihomo that binds one agent to one interface, behind the agent's hop. */
interface Side extends Unit {
  agentId: AgentId
  networkInterface: string
  /** The port its listener takes, which the agent's hop leads to. */
  port: number
  /** Its home's number under `interfaces/`. */
  slot: number
  startedAt: number
  /** Its API answered, so its listener is up. */
  ready: boolean
  /** Set when the host stops it on purpose, so its exit is no crash. */
  stopping: boolean
}

/** The nodes' mihomo, which holds every agent's listener. */
interface Running extends Unit {
  config: string
  startedAt: number
  /** Set when the host stops it on purpose, or it crashed, so an exit is no crash. */
  stopping: boolean
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
  /** The mihomo of each agent bound to an interface. */
  private sides = new Map<AgentId, Side>()
  /** The port each agent's hop leads to, as the nodes' mihomo was started with it. */
  private hopPorts: Partial<Record<AgentId, number>> = {}
  /** What the hops sign in to the interfaces' mihomo with; one for the host's life. */
  private readonly hopPassword = randomBytes(24).toString('hex')
  /** How often each agent's interface mihomo failed in a row, and when it may start again. */
  private sideFailures = new Map<AgentId, { count: number; retryAt: number }>()
  private sideTimer: ReturnType<typeof setTimeout> | null = null
  private readonly watcher: InterfaceWatch
  /** The computer's interfaces as last read; null until read. */
  private interfaceList: NetworkInterfaceView[] | null = null
  private interfacesAt = 0
  private readingInterfaces: Promise<NetworkInterfaceView[]> | null = null
  /** Ends when the processes of a run that crashed have all ended. */
  private dying: Promise<void> = Promise.resolve()

  constructor(private readonly deps: NodeProxyDeps) {
    addLogSecret(this.hopPassword)
    this.watcher = new InterfaceWatch({
      read: deps.presentInterfaces ?? presentInterfaces,
      intervalMs: WATCH_MS,
      changed: (change) => this.interfacesChanged(change),
    })
  }

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
    for (const left of [...(state.running ? [state.running] : []), ...state.sides]) {
      await this.stopLeftover(left)
    }
    this.record = null
    this.saveState()
    await this.ensurePorts()
  }

  /** Starts mihomo when the settings say so, and checks its interface from then on. */
  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_MS)
    this.timer.unref?.()
    this.reconcile()
    if (this.deps.settings().enabled) this.refreshDue()
  }

  /**
   * The port of the agent's listener while it uses a node or an interface; null for the system's
   * network.
   */
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
    const via = this.via(agentId)
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
      via: this.via(agentId),
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
    if (this.via(agentId) === result.via) {
      this.exits.set(agentId, result)
      this.emit()
    }
    return result
  }

  /** How the agent's requests leave: through a node, through its interface, or the system's way. */
  private via(agentId: AgentId): ExitIp['via'] {
    if (this.portFor(agentId) === null) return 'system'
    return routeInterface(agentRoute(this.deps.settings(), agentId)) === null ? 'node' : 'interface'
  }

  status(): AgentNetworkStatus {
    const settings = this.deps.settings()
    const agents: AgentNetworkAgent[] = this.usingAgents().map((agentId) => {
      const route = agentRoute(settings, agentId)
      const bound = routeInterface(route)
      return {
        agentId,
        port: this.ports[agentId] ?? null,
        node: route === null || route === 'default' || bound !== null ? null : (route as NodeRef),
        interface: bound,
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
      interfaces: this.interfaceList ?? [],
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
    const interfaces = await this.interfaces(DEVICE_INTERFACES_MS).catch(
      () => this.interfaceList ?? [],
    )
    return {
      available: this.available,
      enabled: settings.enabled,
      state: this.state,
      problem: this.problem,
      interface: this.inUse,
      interfaces: interfaces.map(({ name, up, tunnel }) => ({ name, up, tunnel })),
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

  /**
   * The computer's network interfaces, read again unless the last read is younger than `maxAgeMs`.
   * An agent bound to one that is gone or down has its group put on REJECT.
   */
  async interfaces(maxAgeMs = 0): Promise<NetworkInterfaceView[]> {
    if (this.interfaceList && Date.now() - this.interfacesAt <= maxAgeMs) return this.interfaceList
    this.readingInterfaces ??= (this.deps.listInterfaces ?? listInterfaces)(this.deps.platform)
      .then((list) => {
        const before = this.usableKey()
        this.interfaceList = list
        this.interfacesAt = Date.now()
        if (this.usableKey() !== before && this.running && this.state === 'running') {
          this.queue = this.queue.then(() => this.applySelections()).catch(() => {})
        }
        this.emit()
        return list
      })
      .finally(() => {
        this.readingInterfaces = null
      })
    return this.readingInterfaces
  }

  /**
   * Whether the interface may carry an agent's traffic: up at the watcher's last read, else, while
   * it cannot read, listed and up, or not known yet, when the bound dial itself still fails closed.
   */
  private usable(name: string): boolean {
    const watched = this.watcher.usable(name)
    if (watched !== null) return watched
    if (this.interfaceList === null) return true
    return this.interfaceList.some((item) => item.name === name && item.up)
  }

  /** Which of the bound interfaces are usable now, to tell when the picks must change. */
  private usableKey(): string {
    return [...this.sides.values()]
      .map((side) => `${side.networkInterface}:${this.usable(side.networkInterface)}`)
      .join('\n')
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
        const delay = name
          ? await api.delay(providerName(ref.subscription), name, TEST_URL, LATENCY_TIMEOUT_MS)
          : null
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
    if (this.sideTimer) clearTimeout(this.sideTimer)
    this.watcher.stop()
    await this.queue.catch(() => {})
    await this.stopAll()
    await this.dying
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
        await this.stopAll().catch(() => {})
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
    // The watcher sees an interface go and come back within seconds; only while it cannot read
    // does the full list, read here, tell.
    const blind = [...this.sides.values()].some(
      (side) => this.watcher.usable(side.networkInterface) === null,
    )
    if (blind) await this.interfaces().catch(() => {})
    await this.refreshInfo()
  }

  /**
   * A bound interface went or came back. Its agents are cut off at once, outside the queue, which
   * may be busy starting a mihomo; one that comes back has its agents' mihomo started anew, since
   * mihomo looks interfaces up through a table it keeps for 20 seconds, which would still lack it
   * or name its old index, and then picked again.
   */
  private interfacesChanged(change: InterfaceChange): void {
    if (this.closed) return
    for (const name of change.gone) this.deps.log('info', `Agent network: ${name} is gone or down`)
    for (const name of change.back) this.deps.log('info', `Agent network: ${name} is back`)
    for (const side of this.sides.values()) {
      if (change.gone.includes(side.networkInterface)) void this.cutOff(side.agentId)
    }
    this.queue = this.queue
      .then(async () => {
        for (const side of [...this.sides.values()]) {
          if (change.back.includes(side.networkInterface)) await this.stopSide(side)
        }
        if (!this.running || this.state !== 'running' || this.closed) return
        await this.applySides()
        await this.applySelections()
        this.emit()
      })
      .catch((error: unknown) => {
        this.deps.log('warn', `Agent network: ${this.masked((error as Error).message)}`)
      })
    // The windows' list, with descriptions and states, needs the full read; only on a change.
    void this.interfaces().catch(() => {})
  }

  /** Puts the agent's groups on REJECT now, in the nodes' mihomo and in its interface's. */
  private async cutOff(agentId: AgentId): Promise<void> {
    const group = agentGroup(agentId)
    const side = this.sides.get(agentId)
    await Promise.all(
      [this.running, side].map((unit) =>
        unit ? unit.api.select(group, 'REJECT').catch(() => {}) : undefined,
      ),
    )
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
      await this.stopAll()
      this.setState('off', null, null)
      return
    }
    if (!this.available) {
      await this.stopAll()
      this.setState('error', 'missing', null)
      return
    }
    // Read once here; the regular check reads it again and applies a change.
    if (this.detected === null) await this.detect()
    const networkInterface = settings.interface ?? this.detected
    if (!networkInterface) {
      await this.stopAll()
      this.inUse = null
      this.setState('error', 'interface', null)
      return
    }
    const bound = this.bound()
    this.watcher.watch(bound.values())
    if (bound.size > 0 && this.interfaceList === null) void this.interfaces().catch(() => {})
    const agents = this.listenerAgents()
    await this.ensureHopPorts(agents)
    const config = this.mainKey(networkInterface, agents)
    if (!this.running || this.running.config !== config || this.state !== 'running') {
      await this.stopMain()
      if (!(await this.startMain(networkInterface, agents))) return
    }
    await this.applySides()
    await this.applySelections()
    this.emit()
  }

  /** Each agent bound to an interface, with the interface's name. */
  private bound(): Map<AgentId, string> {
    const settings = this.deps.settings()
    const out = new Map<AgentId, string>()
    for (const agentId of this.listenerAgents()) {
      const name = routeInterface(agentRoute(settings, agentId))
      if (name !== null) out.set(agentId, name)
    }
    return out
  }

  private listenersOf(agents: AgentId[]) {
    return agents.map((agentId) => ({
      agentId,
      port: this.ports[agentId]!,
      hopPort: this.hopPorts[agentId] ?? 0,
    }))
  }

  private mainText(
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
        agents: this.listenersOf(agents),
        hopPassword: this.hopPassword,
        loopbackInterface: loopbackInterface(this.deps.platform),
      }),
    )
  }

  /** The nodes' configuration without its controller, to tell whether a change needs a new one. */
  private mainKey(networkInterface: string, agents: AgentId[]): string {
    return this.mainText(networkInterface, agents, 0, '')
  }

  /** Starts one mihomo in `home` with the configuration `text` gives for its controller. */
  private async spawnUnit(
    home: string,
    text: (controllerPort: number, secret: string) => string,
  ): Promise<Unit> {
    const controllerPort = await freePort()
    if (controllerPort === null) throw new Error('no free port for the controller')
    const secret = randomBytes(24).toString('hex')
    addLogSecret(secret)
    const configFile = path.join(home, 'config.yaml')
    // The configuration holds the API's secret: readable by the user alone.
    await writeFile(configFile, text(controllerPort, secret), { mode: 0o600 })
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
    child.once('error', (error) => {
      keep(Buffer.from(`\n${error.message}`))
    })
    // A program that never started has no close to wait for, only its error.
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => {
        if (child.pid === undefined) resolve()
      })
    })
    void exited.then(() => removeLogSecret(secret))
    return {
      child,
      api: new MihomoApi(controllerPort, secret),
      secret,
      exited,
      tail: () => tail,
      record: child.pid ? { pid: child.pid, controllerPort, secret } : null,
    }
  }

  /** The nodes' mihomo ended on its own: it starts again; the interfaces' ones stay. */
  private mainExited(running: Running): void {
    if (running.stopping || this.closed) return
    running.stopping = true
    if (this.running === running) this.running = null
    this.record = null
    this.saveState()
    const said = this.masked(lastLines(running.tail()))
    this.deps.log('error', `Agent network: mihomo stopped: ${said}`)
    this.setState('error', 'exited', said || null)
    this.restartLater(Date.now() - running.startedAt)
  }

  /** Starts the nodes' mihomo; false when it did not come up, and a start again is planned. */
  private async startMain(networkInterface: string, agents: AgentId[]): Promise<boolean> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.inUse = networkInterface
    this.setState('starting', null, null)
    // What a run that crashed left must be gone before its listeners' ports are taken again.
    await this.dying
    await this.freeListenerPorts(agents)
    await this.freeHopPorts(agents)
    const home = path.join(this.folder, 'mihomo')
    await mkdir(path.join(home, 'providers'), { recursive: true })
    const main = await this.spawnUnit(home, (port, secret) =>
      this.mainText(networkInterface, agents, port, secret),
    )
    const running: Running = {
      ...main,
      config: this.mainKey(networkInterface, agents),
      startedAt: Date.now(),
      stopping: false,
    }
    this.running = running
    this.record = main.record
    this.dying = main.exited
    this.saveState()
    void main.exited.then(() => this.mainExited(running))
    const version = await this.waitForApi(main, () => this.running === running)
    if (!version) {
      const said = this.masked(lastLines(main.tail()))
      this.deps.log('error', `Agent network: mihomo did not start: ${said}`)
      await this.stopMain()
      this.setState('error', 'start', said || null)
      this.restartLater(0)
      return false
    }
    this.version = version
    this.deps.log('info', `Agent network: mihomo ${version} runs on ${networkInterface}`)
    this.readProviders(await running.api.providers().catch(() => null))
    this.setState('running', null, null)
    // A subscription mihomo had not read yet comes in its own time; look again soon after.
    for (const ms of SETTLE_MS) {
      setTimeout(() => {
        if (this.running === running) void this.refreshInfo()
      }, ms).unref?.()
    }
    return true
  }

  private async waitForApi(unit: Unit, current: () => boolean): Promise<string | null> {
    const until = Date.now() + START_MS
    let gone = false
    void unit.exited.then(() => (gone = true))
    while (Date.now() < until && !gone && current()) {
      const version = await unit.api.version().catch(() => null)
      if (version) return version
      await new Promise((resolve) => setTimeout(resolve, 100))
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

  /** Ends a mihomo, killed hard if it takes more than 3 seconds. */
  private async endUnit(unit: Unit): Promise<void> {
    unit.child.kill()
    const killed = setTimeout(() => unit.child.kill('SIGKILL'), 3_000)
    await unit.exited
    clearTimeout(killed)
  }

  private async stopMain(): Promise<void> {
    const running = this.running
    if (!running) return
    running.stopping = true
    await this.endUnit(running)
    if (this.running === running) this.running = null
    this.record = null
    this.saveState()
  }

  private async stopAll(): Promise<void> {
    this.watcher.watch([])
    await Promise.all([this.stopMain(), ...[...this.sides.values()].map((s) => this.stopSide(s))])
  }

  // The interfaces' mihomo processes, one for each bound agent.

  /**
   * Starts the mihomo of each agent newly bound to an interface and stops that of each agent
   * unbound or moved to another, the nodes' mihomo and the other agents' untouched.
   */
  private async applySides(): Promise<void> {
    const bound = this.bound()
    for (const side of [...this.sides.values()]) {
      if (bound.get(side.agentId) !== side.networkInterface) await this.stopSide(side)
    }
    for (const [agentId, name] of bound) {
      if (this.sides.has(agentId) || !this.running || this.closed) continue
      if ((this.sideFailures.get(agentId)?.retryAt ?? 0) > Date.now()) continue
      await this.startSide(agentId, name)
    }
  }

  private async startSide(agentId: AgentId, networkInterface: string): Promise<void> {
    const port = this.hopPorts[agentId]
    if (port === undefined) return
    if ((await freePort(port)) === null) {
      // Another program took the port the hop leads to: the nodes' mihomo starts again with a new
      // one, since the hop must never lead to a listener that is not this host's.
      this.deps.log('warn', `Agent network: port ${port} is taken; ${agentId}'s hop moves`)
      delete this.hopPorts[agentId]
      this.reconcile()
      return
    }
    const taken = new Set([...this.sides.values()].map((s) => s.slot))
    let slot = 0
    while (taken.has(slot)) slot++
    const home = path.join(this.folder, 'mihomo', 'interfaces', String(slot))
    // Each in a home of its own: mihomo locks the cache file in its home.
    await mkdir(home, { recursive: true })
    const unit = await this.spawnUnit(home, (controllerPort, secret) =>
      serializeConfig(
        interfaceConfig({
          controllerPort,
          secret,
          networkInterface,
          agentId,
          port,
          hopPassword: this.hopPassword,
        }),
      ),
    )
    const side: Side = {
      ...unit,
      agentId,
      networkInterface,
      port,
      slot,
      startedAt: Date.now(),
      ready: false,
      stopping: false,
    }
    this.sides.set(agentId, side)
    this.saveState()
    void side.exited.then(() => this.sideExited(side))
    if (!(await this.waitForApi(side, () => this.sides.get(agentId) === side))) {
      const said = this.masked(lastLines(side.tail()))
      this.deps.log('error', `Agent network: ${agentId}'s mihomo did not start: ${said}`)
      await this.stopSide(side)
      this.sideFailed(agentId)
      return
    }
    side.ready = true
    this.deps.log('info', `Agent network: ${agentId} goes out through ${networkInterface} alone`)
  }

  /** Stops the agent's interface mihomo, its groups put on REJECT first. */
  private async stopSide(side: Side): Promise<void> {
    side.stopping = true
    side.ready = false
    await this.cutOff(side.agentId)
    await this.endUnit(side)
    if (this.sides.get(side.agentId) === side) this.sides.delete(side.agentId)
    this.saveState()
  }

  /** An interface's mihomo ended on its own: its agent is cut off, and it starts again later. */
  private sideExited(side: Side): void {
    if (side.stopping || this.closed) return
    side.stopping = true
    side.ready = false
    if (this.sides.get(side.agentId) === side) this.sides.delete(side.agentId)
    this.saveState()
    void this.running?.api.select(agentGroup(side.agentId), 'REJECT').catch(() => {})
    const said = this.masked(lastLines(side.tail()))
    this.deps.log('error', `Agent network: ${side.agentId}'s mihomo stopped: ${said}`)
    if (Date.now() - side.startedAt >= HEALTHY_MS) this.sideFailures.delete(side.agentId)
    this.sideFailed(side.agentId)
  }

  /** Tries the agent's interface mihomo again later, each time later, up to a minute. */
  private sideFailed(agentId: AgentId): void {
    const count = this.sideFailures.get(agentId)?.count ?? 0
    const delay = Math.min(MIN_RESTART_MS * 2 ** count, MAX_RESTART_MS)
    this.sideFailures.set(agentId, { count: count + 1, retryAt: Date.now() + delay })
    if (this.closed) return
    if (this.sideTimer) clearTimeout(this.sideTimer)
    this.sideTimer = setTimeout(() => {
      this.sideTimer = null
      this.reconcile()
    }, delay)
    this.sideTimer.unref?.()
  }

  /** A mihomo a host before this one left running, known by the secret it was given. */
  private async stopLeftover(left: ChildRecord): Promise<void> {
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
  }

  /**
   * Every agent has a port that was free when checked while the network is on: the nodes'
   * mihomo holds a listener for each, whatever its choice, so a change of choice never changes it.
   */
  private async ensurePorts(): Promise<void> {
    if (!this.deps.settings().enabled) return
    let changed = false
    for (const agentId of this.deps.agentIds()) {
      if (this.ports[agentId] !== undefined) continue
      const port = await freePort()
      if (port === null) continue
      this.ports[agentId] = port
      changed = true
    }
    if (changed) this.saveState()
  }

  /** Gives every agent a port for its hop, so binding it later never changes the nodes' mihomo. */
  private async ensureHopPorts(agents: AgentId[]): Promise<void> {
    for (const agentId of agents) {
      if (this.hopPorts[agentId] !== undefined) continue
      const listeners = new Set(Object.values(this.ports) as number[])
      let port = await freePort()
      while (port !== null && listeners.has(port)) port = await freePort()
      if (port !== null) this.hopPorts[agentId] = port
    }
  }

  /** Moves a hop whose port another program took, unless it is this host's interface mihomo. */
  private async freeHopPorts(agents: AgentId[]): Promise<void> {
    for (const agentId of agents) {
      const port = this.hopPorts[agentId]
      if (port === undefined || this.sides.get(agentId)?.port === port) continue
      if ((await freePort(port)) === null) delete this.hopPorts[agentId]
    }
    await this.ensureHopPorts(agents)
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

  /** The agents of the host that use a node or an interface, each with a port. */
  private usingAgents(): AgentId[] {
    const settings = this.deps.settings()
    return this.listenerAgents().filter((id) => agentRoute(settings, id) !== null)
  }

  /** The agents with a listener in the nodes' mihomo: every agent with a port, while on. */
  private listenerAgents(): AgentId[] {
    if (!this.deps.settings().enabled) return []
    return this.deps
      .agentIds()
      .filter((id) => this.ports[id] !== undefined)
      .sort()
  }

  /**
   * Picks each group's way out: a node, or the hop to the agent's interface mihomo while it runs
   * and the interface is up, else REJECT; an agent on the system's network never uses its group.
   */
  private async applySelections(): Promise<void> {
    const running = this.running
    if (!running) return
    const settings = this.deps.settings()
    const picker = async (unit: Unit) => {
      const proxies = await unit.api.proxies()
      return async (group: string, wanted: string): Promise<void> => {
        const info = proxies.get(group)
        if (!info) return
        const target = info.all?.includes(wanted) ? wanted : 'REJECT'
        if (info.now === target) return
        await unit.api.select(group, target).catch((error: unknown) => {
          const said = (error as Error).message
          this.deps.log('warn', `Agent network: could not pick ${group}: ${said}`)
        })
      }
    }
    // The interfaces' groups first, so a hop picked below leads to a way out already.
    for (const side of [...this.sides.values()]) {
      if (!side.ready) continue
      const pickSide = await picker(side).catch(() => null)
      const wanted = this.usable(side.networkInterface) ? INTERFACE_PROXY : 'REJECT'
      await pickSide?.(agentGroup(side.agentId), wanted)
    }
    const pick = await picker(running)
    const defaultName = settings.defaultNode ? this.fullName(settings.defaultNode) : null
    await pick(DEFAULT_GROUP, defaultName ?? 'REJECT')
    for (const agentId of this.listenerAgents()) {
      const route = agentRoute(settings, agentId)
      const bound = routeInterface(route)
      const side = this.sides.get(agentId)
      let wanted: string
      if (route === null) wanted = 'REJECT'
      else if (bound !== null) {
        const ready = side?.ready && side.networkInterface === bound && this.usable(bound)
        wanted = ready ? hopName(agentId) : 'REJECT'
      } else if (route === 'default') wanted = DEFAULT_GROUP
      else wanted = this.fullName(route as NodeRef) ?? 'REJECT'
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
      sides: [...this.sides.values()].flatMap((side) => (side.record ? [side.record] : [])),
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
    // What the agents on nodes and interfaces saw went through a mihomo that is gone now.
    if (state !== 'running') {
      for (const [id, exit] of this.exits) if (exit.via !== 'system') this.exits.delete(id)
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

/** What an agent's exit depends on: the system's network, its interface, or its node. */
function exitKey(settings: AgentNetworkSettings, agentId: AgentId): string {
  const route = agentRoute(settings, agentId)
  if (route === null) return 'system'
  const bound = routeInterface(route)
  if (bound !== null) return `interface:${bound}`
  const node = route === 'default' ? settings.defaultNode : (route as NodeRef)
  return node ? `node:${node.subscription}:${node.node}` : 'node:none'
}

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-5).join(' ').slice(-800)
}

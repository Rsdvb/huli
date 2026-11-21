// Huli: agents' network through a node of the user's proxy subscriptions. The agent host runs
// mihomo, a separate program, with one local listener per agent that uses a node; an agent's
// proxy variables point at its listener, so its traffic leaves through the node and nowhere
// else. Kite's own traffic keeps the Advanced › Proxy setting. Subscription addresses carry
// tokens: they stay in a file of the host's own, and neither the settings nor any status or event
// holds more of one than its host name. Huli's own; see tools/huli/README.md.

import type { AgentId } from './agents'

/** A node of a subscription, by the subscription's id and the name the subscription gives it. */
export interface NodeRef {
  subscription: string
  node: string
}

/**
 * A network interface an agent's traffic leaves through and through no other, by the name the
 * system gives it, such as a proxy client's TUN or Wi-Fi.
 */
export interface InterfaceRef {
  interface: string
}

/**
 * An agent's choice: a node of its own, one network interface, or the system's network (no node,
 * as without this feature). An agent with no entry follows the default node.
 */
export type AgentNetworkChoice = 'system' | NodeRef | InterfaceRef

/**
 * The way agents without a choice of their own go: a node, or one network interface, as with no
 * subscription. Kept under `defaultNode`, its name before it could be an interface.
 */
export type DefaultRoute = NodeRef | InterfaceRef

/** The settings' part: no subscription address, only names and choices. */
export interface AgentNetworkSettings {
  enabled: boolean
  defaultNode: DefaultRoute | null
  /** Replaced whole by a change; an agent missing from it follows the default node. */
  agents: Partial<Record<AgentId, AgentNetworkChoice>>
  /** The network interface nodes dial out on, over the one found; null to use the one found. */
  interface: string | null
}

export const DEFAULT_AGENT_NETWORK: AgentNetworkSettings = {
  enabled: false,
  defaultNode: null,
  agents: {},
  interface: null,
}

/** The ids the host gives subscriptions. */
export const SUBSCRIPTION_ID = /^[a-f0-9]{12}$/
export const SUBSCRIPTION_NAME_CHARS = 40
export const SUBSCRIPTION_URL_CHARS = 4_096
export const MAX_SUBSCRIPTIONS = 32
/** The most a subscription may hold, downloaded or imported from a file. */
export const MAX_SUBSCRIPTION_BYTES = 10 * 1024 * 1024
export const NODE_NAME_CHARS = 256
export const INTERFACE_NAME_CHARS = 128
/** The most nodes one latency test takes. */
export const MAX_LATENCY_NODES = 500

// Control characters, which no name may hold; `|` too, which separates a node's subscription.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A subscription's name as the host keeps it: spaces folded, no control characters. */
export function cleanSubscriptionName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function isSubscriptionName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === cleanSubscriptionName(value) &&
    value.length > 0 &&
    value.length <= SUBSCRIPTION_NAME_CHARS &&
    !CONTROL.test(value) &&
    !value.includes('|')
  )
}

export function isNodeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= NODE_NAME_CHARS &&
    !CONTROL.test(value)
  )
}

export function isInterfaceName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= INTERFACE_NAME_CHARS &&
    !CONTROL.test(value) &&
    !value.includes('#')
  )
}

/**
 * An interface an agent may be bound to: also without `&` or `=`, which would split the fragment
 * that binds its DNS servers to the interface.
 */
export function isBindableInterface(value: unknown): value is string {
  return isInterfaceName(value) && !/[&=]/.test(value)
}

export function isInterfaceRef(value: unknown): value is InterfaceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return Object.keys(o).length === 1 && isBindableInterface(o.interface)
}

export function isNodeRef(value: unknown): value is NodeRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return (
    Object.keys(o).length === 2 &&
    typeof o.subscription === 'string' &&
    SUBSCRIPTION_ID.test(o.subscription) &&
    isNodeName(o.node)
  )
}

export function isAgentNetworkChoice(value: unknown): value is AgentNetworkChoice {
  return value === 'system' || isNodeRef(value) || isInterfaceRef(value)
}

/** A copy of a valid choice with only its own fields. */
export function cleanChoice(choice: AgentNetworkChoice): AgentNetworkChoice {
  if (choice === 'system') return 'system'
  if ('interface' in choice) return { interface: choice.interface }
  return { subscription: choice.subscription, node: choice.node }
}

export function sameNode(a: NodeRef | null, b: NodeRef | null): boolean {
  return (
    a === b || (a !== null && b !== null && a.subscription === b.subscription && a.node === b.node)
  )
}

/** The way an agent that has a listener goes: the default node, a node, or one interface. */
export type AgentRoute = 'default' | NodeRef | InterfaceRef

/**
 * What the agent goes through: null for the system's network, else the node or interface it asked
 * for, the default interface, or `default` while it follows the default node.
 */
export function agentRoute(settings: AgentNetworkSettings, agentId: AgentId): AgentRoute | null {
  if (!settings.enabled) return null
  const choice = settings.agents[agentId]
  if (choice === 'system') return null
  if (choice) return choice
  const fallback = settings.defaultNode
  return fallback && 'interface' in fallback ? { interface: fallback.interface } : 'default'
}

/** The default node, or null when there is none or the default is an interface. */
export function defaultNodeRef(
  settings: Pick<AgentNetworkSettings, 'defaultNode'>,
): NodeRef | null {
  const fallback = settings.defaultNode
  return fallback && !('interface' in fallback) ? fallback : null
}

export function isDefaultRoute(value: unknown): value is DefaultRoute {
  return isNodeRef(value) || isInterfaceRef(value)
}

/**
 * Where an agent that uses a node never goes through it: loopback, the private and link-local
 * ranges, and Tailscale's addresses and names.
 */
export const NODE_NO_PROXY = [
  'localhost',
  '127.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
  '100.64.0.0/10',
  '.ts.net',
  '.local',
] as const

/** The interface an agent is bound to, or null for one on a node or the system's network. */
export function routeInterface(route: AgentRoute | null): string | null {
  return route !== null && typeof route === 'object' && 'interface' in route
    ? route.interface
    : null
}

/** A network interface of the computer, as the system lists it. */
export interface NetworkInterfaceView {
  name: string
  /** What the system calls the adapter, such as Meta Tunnel or Wi-Fi; null when it says nothing. */
  description: string | null
  /** Connected and able to carry traffic now. */
  up: boolean
  /** Looks like a TUN or VPN adapter that a proxy client or VPN set up. */
  tunnel: boolean
}

export type AgentNetworkState = 'off' | 'starting' | 'running' | 'error'

/**
 * Why the network is not running: the build has no mihomo, no network interface was found, or
 * mihomo did not start or stopped. While it is so, every agent that uses a node has no network.
 */
export type AgentNetworkProblem = 'missing' | 'interface' | 'start' | 'exited'

/** The traffic and expiry a provider reports for a subscription, in bytes and ms since the epoch. */
export interface SubscriptionUsage {
  upload: number
  download: number
  total: number
  expire: number | null
}

export interface SubscriptionView {
  id: string
  name: string
  /** Downloaded from a link and refreshed, or imported from a file and never refreshed. */
  source: 'url' | 'file'
  /** The address's host name alone, the rest of it may carry a token; null for a file. */
  host: string | null
  /** As mihomo read it, else as Kite counted it; null when neither has. */
  nodes: number | null
  /** When it was last downloaded or imported. */
  updatedAt: number | null
  usage: SubscriptionUsage | null
  /** Why the last download failed, masked, while no later one succeeded; the nodes stay. */
  error: string | null
  failedAt: number | null
}

export interface NodeView extends NodeRef {
  /** The node's protocol, as mihomo names it, such as Shadowsocks or Vmess. */
  type: string
  /** The last test's round trip in ms; null when untested, 0 when it failed. */
  delay: number | null
}

export interface AgentNetworkAgent {
  agentId: AgentId
  /** Its listener on 127.0.0.1, which its proxy variables name. */
  port: number | null
  /** The node it asked for; null while it follows the default or is bound to an interface. */
  node: NodeRef | null
  /** The interface it is bound to; null while it goes through a node. */
  interface: string | null
}

/**
 * Where an agent's traffic leaves for the internet, as a request sent the agent's way saw it:
 * through its own listener while it uses a node, else as the system's network sends it.
 */
export interface ExitIp {
  agentId: AgentId
  via: 'node' | 'interface' | 'system'
  /** The public address; null when the request did not get through. */
  ip: string | null
  /** The ISO 3166 code of the address's country or region, such as JP; null when unknown. */
  country: string | null
  /**
   * Why there is no address: nothing answered (for an agent on a node or an interface, it has no
   * network now),
   * or the system's proxy is of a kind the check cannot speak, such as SOCKS.
   */
  failure: 'unreachable' | 'unsupported' | null
  checkedAt: number
}

export interface AgentNetworkStatus {
  /** Whether this host has mihomo; a build without it, or the daemon, has none. */
  available: boolean
  enabled: boolean
  state: AgentNetworkState
  problem: AgentNetworkProblem | null
  /** What mihomo or the system said, masked. */
  detail: string | null
  version: string | null
  /** The interface nodes dial out on now, the one found, and the user's choice. */
  interface: { inUse: string | null; detected: string | null; override: string | null }
  /** The computer's network interfaces as last read; empty until read. */
  interfaces: NetworkInterfaceView[]
  subscriptions: SubscriptionView[]
  /** The agents that go through a node or are bound to an interface. */
  agents: AgentNetworkAgent[]
  /** The latest exit check of each agent that had one, on a node or not. */
  exits: ExitIp[]
}

/**
 * The agent network as a paired device sees it: names, counts, choices and exits, and never a
 * subscription's address, host or token, nor what mihomo said.
 */
export interface AgentNetworkDeviceStatus {
  available: boolean
  enabled: boolean
  state: AgentNetworkState
  problem: AgentNetworkProblem | null
  /** The network interface nodes dial out on now. */
  interface: string | null
  /** The computer's network interfaces an agent may be bound to: names and states alone. */
  interfaces: { name: string; up: boolean; tunnel: boolean }[]
  subscriptions: {
    id: string
    name: string
    nodes: number | null
    usage: SubscriptionUsage | null
  }[]
  /** Empty while the network is not running. */
  nodes: { subscription: string; node: string; delay: number | null }[]
  defaultNode: DefaultRoute | null
  /** Every agent of the host, with `default` for one that follows the default node. */
  agents: { agentId: AgentId; choice: AgentNetworkChoice | 'default' }[]
  exits: ExitIp[]
}

export interface LatencyResult extends NodeRef {
  /** Round trip in ms; null when the node did not answer in time. */
  delay: number | null
}

/** The bytes as a short size for people, such as 12.5 GB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

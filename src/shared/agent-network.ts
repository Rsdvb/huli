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
 * An agent's choice: a node of its own, or the system's network (no node, as without this
 * feature). An agent with no entry follows the default node.
 */
export type AgentNetworkChoice = 'system' | NodeRef

/** The settings' part: no subscription address, only names and choices. */
export interface AgentNetworkSettings {
  enabled: boolean
  defaultNode: NodeRef | null
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
  return value === 'system' || isNodeRef(value)
}

export function sameNode(a: NodeRef | null, b: NodeRef | null): boolean {
  return (
    a === b || (a !== null && b !== null && a.subscription === b.subscription && a.node === b.node)
  )
}

/**
 * What the agent goes through: null for the system's network, else the node it asked for, or
 * `default` while it follows the default node.
 */
export function agentRoute(
  settings: AgentNetworkSettings,
  agentId: AgentId,
): 'default' | NodeRef | null {
  if (!settings.enabled) return null
  const choice = settings.agents[agentId]
  if (choice === 'system') return null
  return choice ?? 'default'
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
  /** The address's host name alone; the rest of it may carry a token. */
  host: string
  /** Null until mihomo has read it. */
  nodes: number | null
  updatedAt: number | null
  usage: SubscriptionUsage | null
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
  /** The node it asked for; null while it follows the default. */
  node: NodeRef | null
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
  subscriptions: SubscriptionView[]
  /** The agents that go through a node. */
  agents: AgentNetworkAgent[]
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

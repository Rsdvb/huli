// mihomo's configuration for the agents' network, as a pure function of what the host knows. It
// fails closed by construction: no listener but the agents' own, each on 127.0.0.1 and bound to a
// group; every group lists REJECT first, so it rejects until the host picks its node through the
// API and again when that node leaves its subscription, and its empty fallback, DIRECT unless
// told otherwise, is REJECT too; nothing names DIRECT; and anything that reached the rules is
// rejected. mihomo downloads nothing: each subscription is a file provider over the nodes Kite
// downloaded or imported, which Kite has mihomo read again through the API. Nodes dial out on the
// physical interface and resolve their servers through DNS over HTTPS bound to it, so neither
// their traffic nor their names go through a TUN another program set up. Keys checked against
// mihomo v1.19.34's source.
//
// An agent bound to one network interface goes through a mihomo of its interface's own, made by
// `interfaceConfig`: its group holds REJECT and a `direct` proxy with `interface-name`, which
// binds every socket to that interface (IP_UNICAST_IF on Windows, IP_BOUND_IF on macOS,
// SO_BINDTODEVICE on Linux) and fails, never falls back, when the interface is gone ("interface
// not found") or down (unreachable). A direct proxy resolves names with the process-wide
// `direct-nameserver`, so one mihomo can bind the names of one interface only; hence one each.
// Its DNS is plain UDP bound to the interface: a TUN's DNS hijack answers it, with a fake IP when
// it runs fake-ip, so the TUN maps the connection back to the name and routes it by its rules.

import type { AgentId } from '@shared/thread'

/** The group every agent that follows the default goes through, and where the default is picked. */
export const DEFAULT_GROUP = 'KITE-DEFAULT'
const AGENT_GROUP_PREFIX = 'KITE-AGENT-'
const PROVIDER_PREFIX = 'kite-sub-'
/** The `direct` proxy bound to the interface, in a mihomo of an interface. */
export const INTERFACE_PROXY = 'KITE-INTERFACE'

/** The address mihomo's health checks and latency tests ask for. */
export const TEST_URL = 'https://www.gstatic.com/generate_204'

/** DNS over HTTPS by address, so no name has to be resolved first; each is bound to the interface. */
const DOH_SERVERS = ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']

/**
 * Plain DNS by address for an interface's agents, so a TUN's DNS hijack sees the query, which DNS
 * over HTTPS would hide from it; each is bound to the interface.
 */
const UDP_SERVERS = ['udp://223.5.5.5', 'udp://119.29.29.29']

/** How often a subscription's nodes are tested, in seconds; only while one is in use. */
const HEALTH_INTERVAL_S = 10 * 60

export interface ConfigSubscription {
  id: string
  name: string
}

export interface ConfigInput {
  controllerPort: number
  secret: string
  /** The physical network interface the nodes and DNS go out on. */
  networkInterface: string
  subscriptions: readonly ConfigSubscription[]
  /** Each agent that goes through a node, with its listener's port. */
  agents: ReadonlyArray<{ agentId: AgentId; port: number }>
}

export function providerName(subscriptionId: string): string {
  return `${PROVIDER_PREFIX}${subscriptionId}`
}

/** The subscription id of a provider Kite wrote, or null for any other. */
export function subscriptionOfProvider(name: string): string | null {
  return name.startsWith(PROVIDER_PREFIX) ? name.slice(PROVIDER_PREFIX.length) : null
}

export function agentGroup(agentId: AgentId): string {
  return `${AGENT_GROUP_PREFIX}${agentId}`
}

/** What mihomo puts before every node name of a subscription, so names stay apart. */
export function nodePrefix(subscriptionName: string): string {
  return `${subscriptionName} | `
}

/** Where a subscription's nodes are kept, under mihomo's home folder. */
export function providerPath(subscriptionId: string): string {
  return `./providers/${subscriptionId}.yaml`
}

function boundDns(networkInterface: string): string[] {
  return DOH_SERVERS.map((server) => `${server}#${networkInterface}`)
}

/**
 * The servers bound to the interface. mihomo reads the fragment as a URL's, decoded, so the name
 * is escaped; a name with `&` or `=`, which would split it, is never bound.
 */
function udpDns(networkInterface: string): string[] {
  return UDP_SERVERS.map((server) => `${server}#${encodeURIComponent(networkInterface)}`)
}

const GROUP = { type: 'select', 'empty-fallback': 'REJECT' }

/** What every mihomo the host runs shares: no listener but the agents', the API on loopback. */
function base(controllerPort: number, secret: string, networkInterface: string) {
  return {
    mode: 'rule',
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    ipv6: false,
    'log-level': 'warning',
    'unified-delay': true,
    'find-process-mode': 'off',
    'geo-auto-update': false,
    'geodata-mode': false,
    // Whatever dials without an interface of its own leaves on this one: the physical interface
    // for the nodes' mihomo, so never through a TUN, and the bound one for an interface's.
    'interface-name': networkInterface,
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret,
    // No web page may call the API, even one that learned the secret.
    'external-controller-cors': { 'allow-origins': [], 'allow-private-network': false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
  }
}

function listeners(agents: ConfigInput['agents']) {
  return agents.map(({ agentId, port }) => ({
    name: `kite-${agentId}`,
    type: 'mixed',
    listen: '127.0.0.1',
    port,
    udp: false,
    users: [],
    proxy: agentGroup(agentId),
  }))
}

/** mihomo's configuration as an object; written as JSON, which YAML reads as it is. */
export function mihomoConfig(input: ConfigInput): Record<string, unknown> {
  const providers = input.subscriptions.map((s) => providerName(s.id))
  const dns = boundDns(input.networkInterface)
  const use = providers.length > 0 ? { use: providers } : {}
  return {
    ...base(input.controllerPort, input.secret, input.networkInterface),
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'normal',
      nameserver: dns,
      'proxy-server-nameserver': dns,
      'direct-nameserver': dns,
      'respect-rules': false,
    },
    'proxy-providers': Object.fromEntries(
      input.subscriptions.map((s) => [
        providerName(s.id),
        {
          type: 'file',
          path: providerPath(s.id),
          'health-check': {
            enable: true,
            url: TEST_URL,
            interval: HEALTH_INTERVAL_S,
            timeout: 5000,
            lazy: true,
          },
          override: {
            'interface-name': input.networkInterface,
            'additional-prefix': nodePrefix(s.name),
          },
        },
      ]),
    ),
    'proxy-groups': [
      { name: DEFAULT_GROUP, ...GROUP, proxies: ['REJECT'], ...use },
      ...input.agents.map(({ agentId }) => ({
        name: agentGroup(agentId),
        ...GROUP,
        proxies: ['REJECT', DEFAULT_GROUP],
        ...use,
      })),
    ],
    listeners: listeners(input.agents),
    rules: ['MATCH,REJECT'],
  }
}

export interface InterfaceConfigInput {
  controllerPort: number
  secret: string
  /** The interface these agents' traffic and names leave through, and no other. */
  networkInterface: string
  agents: ConfigInput['agents']
}

/**
 * The configuration of the mihomo for the agents bound to one interface. Each agent's group holds
 * REJECT first, which it stays on until the host picks the interface's `direct` proxy, and that
 * proxy alone; the global DIRECT is in no group, and anything that reached the rules is rejected.
 */
export function interfaceConfig(input: InterfaceConfigInput): Record<string, unknown> {
  const dns = udpDns(input.networkInterface)
  return {
    ...base(input.controllerPort, input.secret, input.networkInterface),
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'normal',
      nameserver: dns,
      'proxy-server-nameserver': dns,
      'direct-nameserver': dns,
      'respect-rules': false,
    },
    proxies: [{ name: INTERFACE_PROXY, type: 'direct', 'interface-name': input.networkInterface }],
    'proxy-groups': input.agents.map(({ agentId }) => ({
      name: agentGroup(agentId),
      ...GROUP,
      proxies: ['REJECT', INTERFACE_PROXY],
    })),
    listeners: listeners(input.agents),
    rules: ['MATCH,REJECT'],
  }
}

export function serializeConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

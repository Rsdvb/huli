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

import type { AgentId } from '@shared/thread'

/** The group every agent that follows the default goes through, and where the default is picked. */
export const DEFAULT_GROUP = 'KITE-DEFAULT'
const AGENT_GROUP_PREFIX = 'KITE-AGENT-'
const PROVIDER_PREFIX = 'kite-sub-'

/** The address mihomo's health checks and latency tests ask for. */
export const TEST_URL = 'https://www.gstatic.com/generate_204'

/** DNS over HTTPS by address, so no name has to be resolved first; each is bound to the interface. */
const DOH_SERVERS = ['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']

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

/** mihomo's configuration as an object; written as JSON, which YAML reads as it is. */
export function mihomoConfig(input: ConfigInput): Record<string, unknown> {
  const providers = input.subscriptions.map((s) => providerName(s.id))
  const dns = boundDns(input.networkInterface)
  const use = providers.length > 0 ? { use: providers } : {}
  const group = { type: 'select', 'empty-fallback': 'REJECT' }
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
    // Nothing dials directly now that mihomo reads no subscription; should anything still, such as
    // a key a later mihomo adds, it leaves on the physical interface and never through a TUN.
    'interface-name': input.networkInterface,
    'external-controller': `127.0.0.1:${input.controllerPort}`,
    secret: input.secret,
    // No web page may call the API, even one that learned the secret.
    'external-controller-cors': { 'allow-origins': [], 'allow-private-network': false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
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
      { name: DEFAULT_GROUP, ...group, proxies: ['REJECT'], ...use },
      ...input.agents.map(({ agentId }) => ({
        name: agentGroup(agentId),
        ...group,
        proxies: ['REJECT', DEFAULT_GROUP],
        ...use,
      })),
    ],
    listeners: input.agents.map(({ agentId, port }) => ({
      name: `kite-${agentId}`,
      type: 'mixed',
      listen: '127.0.0.1',
      port,
      udp: false,
      users: [],
      proxy: agentGroup(agentId),
    })),
    rules: ['MATCH,REJECT'],
  }
}

export function serializeConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

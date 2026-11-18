// The agents' network's files in the host's data folder. Subscriptions hold their addresses, which
// carry the provider's token: they live in a file of their own, never in the settings, and leave
// it only for mihomo's configuration. The state file holds what is no secret: the listeners'
// ports, kept so an agent's proxy variables stay valid across restarts, and the mihomo the host
// last started, so a host after a crash can stop the one it left running.

import path from 'node:path'
import {
  isSubscriptionName,
  MAX_SUBSCRIPTIONS,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_URL_CHARS,
} from '@shared/agent-network'
import { isAgentId, type AgentId } from '@shared/thread'
import { JsonFile, type LogFn } from '../storage'

export interface StoredSubscription {
  id: string
  name: string
  url: string
  addedAt: number
}

export interface SubscriptionsFile {
  version: 1
  subscriptions: StoredSubscription[]
}

export interface NetworkStateFile {
  version: 1
  ports: Partial<Record<AgentId, number>>
  /** The mihomo last started: its process and how to reach its API, to stop it after a crash. */
  running: { pid: number; controllerPort: number; secret: string } | null
}

/** An http(s) address with a host and no spaces; its token, if any, is the provider's business. */
export function isSubscriptionUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SUBSCRIPTION_URL_CHARS) return false
  if (/\s/.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0
}

/** The address's host alone, which is all of it anything outside the host is shown. */
export function subscriptionHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * The parts of a subscription address the logs must never show: the whole address, and its path,
 * query and credentials, each of which may carry the token alone.
 */
export function subscriptionSecrets(url: string): string[] {
  const out = new Set<string>([url])
  try {
    const parsed = new URL(url)
    for (const part of [
      parsed.href,
      parsed.pathname,
      parsed.search,
      parsed.search.slice(1),
      parsed.hash,
      parsed.username,
      parsed.password,
      `${parsed.pathname}${parsed.search}`,
    ]) {
      if (part && part !== '/') out.add(part)
    }
    // A token alone, without masking every common word such as `subscribe` in the logs.
    for (const part of [...parsed.searchParams.values(), ...parsed.pathname.split('/')]) {
      if (part.length >= 16 || (part.length >= 8 && /\d/.test(part))) out.add(part)
    }
  } catch {
    // Not an address: the whole of it is masked.
  }
  return [...out]
}

export function parseSubscriptionsFile(data: Record<string, unknown>): SubscriptionsFile | string {
  if (!Array.isArray(data.subscriptions)) return 'subscriptions is not a list'
  const seen = new Set<string>()
  const names = new Set<string>()
  const subscriptions: StoredSubscription[] = []
  for (const item of data.subscriptions.slice(0, MAX_SUBSCRIPTIONS)) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || !SUBSCRIPTION_ID.test(o.id) || seen.has(o.id)) continue
    if (!isSubscriptionName(o.name) || names.has(o.name.toLowerCase())) continue
    if (!isSubscriptionUrl(o.url)) continue
    seen.add(o.id)
    names.add(o.name.toLowerCase())
    subscriptions.push({
      id: o.id,
      name: o.name,
      url: o.url,
      addedAt: typeof o.addedAt === 'number' && Number.isFinite(o.addedAt) ? o.addedAt : 0,
    })
  }
  return { version: 1, subscriptions }
}

function isPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

export function parseNetworkStateFile(data: Record<string, unknown>): NetworkStateFile | string {
  const ports: NetworkStateFile['ports'] = {}
  if (typeof data.ports === 'object' && data.ports !== null && !Array.isArray(data.ports)) {
    for (const [id, port] of Object.entries(data.ports)) {
      if (isAgentId(id) && isPortNumber(port)) ports[id] = port
    }
  }
  let running: NetworkStateFile['running'] = null
  const r = data.running
  if (typeof r === 'object' && r !== null) {
    const o = r as Record<string, unknown>
    if (
      typeof o.pid === 'number' &&
      Number.isInteger(o.pid) &&
      o.pid > 0 &&
      isPortNumber(o.controllerPort) &&
      typeof o.secret === 'string' &&
      /^[a-f0-9]{32,128}$/.test(o.secret)
    ) {
      running = { pid: o.pid, controllerPort: o.controllerPort, secret: o.secret }
    }
  }
  return { version: 1, ports, running }
}

/** The folder of mihomo's home, its configuration and the subscriptions' node lists. */
export function networkFolder(userDataPath: string): string {
  return path.join(userDataPath, 'agent-network')
}

export function subscriptionsFile(userDataPath: string, log: LogFn): JsonFile<SubscriptionsFile> {
  return new JsonFile<SubscriptionsFile>({
    file: path.join(networkFolder(userDataPath), 'subscriptions.json'),
    version: 1,
    migrations: {},
    parse: parseSubscriptionsFile,
    empty: () => ({ version: 1, subscriptions: [] }),
    log,
    debounceMs: 0,
  })
}

export function networkStateFile(userDataPath: string, log: LogFn): JsonFile<NetworkStateFile> {
  return new JsonFile<NetworkStateFile>({
    file: path.join(userDataPath, 'state', 'agent-network.json'),
    version: 1,
    migrations: {},
    parse: parseNetworkStateFile,
    empty: () => ({ version: 1, ports: {}, running: null }),
    log,
    debounceMs: 0,
  })
}

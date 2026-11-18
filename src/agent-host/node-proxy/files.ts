// The agents' network's files in the host's data folder. Subscriptions hold their addresses, which
// carry the provider's token: they live in a file of their own, never in the settings, and leave
// it only for Kite's own download of them. The nodes they hold, which carry the nodes' passwords,
// go into mihomo's home, one file each. The state file holds what is no secret: the listeners'
// ports, kept so an agent's proxy variables stay valid across restarts, the mihomo processes the
// host last started, so a host after a crash can stop those it left running, and each
// subscription's last download: when, its traffic and expiry, and why it failed.

import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  isSubscriptionName,
  type SubscriptionUsage,
  MAX_SUBSCRIPTIONS,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_URL_CHARS,
} from '@shared/agent-network'
import { isAgentId, type AgentId } from '@shared/thread'
import { JsonFile, type LogFn } from '../storage'

export interface StoredSubscription {
  id: string
  name: string
  /** Null for one imported from a file, which is never downloaded again. */
  url: string | null
  addedAt: number
}

/** A subscription's last download or import; no secret. */
export interface SubscriptionRecord {
  /** When its nodes were last written. */
  updatedAt: number | null
  usage: SubscriptionUsage | null
  /** The nodes Kite counted in it. */
  nodes: number | null
  /** Why the last download failed, masked; null once one succeeds. */
  error: string | null
  failedAt: number | null
}

export const EMPTY_RECORD: SubscriptionRecord = {
  updatedAt: null,
  usage: null,
  nodes: null,
  error: null,
  failedAt: null,
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
  /** The mihomo of each interface agents were bound to, started with the one above. */
  sides: { pid: number; controllerPort: number; secret: string }[]
  subscriptions: Record<string, SubscriptionRecord>
}

/** More interfaces than agents are bound to, with room to spare. */
const MAX_SIDES = 64

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
    if (o.url !== null && !isSubscriptionUrl(o.url)) continue
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
  const running = parseRunning(data.running)
  const sides = (Array.isArray(data.sides) ? data.sides.slice(0, MAX_SIDES) : []).flatMap(
    (value: unknown) => {
      const side = parseRunning(value)
      return side ? [side] : []
    },
  )
  const subscriptions: NetworkStateFile['subscriptions'] = {}
  const records = data.subscriptions
  if (typeof records === 'object' && records !== null && !Array.isArray(records)) {
    for (const [id, value] of Object.entries(records).slice(0, MAX_SUBSCRIPTIONS)) {
      if (SUBSCRIPTION_ID.test(id)) subscriptions[id] = parseRecord(value)
    }
  }
  return { version: 1, ports, running, sides, subscriptions }
}

function parseRunning(value: unknown): NetworkStateFile['running'] {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (
    typeof o.pid === 'number' &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    isPortNumber(o.controllerPort) &&
    typeof o.secret === 'string' &&
    /^[a-f0-9]{32,128}$/.test(o.secret)
  ) {
    return { pid: o.pid, controllerPort: o.controllerPort, secret: o.secret }
  }
  return null
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseRecord(value: unknown): SubscriptionRecord {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_RECORD }
  const o = value as Record<string, unknown>
  let usage: SubscriptionUsage | null = null
  if (typeof o.usage === 'object' && o.usage !== null) {
    const u = o.usage as Record<string, unknown>
    const [upload, download, total] = [count(u.upload), count(u.download), count(u.total)]
    if (upload !== null && download !== null && total !== null) {
      usage = { upload, download, total, expire: time(u.expire) }
    }
  }
  return {
    updatedAt: time(o.updatedAt),
    usage,
    nodes: count(o.nodes),
    error: typeof o.error === 'string' && o.error.length > 0 ? o.error.slice(0, 500) : null,
    failedAt: time(o.failedAt),
  }
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
    empty: () => ({ version: 1, ports: {}, running: null, sides: [], subscriptions: {} }),
    log,
    debounceMs: 0,
  })
}

/** The file of a subscription's nodes, which mihomo's provider reads as `providerPath` names it. */
export function providerFile(userDataPath: string, subscriptionId: string): string {
  return path.join(networkFolder(userDataPath), 'mihomo', 'providers', `${subscriptionId}.yaml`)
}

/**
 * Writes the file whole or not at all, readable by the user alone: a reader, mihomo or a host
 * after a crash, sees the old content or the new, never part of either.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, data, { mode: 0o600 })
    // Windows refuses to replace a file another process has open; mihomo reads it only briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

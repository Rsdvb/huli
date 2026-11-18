// A client of mihomo's REST API, which listens on 127.0.0.1 only and answers only with the secret
// the host gave it at start.

import type { SubscriptionUsage } from '@shared/agent-network'

const CALL_MS = 10_000

export class MihomoApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'MihomoApiError'
  }
}

export interface ProxyInfo {
  name: string
  type: string
  /** The member a group has picked. */
  now?: string
  /** A group's members. */
  all?: string[]
  /** The latest test's round trip in ms, 0 when it failed; undefined when never tested. */
  delay?: number
}

export interface ProviderInfo {
  name: string
  proxies: ProxyInfo[]
  /** When the subscription was last read, as mihomo writes times. */
  updatedAt: string | null
  usage: SubscriptionUsage | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function lastDelay(history: unknown): number | undefined {
  if (!Array.isArray(history) || history.length === 0) return undefined
  const last: unknown = history[history.length - 1]
  return isRecord(last) ? (num(last.delay) ?? undefined) : undefined
}

export function parseProxy(name: string, value: unknown): ProxyInfo | null {
  if (!isRecord(value)) return null
  const info: ProxyInfo = { name, type: typeof value.type === 'string' ? value.type : 'Unknown' }
  if (typeof value.now === 'string') info.now = value.now
  if (Array.isArray(value.all)) {
    info.all = value.all.filter((item): item is string => typeof item === 'string')
  }
  const delay = lastDelay(value.history)
  if (delay !== undefined) info.delay = delay
  return info
}

/** The traffic a subscription's provider reports, in the shape mihomo gives it. */
export function parseUsage(value: unknown): SubscriptionUsage | null {
  if (!isRecord(value)) return null
  const upload = num(value.Upload)
  const download = num(value.Download)
  const total = num(value.Total)
  if (upload === null || download === null || total === null) return null
  const expire = num(value.Expire)
  // mihomo gives the expiry in seconds; 0 means none.
  return { upload, download, total, expire: expire ? expire * 1000 : null }
}

export function parseProviders(value: unknown): ProviderInfo[] {
  if (!isRecord(value) || !isRecord(value.providers)) return []
  const out: ProviderInfo[] = []
  for (const [name, provider] of Object.entries(value.providers)) {
    if (!isRecord(provider)) continue
    const proxies = Array.isArray(provider.proxies)
      ? provider.proxies.flatMap((proxy: unknown) =>
          isRecord(proxy) && typeof proxy.name === 'string'
            ? (parseProxy(proxy.name, proxy) ?? [])
            : [],
        )
      : []
    out.push({
      name,
      proxies,
      updatedAt: typeof provider.updatedAt === 'string' ? provider.updatedAt : null,
      usage: parseUsage(provider.subscriptionInfo),
    })
  }
  return out
}

export class MihomoApi {
  constructor(
    private readonly port: number,
    private readonly secret: string,
  ) {}

  private async call(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
    timeoutMs = CALL_MS,
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new MihomoApiError(`mihomo did not answer: ${(error as Error).message}`, null)
    }
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300)
      try {
        const parsed: unknown = JSON.parse(text)
        if (isRecord(parsed) && typeof parsed.message === 'string') message = parsed.message
      } catch {
        // Not JSON: the text itself says what went wrong.
      }
      throw new MihomoApiError(`mihomo answered ${response.status}: ${message}`, response.status)
    }
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  }

  async version(): Promise<string | null> {
    const result = await this.call('GET', '/version', undefined, 2_000)
    return isRecord(result) && typeof result.version === 'string' ? result.version : null
  }

  async proxies(): Promise<Map<string, ProxyInfo>> {
    const result = await this.call('GET', '/proxies')
    const out = new Map<string, ProxyInfo>()
    if (!isRecord(result) || !isRecord(result.proxies)) return out
    for (const [name, value] of Object.entries(result.proxies)) {
      const info = parseProxy(name, value)
      if (info) out.set(name, info)
    }
    return out
  }

  async select(group: string, name: string): Promise<void> {
    await this.call('PUT', `/proxies/${encodeURIComponent(group)}`, { name })
  }

  async providers(): Promise<ProviderInfo[]> {
    return parseProviders(await this.call('GET', '/providers/proxies'))
  }

  /** Reads the subscription again now. */
  async updateProvider(name: string): Promise<void> {
    await this.call('PUT', `/providers/proxies/${encodeURIComponent(name)}`, undefined, 60_000)
  }

  /** The node's round trip to `url` in ms; null when it did not answer in time. */
  async delay(name: string, url: string, timeoutMs: number): Promise<number | null> {
    const query = `url=${encodeURIComponent(url)}&timeout=${timeoutMs}`
    try {
      const result = await this.call(
        'GET',
        `/proxies/${encodeURIComponent(name)}/delay?${query}`,
        undefined,
        timeoutMs + 5_000,
      )
      return isRecord(result) ? num(result.delay) : null
    } catch (error) {
      // 503 and 504: the node failed or timed out, which is the answer.
      if (error instanceof MihomoApiError && error.status !== null) return null
      throw error
    }
  }
}

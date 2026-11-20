// Huli: downloads a subscription the way Kite's own requests go: through the proxy Settings ›
// Advanced or the environment names, else directly, which a Clash or Karing TUN still catches.
// Many providers cannot be reached in China without a proxy, so this path, not the nodes' physical
// interface, reads them; the list of nodes says nothing about who uses them. The agents' traffic
// still goes through the nodes alone. Huli's own; see tools/huli/README.md.

import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { MAX_SUBSCRIPTION_BYTES } from '@shared/agent-network'
import { bypassesProxy } from './exit-ip'

/** The mihomo Kite ships, as `tools/install/mihomo.mjs` pins it. */
export const MIHOMO_VERSION = '1.19.34'
/** What mihomo's own provider sends, so a provider answers with the Clash YAML mihomo reads. */
export const SUBSCRIPTION_USER_AGENT = `clash.meta mihomo/${MIHOMO_VERSION}`
export const DOWNLOAD_TIMEOUT_MS = 30_000
export const MAX_REDIRECTS = 5

/** A proxy a download goes through. */
export interface DownloadHop {
  kind: 'http' | 'https' | 'socks5'
  host: string
  port: number
  user: string | null
  password: string | null
}

/** The proxy variables of Kite's own requests, as its environment and settings give them. */
export interface ProxyVariables {
  http: string | null
  https: string | null
  all: string | null
  noProxy: string | null
}

export interface Downloaded {
  body: Buffer
  /** The `subscription-userinfo` header, which carries the traffic and expiry. */
  userinfo: string | null
}

export interface DownloadOptions {
  /** The proxy for this address, or null to go directly; it throws for one it cannot speak. */
  route: (url: URL) => DownloadHop | null
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

/** A proxy variable's value as a hop; null for none. Throws for a kind it cannot speak. */
export function parseDownloadHop(value: string | null | undefined): DownloadHop | null {
  const text = value?.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`)
  } catch {
    throw new Error('The proxy setting is not an address')
  }
  const kind =
    url.protocol === 'http:'
      ? 'http'
      : url.protocol === 'https:'
        ? 'https'
        : ['socks:', 'socks5:', 'socks5h:'].includes(url.protocol)
          ? 'socks5'
          : null
  if (!kind || !url.hostname) throw new Error(`A ${url.protocol} proxy is not supported`)
  const fallback = kind === 'http' ? 80 : kind === 'https' ? 443 : 1080
  return {
    kind,
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : fallback,
    user: url.username ? decodeURIComponent(url.username) : null,
    password: url.username ? decodeURIComponent(url.password) : null,
  }
}

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

/** The route of Kite's own requests: the scheme's proxy variable, else ALL_PROXY, but NO_PROXY. */
export function routeFor(variables: ProxyVariables): (url: URL) => DownloadHop | null {
  return (url) => {
    if (isLoopback(url.hostname)) return null
    if (bypassesProxy(variables.noProxy, url.hostname.toLowerCase())) return null
    const value = (url.protocol === 'https:' ? variables.https : variables.http) ?? variables.all
    return parseDownloadHop(value)
  }
}

/** Reads a socket's bytes on demand, then hands back what it read past the answer. */
class SocketReader {
  private buffer = Buffer.alloc(0)
  private waiting: (() => void) | null = null
  private failed: Error | null = null
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.waiting?.()
  }
  private readonly onEnd = (): void => this.fail(new Error('The proxy closed the connection'))
  private readonly onError = (error: Error): void => this.fail(error)

  constructor(private readonly socket: Duplex) {
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('error', this.onError)
  }

  private fail(error: Error): void {
    this.failed ??= error
    this.waiting?.()
  }

  private async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.failed) throw this.failed
      await new Promise<void>((resolve) => (this.waiting = resolve))
      this.waiting = null
    }
  }

  async bytes(count: number): Promise<Buffer> {
    await this.until(() => this.buffer.length >= count)
    const out = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return out
  }

  /** Up to and with the blank line that ends an HTTP head. */
  async head(limit = 16 * 1024): Promise<string> {
    await this.until(() => {
      if (this.buffer.length > limit) this.fail(new Error('The proxy answered too much'))
      return this.buffer.includes('\r\n\r\n')
    })
    const end = this.buffer.indexOf('\r\n\r\n') + 4
    const out = this.buffer.subarray(0, end).toString('latin1')
    this.buffer = this.buffer.subarray(end)
    return out
  }

  release(): void {
    this.socket.off('data', this.onData)
    this.socket.off('end', this.onEnd)
    this.socket.off('error', this.onError)
    this.socket.pause()
    if (this.buffer.length > 0) this.socket.unshift(this.buffer)
  }
}

function connected(socket: Socket, secure: boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      socket.destroy()
      reject(signal.reason as Error)
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      signal.removeEventListener('abort', abort)
      resolve()
    })
    socket.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

async function socksHandshake(
  socket: Socket,
  hop: DownloadHop,
  host: string,
  port: number,
): Promise<void> {
  const reader = new SocketReader(socket)
  try {
    socket.write(Buffer.from(hop.user !== null ? [5, 2, 0, 2] : [5, 1, 0]))
    const [version, method] = await reader.bytes(2)
    if (version !== 5) throw new Error('The proxy does not speak SOCKS5')
    if (method === 2 && hop.user !== null) {
      const user = Buffer.from(hop.user)
      const password = Buffer.from(hop.password ?? '')
      if (user.length > 255 || password.length > 255) throw new Error('The proxy login is too long')
      socket.write(
        Buffer.concat([
          Buffer.from([1, user.length]),
          user,
          Buffer.from([password.length]),
          password,
        ]),
      )
      if ((await reader.bytes(2))[1] !== 0) throw new Error('The proxy refused the login')
    } else if (method !== 0) {
      throw new Error('The proxy wants a login it was not given')
    }
    const family = isIP(host)
    let address: Buffer
    if (family === 4) address = Buffer.from([1, ...host.split('.').map(Number)])
    else if (family === 6) {
      const groups = new URL(`http://[${host}]`).hostname.slice(1, -1)
      address = Buffer.concat([Buffer.from([4]), ipv6Bytes(groups)])
    } else {
      const name = Buffer.from(host)
      if (name.length > 255) throw new Error('The host name is too long')
      address = Buffer.concat([Buffer.from([3, name.length]), name])
    }
    const portBytes = Buffer.from([port >> 8, port & 0xff])
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes]))
    const [, reply, , kind] = await reader.bytes(4)
    if (reply !== 0) throw new Error(`The proxy refused the connection (SOCKS ${reply})`)
    const length =
      kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? (await reader.bytes(1))[0]! : null
    if (length === null) throw new Error('The proxy answered an unknown address')
    await reader.bytes(length + 2)
  } finally {
    reader.release()
  }
}

/** A normalized IPv6 address, as URL writes it, as 16 bytes. */
function ipv6Bytes(address: string): Buffer {
  const [head = '', tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  const out = Buffer.alloc(16)
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group, 16), index * 2))
  return out
}

async function connectHandshake(
  socket: Duplex,
  hop: DownloadHop,
  host: string,
  port: number,
): Promise<void> {
  const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
  const auth =
    hop.user !== null
      ? `Proxy-Authorization: Basic ${Buffer.from(`${hop.user}:${hop.password ?? ''}`).toString('base64')}\r\n`
      : ''
  const reader = new SocketReader(socket)
  try {
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    const head = await reader.head()
    const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head)?.[1]
    if (status === undefined || !status.startsWith('2')) {
      throw new Error(`The proxy answered ${status ?? 'something else'}`)
    }
  } finally {
    reader.release()
  }
}

/**
 * A connection to `host:port` through the hop: a tunnel by CONNECT or SOCKS5. Every hop gets a
 * tunnel, for http addresses too, so one path serves all of them.
 */
async function tunnel(
  hop: DownloadHop,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  const socket =
    hop.kind === 'https'
      ? tlsConnect({
          host: hop.host,
          port: hop.port,
          ...(isIP(hop.host) ? {} : { servername: hop.host }),
        })
      : netConnect({ host: hop.host, port: hop.port })
  const abort = (): void => {
    socket.destroy()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await connected(socket, hop.kind === 'https', signal)
    if (hop.kind === 'socks5') await socksHandshake(socket, hop, host, port)
    else await connectHandshake(socket, hop, host, port)
    return socket
  } catch (error) {
    socket.destroy()
    throw signal.aborted ? (signal.reason as Error) : error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

const SUBSCRIPTION_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': SUBSCRIPTION_USER_AGENT,
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
}

/**
 * One GET of `url`, directly or through the hop's tunnel, with no redirect followed. Kite's own
 * Node.js downloads go this way too, with headers of their own.
 */
export function request(
  url: URL,
  hop: DownloadHop | null,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>> = SUBSCRIPTION_HEADERS,
): Promise<IncomingMessage> {
  const secure = url.protocol === 'https:'
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  return (async () => {
    const socket = hop ? await tunnel(hop, host, port, signal) : null
    return new Promise<IncomingMessage>((resolve, reject) => {
      const auth = url.username
        ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
        : undefined
      const req = (secure ? https : http).request(
        {
          host,
          port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          // Node ignores createConnection for a request with an agent, `agent: false` too.
          ...(socket ? {} : { agent: false }),
          signal,
          ...(auth ? { auth } : {}),
          headers: { ...headers },
          ...(socket
            ? {
                createConnection: () => {
                  // The handshake paused it to keep what it read past the answer; read on.
                  socket.resume()
                  return secure
                    ? tlsConnect({ socket, ...(isIP(host) ? {} : { servername: host }) })
                    : socket
                },
              }
            : {}),
        },
        resolve,
      )
      req.once('error', (error) => {
        socket?.destroy()
        reject(error)
      })
      req.end()
    })
  })()
}

function tooLarge(maxBytes: number): Error {
  return new Error(`The subscription is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`)
}

/** The body, decoded as the server encoded it, refused past `maxBytes` either way. */
function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers['content-length'])
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (Number.isFinite(declared) && declared > maxBytes && !encoding) {
    response.destroy()
    return Promise.reject(tooLarge(maxBytes))
  }
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null
  if (encoding && encoding !== 'identity' && !decoder) {
    response.destroy()
    return Promise.reject(new Error(`The provider sent an unknown encoding: ${encoding}`))
  }
  const stream = decoder ? response.pipe(decoder) : response
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const fail = (error: Error): void => {
      response.destroy()
      decoder?.destroy()
      reject(error)
    }
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) fail(tooLarge(maxBytes))
      else chunks.push(chunk)
    })
    stream.once('end', () => resolve(Buffer.concat(chunks)))
    stream.once('error', fail)
    if (decoder) response.once('error', fail)
  })
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * The subscription at `url`: http(s) alone, a few redirects that stay http(s), a capped body and
 * one deadline for all of it. No message names the address, which may carry a token.
 */
export async function downloadSubscription(
  url: string,
  options: DownloadOptions,
): Promise<Downloaded> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_SUBSCRIPTION_BYTES
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const signal = AbortSignal.timeout(timeoutMs)
  let current = new URL(url)
  try {
    for (let redirects = 0; ; redirects++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('The subscription is not an http or https address')
      }
      const response = await request(current, options.route(current), signal)
      const status = response.statusCode ?? 0
      if (REDIRECTS.has(status)) {
        response.resume()
        const location = response.headers.location
        if (!location) throw new Error(`The provider answered ${status} without a location`)
        if (redirects >= maxRedirects) throw new Error('The provider redirected too many times')
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new Error('The provider redirected to something that is not an address')
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error('The provider redirected to an address that is not http or https')
        }
        current = next
        continue
      }
      if (status < 200 || status > 299) {
        response.resume()
        throw new Error(`The provider answered ${status}`)
      }
      const header = response.headers['subscription-userinfo']
      const userinfo = Array.isArray(header) ? (header[0] ?? null) : (header ?? null)
      return { body: await readBody(response, maxBytes), userinfo }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`, { cause: error })
    }
    throw error
  }
}

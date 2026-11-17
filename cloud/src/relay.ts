// Huli's relay, the protocol of src/shared/remote/relay.ts as its clients speak it. A host keeps a
// control socket at /v1/hosts/<id>, signed in with the Ed25519 key its id is derived from and a
// token of the account; a device opens /v1/hosts/<id>/connect with a token of the same account,
// the host is told `incoming` and opens /v1/hosts/<id>/accept/<token>, and the relay joins the two
// sockets. From then on it passes binary messages unchanged: the channel's Noise messages, which it
// cannot read. It answers the text `ping` with `pong` on any socket, keeps every limit the clients
// expect (64 KiB a message, 16 devices a host, the sign-in, connect and accept timeouts), and logs
// events and close codes, never what passes. GET /v1, /v1/regions, /v1/ping and /v1/hosts answer
// over HTTP, to browsers of the hosted web client too.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  ACCEPT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  HOSTS_FEATURE,
  MAX_DEVICE_CONNECTIONS,
  MAX_LISTED_HOSTS,
  MAX_RELAY_MESSAGE,
  PING,
  PONG,
  REGIONS_FEATURE,
  RELAY_CLOSE,
  RELAY_PROTOCOL,
  RELAY_TOKENS_FEATURE,
  SIGN_IN_TIMEOUT_MS,
  TOKEN_GRACE_MS,
  decodeRelayBytes,
  newRelayToken,
  parseDeviceToRelay,
  parseHostToRelay,
  relayHostId,
  signInText,
  verifyRelaySignature,
  type RelayHostProfile,
  type RelayInfo,
  type RelayListedHost,
} from '@shared/remote/relay'
import { bearer, clientAddress, Limiter } from './http'
import type { RelayGrant, RelayTokens } from './relay-tokens'
import { sha256Hex } from './secrets'

export interface RelayLimits {
  /** Sockets at once, in all and from one address. */
  maxSockets: number
  maxSocketsPerAddress: number
  /** Sockets one address may open in a minute. */
  opensPerMinute: number
  /** Sign-ins of one host id in a minute, so two copies replacing each other slow down. */
  signInsPerMinute: number
  /** Tokens refused from one address in 15 minutes before it is refused outright. */
  refusalsPer15Minutes: number
  /** Hosts signed in at once. */
  maxHosts: number
  /** A control socket that sends nothing for this long is closed; hosts ping every 30 s. */
  hostIdleMs: number
  /** A joined pair that carries nothing either way for this long is closed. */
  joinedIdleMs: number
  /** How often every socket gets a WebSocket ping; one without its pong by the next is cut. */
  pingMs: number
  /** How often a signed-in host's token is checked again: signed out, or lapsed past the grace. */
  tokenCheckMs: number
  /** Bytes queued toward one side before the other is paused, and resumed below the low mark. */
  highWater: number
  lowWater: number
}

export const RELAY_LIMITS: RelayLimits = {
  maxSockets: 512,
  maxSocketsPerAddress: 64,
  opensPerMinute: 120,
  signInsPerMinute: 10,
  refusalsPer15Minutes: 20,
  maxHosts: MAX_LISTED_HOSTS,
  hostIdleMs: 90_000,
  joinedIdleMs: 5 * 60_000,
  pingMs: 30_000,
  tokenCheckMs: 60_000,
  highWater: 1024 * 1024,
  lowWater: 256 * 1024,
}

export interface RelayOptions {
  /** The relay's public origin, which hosts sign. */
  origin: string
  /** Origins of pages that may use it from a browser: the hosted web client's. */
  webOrigins: readonly string[]
  /** The region this relay is, as GET /v1 names it. */
  regionId: string
  /** The signed region list as served, or null for none. */
  regions: string | null
  tokens: Pick<RelayTokens, 'check' | 'holds'>
  trustProxy: boolean
  limits?: Partial<RelayLimits>
  now?: () => number
  log?: (line: string) => void
}

interface Host {
  socket: WebSocket
  grant: RelayGrant
  profile: RelayHostProfile | null
}

interface Waiting {
  device: WebSocket
  host: string
  timer: ReturnType<typeof setTimeout>
}

/** What the relay keeps of each socket. */
interface Peer {
  address: string
  /** Whether it answered the last WebSocket ping. */
  alive: boolean
  /** Bytes sent to it not yet written out. */
  queued: number
}

const PATH = /^\/v1\/hosts\/([a-z2-7]{26})(?:\/(connect)|\/accept\/([A-Za-z0-9_-]{16,128}))?$/

/** Close codes a relay may send on; 1005 and 1006 only ever describe a close. */
function sendable(code: number): number {
  return code === 1000 || code === 1001 || code === 1009 || (code >= 4000 && code < 5000)
    ? code
    : 1000
}

const short = (id: string): string => id.slice(0, 8)

export class Relay {
  private readonly sockets: WebSocketServer
  private readonly limits: RelayLimits
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly hosts = new Map<string, Host>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly joined = new Map<WebSocket, WebSocket>()
  /** The host each joined pair is for, by the pair's accept side. */
  private readonly joinedHosts = new Map<WebSocket, string>()
  private readonly peers = new Map<WebSocket, Peer>()
  private readonly perAddress = new Map<string, number>()
  private readonly opens: Limiter
  private readonly signIns: Limiter
  private readonly refusals: Limiter
  private readonly regionsTag: string | null
  private readonly sweeper: ReturnType<typeof setInterval>
  private readonly checker: ReturnType<typeof setInterval>

  constructor(private readonly options: RelayOptions) {
    this.limits = { ...RELAY_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(line))
    this.opens = new Limiter(60_000, this.limits.opensPerMinute, this.now)
    this.signIns = new Limiter(60_000, this.limits.signInsPerMinute, this.now)
    this.refusals = new Limiter(15 * 60_000, this.limits.refusalsPer15Minutes, this.now)
    this.regionsTag = options.regions ? `"${sha256Hex(options.regions).slice(0, 32)}"` : null
    this.sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_RELAY_MESSAGE,
      perMessageDeflate: false,
      clientTracking: false,
    })
    this.sweeper = setInterval(() => this.ping(), this.limits.pingMs)
    this.sweeper.unref()
    this.checker = setInterval(() => this.checkHosts(), this.limits.tokenCheckMs)
    this.checker.unref()
  }

  /** What GET /v1 answers. */
  info(): RelayInfo {
    const features = [HOSTS_FEATURE, RELAY_TOKENS_FEATURE]
    if (this.options.regions) features.splice(1, 0, REGIONS_FEATURE)
    return {
      relay: 'kettu',
      protocol: RELAY_PROTOCOL,
      regions: [{ id: this.options.regionId, url: this.options.origin }],
      features,
    }
  }

  /** Hosts signed in now, and devices waiting or joined; for the health check and tests. */
  counts(): { hosts: number; waiting: number; joined: number; sockets: number } {
    return {
      hosts: this.hosts.size,
      waiting: this.waiting.size,
      joined: this.joined.size / 2,
      sockets: this.peers.size,
    }
  }

  close(): void {
    clearInterval(this.sweeper)
    clearInterval(this.checker)
    for (const socket of this.peers.keys()) socket.close(1001)
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  /** Answers a relay request over HTTP; false for a path that is not the relay's. */
  http(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
    const cors = this.cors(request)
    if (!['/v1', '/v1/regions', '/v1/ping', '/v1/hosts', '/v1/reports'].includes(pathname)) {
      return false
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(cors ? 204 : 403, {
        ...cors,
        ...(cors
          ? {
              'access-control-allow-methods': 'GET, POST',
              'access-control-allow-headers': 'authorization, content-type, if-none-match',
              'access-control-max-age': '600',
            }
          : {}),
      })
      response.end()
      return true
    }
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...cors,
        ...headers,
      })
      response.end(JSON.stringify(body))
    }
    const route = `${request.method} ${pathname}`
    switch (route) {
      case 'GET /v1':
        send(200, this.info())
        return true
      case 'GET /v1/ping':
        response.writeHead(204, { 'cache-control': 'no-store', ...cors })
        response.end()
        return true
      case 'GET /v1/regions': {
        if (!this.options.regions || !this.regionsTag) {
          send(404, { error: 'not_found' })
          return true
        }
        const headers = { etag: this.regionsTag, 'cache-control': 'no-cache' }
        if (request.headers['if-none-match'] === this.regionsTag) {
          response.writeHead(304, { ...cors, ...headers })
          response.end()
          return true
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-content-type-options': 'nosniff',
          ...cors,
          ...headers,
        })
        response.end(this.options.regions)
        return true
      }
      case 'GET /v1/hosts': {
        const token = bearer(request)
        const grant = token ? this.options.tokens.check(token) : null
        if (!grant) {
          this.refused(request)
          send(401, { error: 'unauthorized' })
          return true
        }
        const hosts: RelayListedHost[] = []
        for (const [id, host] of this.hosts) {
          if (host.grant.account === grant.account && host.profile)
            hosts.push({ id, ...host.profile })
        }
        send(200, { hosts: hosts.slice(0, MAX_LISTED_HOSTS) })
        return true
      }
      default:
        send(404, { error: 'not_found' })
        return true
    }
  }

  /** The CORS headers for a page of the hosted web client, none for any other. */
  private cors(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin
    if (!origin || !this.options.webOrigins.includes(origin)) return {}
    return {
      'access-control-allow-origin': origin,
      'access-control-expose-headers': 'etag',
      vary: 'Origin',
    }
  }

  private refused(request: IncomingMessage): void {
    this.refusals.hit(clientAddress(request, this.options.trustProxy))
  }

  // ---- Sockets --------------------------------------------------------------------------------

  /** Takes a WebSocket upgrade; false for a path that is not the relay's. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = URL.parse(request.url ?? '', 'http://relay')?.pathname ?? ''
    if (!pathname.startsWith('/v1/hosts/')) return false
    const origin = request.headers.origin
    if (
      origin !== undefined &&
      origin !== this.options.origin &&
      !this.options.webOrigins.includes(origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return true
    }
    const address = clientAddress(request, this.options.trustProxy)
    this.sockets.handleUpgrade(request, socket, head, (ws) => this.opened(ws, address, pathname))
    return true
  }

  private opened(ws: WebSocket, address: string, pathname: string): void {
    const peer: Peer = { address, alive: true, queued: 0 }
    this.peers.set(ws, peer)
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1)
    ws.on('pong', () => (peer.alive = true))
    // A protocol error, which ws closes the socket for; 'close' follows. A message over maxPayload
    // closes with 1009, which the other side of a pair hears too.
    ws.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') this.ended(ws, RELAY_CLOSE.tooBig)
    })
    ws.on('close', (code) => this.ended(ws, code))
    const crowded =
      this.peers.size > this.limits.maxSockets ||
      (this.perAddress.get(address) ?? 0) > this.limits.maxSocketsPerAddress ||
      !this.opens.hit(address) ||
      this.refusals.blocked(address)
    if (crowded) return this.refuse(ws, RELAY_CLOSE.tooMany)
    const match = PATH.exec(pathname)
    if (!match) return this.refuse(ws, RELAY_CLOSE.malformed)
    const [, id, connect, token] = match as unknown as [string, string, string?, string?]
    if (token) return this.accept(ws, id, token)
    if (connect) return this.device(ws, id, address)
    this.host(ws, id, address)
  }

  private host(ws: WebSocket, id: string, address: string): void {
    const nonce = newRelayToken()
    let signedIn = false
    let checking = false
    let idle = setTimeout(() => this.refuse(ws, RELAY_CLOSE.timeout), SIGN_IN_TIMEOUT_MS)
    const heard = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => ws.close(1001), this.limits.hostIdleMs)
    }
    ws.on('close', () => clearTimeout(idle))
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return this.refuse(ws, RELAY_CLOSE.malformed)
      const text = data.toString()
      if (text === PING) {
        if (signedIn) heard()
        return this.sendText(ws, PONG)
      }
      const message = parseHostToRelay(text)
      if (!message) return this.refuse(ws, RELAY_CLOSE.malformed)
      if (message.type === 'sign-in') {
        if (signedIn || checking) return this.refuse(ws, RELAY_CLOSE.malformed)
        checking = true
        return void this.signIn(ws, id, nonce, message, address).then((ok) => {
          checking = false
          if (!ok) return
          signedIn = true
          heard()
        })
      }
      const host = this.hosts.get(id)
      if (!signedIn || host?.socket !== ws) return this.refuse(ws, RELAY_CLOSE.malformed)
      heard()
      if (message.type === 'profile') {
        host.profile = message.profile
        return
      }
      const grant = this.options.tokens.check(message.token)
      if (!grant || grant.account !== host.grant.account) {
        this.refusals.hit(address)
        this.log(`huli-cloud: relay host ${short(id)} renewed with a token refused`)
        return this.refuse(ws, RELAY_CLOSE.unauthorized)
      }
      host.grant = grant
    })
    this.sendJson(ws, { type: 'challenge', nonce })
  }

  private async signIn(
    ws: WebSocket,
    id: string,
    nonce: string,
    message: { publicKey: string; signature: string; token: string },
    address: string,
  ): Promise<boolean> {
    const publicKey = decodeRelayBytes(message.publicKey)!
    const signature = decodeRelayBytes(message.signature)!
    const grant = this.options.tokens.check(message.token)
    const valid =
      grant !== null &&
      (await relayHostId(publicKey)) === id &&
      (await verifyRelaySignature(publicKey, signature, signInText(this.options.origin, id, nonce)))
    if (ws.readyState !== ws.OPEN) return false
    if (!valid || !grant) {
      this.refusals.hit(address)
      this.log(`huli-cloud: relay sign-in of ${short(id)} refused from ${address}`)
      this.refuse(ws, RELAY_CLOSE.unauthorized)
      return false
    }
    const before = this.hosts.get(id)
    if (!this.signIns.hit(id) || (!before && this.hosts.size >= this.limits.maxHosts)) {
      this.refuse(ws, RELAY_CLOSE.tooMany)
      return false
    }
    this.hosts.set(id, { socket: ws, grant, profile: null })
    if (before) {
      this.sendJson(before.socket, { type: 'replaced' })
      this.refuse(before.socket, RELAY_CLOSE.replaced)
      this.log(`huli-cloud: relay host ${short(id)} signed in again; the one before was replaced`)
    } else {
      this.log(`huli-cloud: relay host ${short(id)} signed in`)
    }
    this.sendJson(ws, { type: 'ready' })
    return true
  }

  private device(ws: WebSocket, id: string, address: string): void {
    let asked = false
    const timer = setTimeout(() => {
      if (!asked) this.refuse(ws, RELAY_CLOSE.timeout)
    }, CONNECT_TIMEOUT_MS)
    ws.on('close', () => clearTimeout(timer))
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.joined.has(ws)) return this.forward(ws, data, isBinary)
      if (!isBinary && data.toString() === PING) return this.sendText(ws, PONG)
      const message = isBinary || asked ? null : parseDeviceToRelay(data.toString())
      if (!message) return this.refuse(ws, RELAY_CLOSE.malformed)
      asked = true
      clearTimeout(timer)
      const grant = this.options.tokens.check(message.token)
      if (!grant) {
        this.refusals.hit(address)
        return this.refuse(ws, RELAY_CLOSE.forbidden)
      }
      const host = this.hosts.get(id)
      if (!host) return this.refuse(ws, RELAY_CLOSE.offline)
      if (host.grant.account !== grant.account) return this.refuse(ws, RELAY_CLOSE.forbidden)
      if (this.devices(id) >= MAX_DEVICE_CONNECTIONS) return this.refuse(ws, RELAY_CLOSE.tooMany)
      const token = newRelayToken()
      this.waiting.set(token, {
        device: ws,
        host: id,
        timer: setTimeout(() => {
          if (this.waiting.delete(token)) this.refuse(ws, RELAY_CLOSE.offline)
        }, ACCEPT_TIMEOUT_MS),
      })
      this.sendJson(host.socket, { type: 'incoming', token })
    })
  }

  private accept(ws: WebSocket, id: string, token: string): void {
    const waiting = this.waiting.get(token)
    this.waiting.delete(token)
    if (waiting) clearTimeout(waiting.timer)
    if (!waiting || waiting.host !== id || waiting.device.readyState !== waiting.device.OPEN) {
      return this.refuse(ws, RELAY_CLOSE.offline)
    }
    const { device } = waiting
    this.joined.set(device, ws)
    this.joined.set(ws, device)
    this.joinedHosts.set(ws, id)
    let idle: ReturnType<typeof setTimeout> | null = null
    const touch = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => ws.close(1001), this.limits.joinedIdleMs)
    }
    touch()
    const both = [ws, device]
    for (const side of both) {
      side.on('message', touch)
      side.on('close', () => {
        if (idle) clearTimeout(idle)
        idle = null
      })
    }
    ws.on('message', (data: RawData, isBinary: boolean) => this.forward(ws, data, isBinary))
    this.sendJson(device, { type: 'joined' })
  }

  /** Passes a joined socket's message on unchanged; text other than `ping` ends the pair. */
  private forward(from: WebSocket, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      if (data.toString() === PING) return this.sendText(from, PONG)
      return this.refuse(from, RELAY_CLOSE.malformed)
    }
    const to = this.joined.get(from)
    const target = to && this.peers.get(to)
    if (!to || !target || to.readyState !== to.OPEN) return
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data)
    target.queued += bytes.length
    if (target.queued > this.limits.highWater) from.pause()
    to.send(bytes, { binary: true }, () => {
      target.queued -= bytes.length
      if (target.queued <= this.limits.lowWater && from.readyState === from.OPEN) from.resume()
    })
  }

  /** Devices waiting for or joined to the host. */
  private devices(id: string): number {
    let count = 0
    for (const waiting of this.waiting.values()) if (waiting.host === id) count++
    for (const host of this.joinedHosts.values()) if (host === id) count++
    return count
  }

  /** Signed-out hosts and lapsed tokens: the control socket closes with 4401. */
  private checkHosts(): void {
    for (const [id, host] of this.hosts) {
      if (this.options.tokens.holds(host.grant, TOKEN_GRACE_MS)) continue
      this.log(`huli-cloud: relay host ${short(id)} is no longer signed in`)
      this.refuse(host.socket, RELAY_CLOSE.unauthorized)
    }
  }

  /** Pings every socket; one that did not answer the ping before is cut. */
  private ping(): void {
    for (const [socket, peer] of this.peers) {
      if (!peer.alive) {
        socket.terminate()
        continue
      }
      peer.alive = false
      try {
        socket.ping()
      } catch {
        // Closing already.
      }
    }
  }

  private refuse(ws: WebSocket, code: number): void {
    this.ended(ws, code)
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(sendable(code))
  }

  /** Either end closing closes the other; a host going leaves its waiting devices offline. */
  private ended(ws: WebSocket, code: number): void {
    const peer = this.peers.get(ws)
    if (peer) {
      this.peers.delete(ws)
      const left = (this.perAddress.get(peer.address) ?? 1) - 1
      if (left > 0) this.perAddress.set(peer.address, left)
      else this.perAddress.delete(peer.address)
    }
    const other = this.joined.get(ws)
    if (other) {
      this.joined.delete(ws)
      this.joined.delete(other)
      this.joinedHosts.delete(ws)
      this.joinedHosts.delete(other)
      if (other.readyState === other.OPEN) {
        other.close(code === RELAY_CLOSE.tooBig || code >= 4000 ? sendable(code) : 1000)
      }
    }
    for (const [token, waiting] of this.waiting) {
      if (waiting.device !== ws) continue
      clearTimeout(waiting.timer)
      this.waiting.delete(token)
    }
    for (const [id, host] of this.hosts) {
      if (host.socket !== ws) continue
      this.hosts.delete(id)
      this.log(`huli-cloud: relay host ${short(id)} left (${code})`)
      for (const [token, waiting] of this.waiting) {
        if (waiting.host !== id) continue
        clearTimeout(waiting.timer)
        this.waiting.delete(token)
        this.refuse(waiting.device, RELAY_CLOSE.offline)
      }
    }
  }

  private sendText(ws: WebSocket, text: string): void {
    if (ws.readyState === ws.OPEN) ws.send(text)
  }

  private sendJson(ws: WebSocket, message: object): void {
    this.sendText(ws, JSON.stringify(message))
  }
}

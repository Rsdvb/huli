// Huli: dev server previews for paired phones (@shared/dev-preview). Each preview is a listener of
// its own, on the address the phone's direct connection came in on, that proxies to one port of
// this computer's loopback: the one the phone asked for, which the computer listed then. A
// request passes only with the preview's cookie, which the phone's web view gets by spending a
// one-time ticket at the entry path, and only from the preview's own pages. Bodies stream both
// ways; a WebSocket upgrade, as a dev server's HMR, becomes a byte tunnel. A listener per preview
// gives each dev server an origin of its own, apart from the direct port's web client, so its
// absolute paths and its HMR socket work as on localhost. A preview goes when nothing used it for
// PREVIEW_IDLE_MS, after PREVIEW_MAX_MS, when its device is removed, or when direct connections
// stop. Nothing listens until a phone opens one.

import { addLogSecret } from '@shared/log/process-log'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import net, { type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { pipeline, Transform } from 'node:stream'
import { PREVIEW_ENTRY, PREVIEW_IDLE_MS, PREVIEW_MAX_MS, PREVIEW_SECRET } from '@shared/dev-preview'
import type { LogFn } from '../agent-host/storage'

/** How long a ticket the phone was handed may wait to be spent. */
const TICKET_MS = 2 * 60 * 1000
/** Tickets a preview keeps unspent; a newer one pushes out the oldest. */
const MAX_TICKETS = 4
/** Previews one device, and every device together, keeps open. */
export const MAX_DEVICE_PREVIEWS = 8
export const MAX_PREVIEWS = 32
/** Connections one preview's listener takes at once: a page's few, its HMR socket and its tabs. */
const MAX_CONNECTIONS = 48
/** A request body may be this large: a form's or an upload's to the dev server. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024
/** One response may be this large, which no dev server's page or bundle comes near. */
export const MAX_RESPONSE_BYTES = 1024 * 1024 * 1024
/** How long a request's headers may take, and its body. */
const HEADERS_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
/** A connection with nothing on it for this long is cut, either side. */
const IDLE_SOCKET_MS = 10 * 60 * 1000

/** The cookie that carries a preview's token, named after its port: `kite_preview_<port>`. */
export const COOKIE_PREFIX = 'kite_preview_'

/** A Host header as a browser sends it: a name or an address, and a port. */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/

/** Headers of one hop that never pass a proxy, beside those a Connection header names. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Request headers dropped on the way in: Node.js answered the expectation, and no one forwarded. */
const DROPPED_IN = new Set(['expect', 'forwarded', 'x-real-ip'])

export interface PreviewTarget {
  host: '127.0.0.1' | '::1'
  port: number
}

export class PreviewError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(code === 'busy' ? 'The device has as many previews as it may' : 'Cannot listen')
  }
}

export interface DevPreviewsOptions {
  log: LogFn
  now?: () => number
  idleMs?: number
  maxMs?: number
  /** Limits a test lowers. */
  maxRequestBytes?: number
  maxResponseBytes?: number
}

interface Preview {
  key: string
  deviceId: string
  target: PreviewTarget
  bind: string
  /** The listener's port, 0 until it listens. */
  port: number
  token: string
  tickets: Map<string, number>
  created: number
  used: number
  server: Server
  agent: Agent
  sockets: Set<Socket>
  ready: Promise<void>
  timer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

const keyOf = (deviceId: string, port: number): string => `${deviceId}\n${port}`

const secret = (): string => {
  const value = randomBytes(32).toString('base64url')
  addLogSecret(value)
  return value
}

/** Every device's previews. */
export class DevPreviews {
  private readonly previews = new Map<string, Preview>()
  private readonly now: () => number
  private readonly idleMs: number
  private readonly maxMs: number

  constructor(private readonly options: DevPreviewsOptions) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? PREVIEW_IDLE_MS
    this.maxMs = options.maxMs ?? PREVIEW_MAX_MS
  }

  /** How many previews are open, for tests and the status. */
  get size(): number {
    return this.previews.size
  }

  /**
   * The device's preview of `target`, listening on `bind`, made now or the one it has, with a new
   * ticket for its web view; the token stays, so a page the web view keeps goes on working.
   */
  async open(
    deviceId: string,
    target: PreviewTarget,
    bind: string,
  ): Promise<{ port: number; path: string }> {
    const key = keyOf(deviceId, target.port)
    let preview = this.previews.get(key)
    if (preview && (preview.bind !== bind || preview.target.host !== target.host)) {
      this.shut(preview)
      preview = undefined
    }
    if (preview && this.expired(preview)) {
      this.shut(preview)
      preview = undefined
    }
    if (!preview) {
      let own = 0
      for (const item of this.previews.values()) if (item.deviceId === deviceId) own++
      if (own >= MAX_DEVICE_PREVIEWS || this.previews.size >= MAX_PREVIEWS) {
        throw new PreviewError('busy')
      }
      preview = this.start(key, deviceId, target, bind)
    }
    await preview.ready
    if (preview.closed) throw new PreviewError('unavailable')
    preview.used = this.now()
    return { port: preview.port, path: `${PREVIEW_ENTRY}${this.ticket(preview)}` }
  }

  /** The device closed its preview of the port. */
  close(deviceId: string, port: number): void {
    const preview = this.previews.get(keyOf(deviceId, port))
    if (preview) this.shut(preview)
  }

  /** The device was removed: every preview it opened goes, with its connections. */
  revokeDevice(deviceId: string): void {
    for (const preview of [...this.previews.values()]) {
      if (preview.deviceId === deviceId) this.shut(preview)
    }
  }

  /** Direct connections stopped, or the remote host did. */
  closeAll(): void {
    for (const preview of [...this.previews.values()]) this.shut(preview)
  }

  private start(key: string, deviceId: string, target: PreviewTarget, bind: string): Preview {
    const server = createServer()
    server.maxConnections = MAX_CONNECTIONS
    server.headersTimeout = HEADERS_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS
    // Without a 'timeout' listener Node.js destroys the socket.
    server.setTimeout(IDLE_SOCKET_MS)
    const now = this.now()
    const preview: Preview = {
      key,
      deviceId,
      target,
      bind,
      port: 0,
      token: secret(),
      tickets: new Map(),
      created: now,
      used: now,
      server,
      agent: new Agent({ keepAlive: true, maxSockets: MAX_CONNECTIONS, timeout: IDLE_SOCKET_MS }),
      sockets: new Set(),
      ready: Promise.resolve(),
      timer: null,
      closed: false,
    }
    server.on('connection', (socket: Socket) => this.track(preview, socket))
    server.on('request', (request: IncomingMessage, response: ServerResponse) =>
      this.request(preview, request, response),
    )
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.upgrade(preview, request, socket as Socket, head),
    )
    // A forward proxy's tunnel is what this must never be.
    server.on('connect', (_request: IncomingMessage, socket: Duplex) => socket.destroy())
    server.on('clientError', (_error: Error, socket: Duplex) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
    preview.ready = new Promise<void>((resolve) => {
      server.on('error', (error: NodeJS.ErrnoException) => {
        this.options.log('warn', `A preview on ${bind} failed: ${error.code ?? error.name}`)
        this.shut(preview)
        resolve()
      })
      server.listen({ host: bind, port: 0, exclusive: true }, () => {
        const address = server.address()
        preview.port = typeof address === 'object' && address ? address.port : 0
        this.schedule(preview)
        resolve()
      })
    })
    this.previews.set(key, preview)
    return preview
  }

  private track(preview: Preview, socket: Socket): void {
    if (preview.closed) return void socket.destroy()
    preview.sockets.add(socket)
    socket.once('close', () => preview.sockets.delete(socket))
  }

  private ticket(preview: Preview): string {
    const now = this.now()
    for (const [ticket, until] of [...preview.tickets]) {
      if (until <= now) preview.tickets.delete(ticket)
    }
    while (preview.tickets.size >= MAX_TICKETS) {
      preview.tickets.delete(preview.tickets.keys().next().value!)
    }
    const ticket = secret()
    preview.tickets.set(ticket, now + TICKET_MS)
    return ticket
  }

  /** Spends a ticket once, before its time is up. */
  private spend(preview: Preview, ticket: string): boolean {
    if (!PREVIEW_SECRET.test(ticket)) return false
    const until = preview.tickets.get(ticket)
    preview.tickets.delete(ticket)
    return until !== undefined && until > this.now()
  }

  private expired(preview: Preview): boolean {
    const now = this.now()
    return now - preview.used >= this.idleMs || now - preview.created >= this.maxMs
  }

  /** One timer a preview, at its next deadline; use in between only moves the next one. */
  private schedule(preview: Preview): void {
    if (preview.closed) return
    const deadline = Math.min(preview.used + this.idleMs, preview.created + this.maxMs)
    preview.timer = setTimeout(
      () => {
        preview.timer = null
        if (this.expired(preview)) this.shut(preview)
        else this.schedule(preview)
      },
      Math.max(0, deadline - this.now()),
    )
    preview.timer.unref?.()
  }

  private shut(preview: Preview): void {
    if (preview.closed) return
    preview.closed = true
    if (this.previews.get(preview.key) === preview) this.previews.delete(preview.key)
    if (preview.timer) clearTimeout(preview.timer)
    preview.timer = null
    preview.tickets.clear()
    preview.server.close()
    for (const socket of preview.sockets) socket.destroy()
    preview.sockets.clear()
    preview.agent.destroy()
  }

  /** Why a request may not pass, or null when it may; `ended` when the preview is over. */
  private refusal(preview: Preview, request: IncomingMessage): Refusal | 'ended' | null {
    if (preview.closed || this.expired(preview)) return 'ended'
    return requestRefusal(request, cookieName(preview.port), preview.token)
  }

  private request(preview: Preview, request: IncomingMessage, response: ServerResponse): void {
    const url = request.url ?? ''
    // Origin-form alone: an absolute URL, `*` or an authority would make this a forward proxy.
    if (!url.startsWith('/')) return page(response, 400, 'bad', request)
    if (url.startsWith(PREVIEW_ENTRY)) return this.enter(preview, request, response)
    const refused = this.refusal(preview, request)
    if (refused === 'ended') {
      // Answered first, then the preview goes with this connection too.
      response.once('close', () => this.shut(preview))
      return page(response, 403, 'expired', request)
    }
    if (refused) return page(response, 403, refused, request)
    const declared = Number(request.headers['content-length'] ?? 0)
    const maxIn = this.options.maxRequestBytes ?? MAX_REQUEST_BYTES
    if (Number.isFinite(declared) && declared > maxIn) {
      return page(response, 413, 'large', request)
    }
    preview.used = this.now()
    const own = `http://${request.headers.host!}`
    const { host, port } = preview.target
    let upstream: ReturnType<typeof httpRequest>
    try {
      upstream = httpRequest({
        host,
        port,
        method: request.method,
        path: url,
        headers: upstreamHeaders(request.rawHeaders, { own, target: port, upgrade: false }),
        setHost: false,
        agent: preview.agent,
        timeout: IDLE_SOCKET_MS,
      })
    } catch {
      return page(response, 400, 'bad', request)
    }
    let failed = false
    // The request's stream and the dev server's connection both fail here, once.
    const fail = (error: NodeJS.ErrnoException | null | undefined): void => {
      if (!error || failed) return
      failed = true
      upstream.destroy()
      if (response.writableEnded) return
      if (response.headersSent) return void response.destroy()
      if (error instanceof RangeError) return page(response, 413, 'large', request)
      page(response, 502, error.code === 'ECONNREFUSED' ? 'down' : 'failed', request, port)
    }
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')))
    upstream.on('error', fail)
    upstream.on('response', (answer: IncomingMessage) => {
      if (response.headersSent || response.destroyed) return void answer.destroy()
      response.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.rawHeaders, port))
      const maxOut = this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES
      pipeline(answer, capped(maxOut), response, () => {})
    })
    pipeline(request, capped(maxIn), upstream, fail)
  }

  /** The entry: a ticket spent once for the preview's cookie, then the page it names. */
  private enter(preview: Preview, request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return page(response, 405, 'bad', request)
    }
    const url = URL.parse(request.url ?? '', 'http://preview')
    const ticket = url ? url.pathname.slice(PREVIEW_ENTRY.length) : ''
    if (preview.closed || this.expired(preview) || !this.spend(preview, ticket)) {
      return page(response, 403, 'expired', request)
    }
    preview.used = this.now()
    response.writeHead(303, {
      Location: entryTarget(url?.searchParams.get('to') ?? null),
      'Set-Cookie': `${cookieName(preview.port)}=${preview.token}; Path=/; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': 0,
    })
    response.end()
  }

  /** A WebSocket's upgrade, which becomes a tunnel to the dev server once it is allowed. */
  private upgrade(preview: Preview, request: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => {})
    const url = request.url ?? ''
    const deny = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (
      request.method !== 'GET' ||
      !url.startsWith('/') ||
      url.startsWith(PREVIEW_ENTRY) ||
      request.headers.upgrade?.toLowerCase() !== 'websocket'
    ) {
      return deny('400 Bad Request')
    }
    const refused = this.refusal(preview, request)
    if (refused) {
      if (refused === 'ended') socket.once('close', () => this.shut(preview))
      return deny('403 Forbidden')
    }
    preview.used = this.now()
    socket.setTimeout(0)
    const own = `http://${request.headers.host!}`
    const { host, port } = preview.target
    const lines = [`GET ${url} HTTP/1.1`]
    const headers = upstreamHeaders(request.rawHeaders, { own, target: port, upgrade: true })
    for (let at = 0; at < headers.length; at += 2) lines.push(`${headers[at]}: ${headers[at + 1]}`)
    const upstream = net.connect({ host, port })
    this.track(preview, upstream)
    let connected = false
    upstream.on('error', () => {
      if (!connected) deny('502 Bad Gateway')
      else socket.destroy()
    })
    upstream.once('connect', () => {
      connected = true
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      const used = (): void => void (preview.used = this.now())
      socket.on('data', used)
      upstream.on('data', used)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  }
}

/**
 * The address a preview listens on for a connection that came in on `local`: an IPv4 one as
 * itself rather than mapped into IPv6, so the device's address for the computer reaches it.
 */
export function previewBind(local: string | undefined): string | null {
  if (!local) return null
  return local.toLowerCase().startsWith('::ffff:') && local.includes('.') ? local.slice(7) : local
}

export type Refusal = 'expired' | 'foreign'

export const cookieName = (port: number): string => `${COOKIE_PREFIX}${port}`

/**
 * Why a request to a preview may not pass, or null: it needs a Host as a browser sends one, the
 * preview's cookie, and to come from the preview's own pages, as its Origin and the browser's
 * fetch metadata tell. Another preview's page reaches this one's port on the same site, so its
 * cookies come along; only the origin keeps it out.
 */
export function requestRefusal(
  request: Pick<IncomingMessage, 'headers'>,
  cookie: string,
  token: string,
): Refusal | null {
  const { host, origin } = request.headers
  if (!host || !HOST.test(host)) return 'foreign'
  if (!sameSecret(cookieValue(request.headers.cookie, cookie), token)) return 'expired'
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'foreign'
  if (origin !== undefined && URL.parse(origin)?.origin !== URL.parse(`http://${host}`)?.origin) {
    return 'foreign'
  }
  return null
}

function sameSecret(value: string | null, token: string): boolean {
  if (value === null) return false
  const given = Buffer.from(value)
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** The value of the cookie `name` in a Cookie header, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

/** Where the entry sends the web view: a path of the preview's own, `/` by default. */
export function entryTarget(to: string | null): string {
  if (
    !to ||
    to.length > 2048 ||
    !to.startsWith('/') ||
    to.startsWith('//') ||
    to.startsWith('/\\') ||
    to.startsWith(PREVIEW_ENTRY) ||
    [...to].some((char) => char < ' ' || char === '\u007f' || char === '\\')
  ) {
    return '/'
  }
  return to
}

/** The names a Connection header lists, which go no further than this hop. */
function connectionNames(raw: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (let at = 0; at < raw.length; at += 2) {
    if (raw[at]!.toLowerCase() !== 'connection') continue
    for (const name of raw[at + 1]!.split(',')) names.add(name.trim().toLowerCase())
  }
  return names
}

/**
 * The headers a request goes to the dev server with, as Node.js's raw list: as though it came
 * from a page of `http://localhost:<target>`, which Vite's and Next.js's host and origin checks
 * accept. The preview's cookies stay here, and so does every hop's own.
 */
export function upstreamHeaders(
  raw: readonly string[],
  { own, target, upgrade }: { own: string; target: number; upgrade: boolean },
): string[] {
  const local = `http://localhost:${target}`
  const listed = connectionNames(raw)
  const out: string[] = ['Host', `localhost:${target}`]
  let protocol: string | null = null
  for (let at = 0; at < raw.length; at += 2) {
    const name = raw[at]!
    const value = raw[at + 1]!
    const lower = name.toLowerCase()
    if (lower === 'upgrade') protocol = value
    if (
      lower === 'host' ||
      HOP_BY_HOP.has(lower) ||
      listed.has(lower) ||
      DROPPED_IN.has(lower) ||
      lower.startsWith('x-forwarded-')
    ) {
      continue
    }
    if (lower === 'origin') {
      if (URL.parse(value)?.origin === URL.parse(own)?.origin) out.push(name, local)
      continue
    }
    if (lower === 'referer') {
      const page = URL.parse(value)
      if (page && page.origin === URL.parse(own)?.origin) {
        out.push(name, `${local}${page.pathname}${page.search}`)
      }
      continue
    }
    if (lower === 'cookie') {
      const kept = value
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '' && !part.startsWith(COOKIE_PREFIX))
      if (kept.length > 0) out.push(name, kept.join('; '))
      continue
    }
    out.push(name, value)
  }
  if (upgrade) out.push('Connection', 'Upgrade', 'Upgrade', protocol ?? 'websocket')
  return out
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/** A redirect to the dev server's own address, as the path alone, so it stays in the preview. */
export function previewLocation(location: string, target: number): string {
  const url = URL.parse(location)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return location
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!LOOPBACK_NAMES.has(url.hostname.toLowerCase()) || port !== target) return location
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * A dev server's Set-Cookie as the preview's origin keeps it: without the Domain localhost would
 * have and the Secure an http address cannot hold; null for one that names a preview's cookie.
 */
export function previewCookie(value: string): string | null {
  const [pair = '', ...attributes] = value.split(';')
  const name = pair.split('=')[0]!.trim()
  if (name.startsWith(COOKIE_PREFIX)) return null
  const kept = attributes
    .map((part) => part.trim())
    .filter((part) => {
      const key = part.split('=')[0]!.trim().toLowerCase()
      return part !== '' && key !== 'domain' && key !== 'secure'
    })
    .map((part) => (/^samesite\s*=\s*none$/i.test(part) ? 'SameSite=Lax' : part))
  return [pair.trim(), ...kept].join('; ')
}

/** The headers a dev server's response comes back to the phone with, as Node.js's raw list. */
export function downstreamHeaders(raw: readonly string[], target: number): string[] {
  const listed = connectionNames(raw)
  const out: string[] = []
  for (let at = 0; at < raw.length; at += 2) {
    const name = raw[at]!
    const value = raw[at + 1]!
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || listed.has(lower)) continue
    if (lower === 'location') out.push(name, previewLocation(value, target))
    else if (lower === 'set-cookie') {
      const cookie = previewCookie(value)
      if (cookie !== null) out.push(name, cookie)
    } else out.push(name, value)
  }
  return out
}

/** A stream that passes at most `max` bytes, failing past them. */
function capped(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      if (seen > max) done(new RangeError('Too large'))
      else done(null, chunk)
    },
  })
}

type PageKind = Refusal | 'bad' | 'large' | 'down' | 'failed'

const PAGES: Record<PageKind, { zh: string; en: string }> = {
  expired: {
    zh: '这个预览已失效。请回到纸鸢重新打开。',
    en: 'This preview has expired. Open it again from Kite.',
  },
  foreign: {
    zh: '这个预览只接受它自己页面的请求。',
    en: 'This preview takes requests from its own pages only.',
  },
  bad: { zh: '请求无效。', en: 'The request is not valid.' },
  large: { zh: '请求太大。', en: 'The request is too large.' },
  down: {
    zh: '电脑上的端口 {port} 没有程序在监听，开发服务器可能已经停了。',
    en: 'Nothing listens on port {port} of the computer; the dev server may have stopped.',
  },
  failed: {
    zh: '没能连上电脑上的端口 {port}。',
    en: 'Could not reach port {port} of the computer.',
  },
}

/** A short page of the preview's own, in the web view's language. */
function page(
  response: ServerResponse,
  status: number,
  kind: PageKind,
  request: IncomingMessage,
  port = 0,
): void {
  if (response.headersSent) return void response.destroy()
  const chinese = /^\s*zh/i.test(request.headers['accept-language'] ?? '')
  const text = PAGES[kind][chinese ? 'zh' : 'en'].replace('{port}', String(port))
  const body = `${text}\n`
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // An unread request body would otherwise hold the connection for the next request.
    Connection: 'close',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

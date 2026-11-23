// Huli: routines' webhooks. A routine whose trigger is its webhook runs on a POST to
// http://127.0.0.1:<port>/routines/<id> that carries its secret in X-Kite-Secret, or an
// HMAC-SHA256 of the body made with it in X-Kite-Signature-256 (or GitHub's X-Hub-Signature-256).
// The listener binds the loopback address alone, and only while a routine uses its webhook; the
// body goes to the run as untrusted data. A request with an Origin header, as a web page's, or a
// Host other than the loopback's, as a rebound name's, is refused before anything else. Each
// routine takes a few requests a minute and an hour, and failed secrets slow every request down.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { LogFn } from '../storage'
import { WindowLimiter, type WindowLimit } from '../window-limiter'

/** The largest body a request may carry. */
export const WEBHOOK_BODY_BYTES = 64 * 1024
/** How many requests one routine takes, its secret checked. */
export const WEBHOOK_LIMITS: readonly WindowLimit[] = [
  { windowMs: 60_000, max: 6 },
  { windowMs: 60 * 60_000, max: 60 },
]
/** How many requests with a wrong or missing secret, across routines, before all wait. */
export const FAILED_LIMITS: readonly WindowLimit[] = [{ windowMs: 60_000, max: 20 }]

const SECRET = /^[A-Za-z0-9_-]{43}$/
const PATH = /^\/routines\/(r-[0-9a-f]{12})\/?$/
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/i

/** A new secret: 32 random bytes in base64url. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function isWebhookSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET.test(value)
}

function header(headers: http.IncomingHttpHeaders, name: string): string | null {
  const value = headers[name]
  if (Array.isArray(value)) return value.length === 1 ? value[0]! : null
  return typeof value === 'string' ? value : null
}

/** Whether two texts are the same, in a time that tells nothing of where they differ. */
function sameText(a: string, b: string): boolean {
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest()
  return timingSafeEqual(hash(a), hash(b))
}

/** Whether the request carries the secret, or a signature of its body made with it. */
export function authorized(
  secret: string,
  headers: http.IncomingHttpHeaders,
  body: Uint8Array,
): boolean {
  const given = header(headers, 'x-kite-secret')
  if (given !== null) return sameText(given.trim(), secret)
  const signature =
    header(headers, 'x-kite-signature-256') ?? header(headers, 'x-hub-signature-256')
  const hex = signature === null ? null : SIGNATURE.exec(signature.trim())?.[1]
  if (!hex) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(Buffer.from(hex.toLowerCase(), 'hex'), expected)
}

/** A request's body as the run is given it: its text when it is UTF-8, and its type. */
export interface WebhookBody {
  /** Null for a body that is not UTF-8 text. */
  text: string | null
  bytes: number
  /** The media type it says it has, when that reads as one; null otherwise. */
  contentType: string | null
}

export function webhookBody(body: Uint8Array, contentType: string | null): WebhookBody {
  let text: string | null
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    text = null
  }
  const type = contentType?.split(';')[0]?.trim() ?? ''
  return { text, bytes: body.byteLength, contentType: CONTENT_TYPE.test(type) ? type : null }
}

/**
 * The run's prompt: the routine's own, then the body between markers whose boundary no sender can
 * guess, after a line that says it is untrusted data.
 */
export function webhookPrompt(
  prompt: string,
  body: WebhookBody,
  words: { header: string; binary: string; empty: string },
): string {
  const boundary = randomBytes(8).toString('hex')
  const type = body.contentType ? ` content-type="${body.contentType}"` : ''
  const content =
    body.text === null ? words.binary : body.text.trim() === '' ? words.empty : body.text
  return (
    `${prompt}\n\n---\n${words.header}\n` +
    `<untrusted-webhook-body boundary="${boundary}"${type}>\n${content}\n` +
    `</untrusted-webhook-body boundary="${boundary}">`
  )
}

export type WebhookRun =
  { status: 'started'; runId: string } | { status: 'busy' } | { status: 'skipped' }

export interface WebhookRequest {
  method: string
  /** The request's path, with any query. */
  url: string
  headers: http.IncomingHttpHeaders
  body: Uint8Array
}

export interface WebhookAnswer {
  status: number
  body: Record<string, string>
  retryAfterS?: number
}

export interface WebhookGateDeps {
  /** The secret of an enabled routine that runs on its webhook; undefined for any other. */
  secret(routineId: string): string | undefined
  /** Starts a run of the routine with the body. */
  run(routineId: string, body: WebhookBody): WebhookRun
  log: LogFn
  now?: () => number
}

/** Whether the Host header names the loopback address and the port the listener holds. */
function loopbackHost(value: string | null, port: number): boolean {
  if (value === null) return false
  const host = value.trim().toLowerCase()
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)
}

/** What answers each request, apart from the HTTP server so its rules can be checked alone. */
export class WebhookGate {
  private readonly perRoutine: WindowLimiter
  private readonly failed: WindowLimiter

  constructor(private readonly deps: WebhookGateDeps) {
    this.perRoutine = new WindowLimiter(WEBHOOK_LIMITS, deps.now)
    this.failed = new WindowLimiter(FAILED_LIMITS, deps.now)
  }

  handle(request: WebhookRequest, port: number): WebhookAnswer {
    if (!loopbackHost(header(request.headers, 'host'), port)) {
      return { status: 403, body: { error: 'forbidden' } }
    }
    // A web page's request; a webhook's sender is no browser.
    if (request.headers.origin !== undefined) return { status: 403, body: { error: 'forbidden' } }
    const path = request.url.split('?')[0] ?? ''
    const routineId = PATH.exec(path)?.[1]
    if (!routineId) return { status: 404, body: { error: 'not_found' } }
    if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    const cooling = this.failed.wait('all')
    if (cooling > 0) return limited(cooling)
    const secret = this.deps.secret(routineId)
    if (secret === undefined || !authorized(secret, request.headers, request.body)) {
      this.failed.take('all')
      this.deps.log('warn', `A webhook request for ${routineId} was refused: no valid secret`)
      return { status: 401, body: { error: 'unauthorized' } }
    }
    const taken = this.perRoutine.take(routineId)
    if (!taken.ok) return limited(taken.retryMs)
    const body = webhookBody(request.body, header(request.headers, 'content-type'))
    const run = this.deps.run(routineId, body)
    this.deps.log('info', `A webhook request for ${routineId} (${body.bytes} bytes): ${run.status}`)
    switch (run.status) {
      case 'started':
        return { status: 202, body: { status: 'started', run: run.runId } }
      case 'busy':
        return { status: 409, body: { status: 'busy' } }
      case 'skipped':
        return { status: 202, body: { status: 'skipped' } }
    }
  }
}

function limited(retryMs: number): WebhookAnswer {
  return {
    status: 429,
    body: { error: 'rate_limited' },
    retryAfterS: Math.max(1, Math.ceil(retryMs / 1000)),
  }
}

export interface WebhookListenerDeps extends WebhookGateDeps {
  /** It began or stopped listening, or could not. */
  changed(): void
}

/**
 * The HTTP server, on 127.0.0.1 alone, while a port is set. It holds nothing between requests:
 * no timer runs while it waits for one.
 */
export class WebhookListener {
  private readonly gate: WebhookGate
  private server: http.Server | null = null
  private wanted: number | null = null
  private listening: number | null = null
  private failure: string | null = null

  constructor(private readonly deps: WebhookListenerDeps) {
    this.gate = new WebhookGate(deps)
  }

  /** The port it listens on now, or null. */
  get port(): number | null {
    return this.listening
  }

  /** Why it could not listen on the port it was given; null while it does or is off. */
  get error(): string | null {
    return this.failure
  }

  /** Listens on the port, or stops with null; the same port again only retries one that failed. */
  sync(port: number | null): void {
    if (port === this.wanted && this.failure === null) return
    this.wanted = port
    this.close()
    if (port === null) {
      this.failure = null
      this.deps.changed()
      return
    }
    const server = http.createServer((req, res) => this.serve(req, res, port))
    server.requestTimeout = 10_000
    server.headersTimeout = 5_000
    server.keepAliveTimeout = 1_000
    server.maxHeadersCount = 64
    server.maxRequestsPerSocket = 10
    this.server = server
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (this.server !== server) return
      this.server = null
      this.listening = null
      this.failure = error.code ?? error.message
      this.deps.log('warn', `Routines' webhooks could not listen on ${port}: ${this.failure}`)
      this.deps.changed()
    })
    server.listen(port, '127.0.0.1', () => {
      if (this.server !== server) return
      this.listening = port
      this.failure = null
      this.deps.log('info', `Routines' webhooks listen on 127.0.0.1:${port}`)
      this.deps.changed()
    })
  }

  close(): void {
    const server = this.server
    this.server = null
    if (this.listening !== null) {
      this.listening = null
      this.deps.changed()
    }
    if (server) {
      server.close()
      server.closeAllConnections()
    }
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse, port: number): void {
    const answer = (reply: WebhookAnswer): void => {
      if (res.headersSent) return
      res.writeHead(reply.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(reply.status === 405 ? { Allow: 'POST' } : {}),
        ...(reply.retryAfterS ? { 'Retry-After': String(reply.retryAfterS) } : {}),
        Connection: 'close',
      })
      res.end(JSON.stringify(reply.body))
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > WEBHOOK_BODY_BYTES) {
      answer({ status: 413, body: { error: 'too_large' } })
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.byteLength
      if (size > WEBHOOK_BODY_BYTES) {
        done = true
        answer({ status: 413, body: { error: 'too_large' } })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        answer(
          this.gate.handle(
            {
              method: req.method ?? '',
              url: req.url ?? '',
              headers: req.headers,
              body: Buffer.concat(chunks),
            },
            port,
          ),
        )
      } catch (error) {
        this.deps.log('error', `A webhook request failed: ${(error as Error).message}`)
        answer({ status: 500, body: { error: 'internal' } })
      }
    })
    req.on('error', () => {
      done = true
    })
  }
}

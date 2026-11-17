// Small HTTP helpers: bodies with a size cap, answers with the security headers every page and
// API reply carries, cookies, and the client's address behind nginx.

import type { IncomingMessage, ServerResponse } from 'node:http'

export class TooBig extends Error {}

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0')
  if (declared > limit) throw new TooBig()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new TooBig()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function readForm(request: IncomingMessage, limit = 16 * 1024) {
  return new URLSearchParams((await readBody(request, limit)).toString('utf8'))
}

function common(secure: boolean): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  }
}

export function sendJson(
  response: ServerResponse,
  secure: boolean,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { ...common(secure), 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** A JSON error as the Kettu client reads it: `{ error, error_description }`. */
export function sendError(
  response: ServerResponse,
  secure: boolean,
  status: number,
  error: string,
  description?: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(response, secure, status, {
    error,
    ...(description ? { error_description: description } : {}),
    ...extra,
  })
}

/**
 * No script anywhere; forms post to this origin, and the sign-in form's answer redirects to the
 * desktop app's loopback server, or to `targets`, which form-action must allow as well.
 */
export function pageCsp(targets: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    `form-action 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*${targets.map((t) => ` ${t}`).join('')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
}

const PAGE_CSP = pageCsp()

export function sendHtml(
  response: ServerResponse,
  secure: boolean,
  status: number,
  html: string,
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(status, {
    ...common(secure),
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': PAGE_CSP,
    'x-frame-options': 'DENY',
    ...headers,
  })
  response.end(html)
}

export function redirect(
  response: ServerResponse,
  secure: boolean,
  location: string,
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(302, { ...common(secure), location, ...headers })
  response.end()
}

export function cookies(request: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()))
  }
  return out
}

export function sessionCookie(
  name: string,
  value: string,
  maxAgeS: number,
  secure: boolean,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The client's address: nginx's X-Real-IP when trusted and the connection is from loopback. */
export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  const remote = request.socket.remoteAddress ?? 'unknown'
  if (trustProxy && LOOPBACK.has(remote)) {
    const real = request.headers['x-real-ip']
    if (typeof real === 'string' && real.length <= 64) return real
  }
  return remote
}

export function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/.exec(header)
  return match ? match[1]! : null
}

/** Counts events per key in a sliding window. */
export class Limiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one event; false when the key is over its limit. */
  hit(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.sweep(now)
    return recent.length <= this.max
  }

  /** Whether the key is over its limit, without counting. */
  blocked(key: string): boolean {
    const now = this.now()
    return (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs).length >= this.max
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= now - this.windowMs)) this.hits.delete(key)
    }
  }
}

// Huli: where an agent's traffic leaves for the internet. One request to Cloudflare's trace page,
// sent the agent's way: through an HTTP proxy with CONNECT (the agent's own listener, or the
// system's proxy) or directly, so its answer proves the path itself. Huli's own; see
// tools/huli/README.md.

import http from 'node:http'
import https from 'node:https'
import { isIP, type Socket } from 'node:net'
import tls from 'node:tls'

export const TRACE_HOST = 'www.cloudflare.com'
const TRACE_PATH = '/cdn-cgi/trace'
/** The trace page is a few hundred bytes; anything far longer is not it. */
const MAX_BODY = 16 * 1024
export const EXIT_TIMEOUT_MS = 8_000

export interface Trace {
  ip: string
  /** Null for Cloudflare's unknown (XX) and Tor (T1), or no `loc` line. */
  country: string | null
}

/** The `ip=` and `loc=` lines of a trace page; null unless `ip` is an address. */
export function parseTrace(text: string): Trace | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (!fields.has(key)) fields.set(key, line.slice(at + 1).trim())
  }
  const ip = fields.get('ip')
  if (!ip || isIP(ip) === 0) return null
  const loc = fields.get('loc')?.toUpperCase() ?? ''
  return { ip, country: /^[A-Z]{2}$/.test(loc) && loc !== 'XX' ? loc : null }
}

/** An HTTP proxy the check goes through, with its Basic credentials if the address has any. */
export interface ProxyHop {
  host: string
  port: number
  auth: string | null
}

/**
 * The hop a proxy variable names: null for none, `unsupported` for one the check cannot speak,
 * such as SOCKS or a proxy reached over TLS.
 */
export function proxyHop(value: string | null | undefined): ProxyHop | null | 'unsupported' {
  const text = value?.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`)
  } catch {
    return 'unsupported'
  }
  if (url.protocol !== 'http:' || !url.hostname) return 'unsupported'
  const user = decodeURIComponent(url.username)
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : 80,
    auth: user ? `${user}:${decodeURIComponent(url.password)}` : null,
  }
}

/** Whether a NO_PROXY list sends the trace host around the proxy. */
export function bypassesProxy(noProxy: string | null | undefined, host = TRACE_HOST): boolean {
  if (!noProxy) return false
  return noProxy
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ''))
    .some((entry) => {
      if (entry === '*') return true
      const domain = entry.replace(/^\*?\./, '')
      return domain !== '' && (host === domain || host.endsWith(`.${domain}`))
    })
}

function tunnel(hop: ProxyHop, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const target = `${TRACE_HOST}:443`
    const request = http.request({
      host: hop.host,
      port: hop.port,
      method: 'CONNECT',
      path: target,
      agent: false,
      signal,
      headers: {
        Host: target,
        ...(hop.auth
          ? { 'Proxy-Authorization': `Basic ${Buffer.from(hop.auth).toString('base64')}` }
          : {}),
      },
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        // mihomo answers a rejected or unreachable node with an error status, not a tunnel.
        reject(new Error(`The proxy answered ${response.statusCode ?? 'nothing'}`))
        return
      }
      resolve(socket)
    })
    request.once('error', reject)
    request.end()
  })
}

/** The trace page's text, fetched through `hop`, or directly with null. */
export async function fetchTrace(
  hop: ProxyHop | null,
  timeoutMs = EXIT_TIMEOUT_MS,
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs)
  const socket = hop ? await tunnel(hop, signal) : null
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: TRACE_HOST,
        port: 443,
        path: TRACE_PATH,
        method: 'GET',
        agent: false,
        signal,
        headers: { Accept: 'text/plain', 'User-Agent': 'Kite' },
        ...(socket
          ? {
              createConnection: () =>
                tls.connect({ socket, servername: TRACE_HOST, host: TRACE_HOST }),
            }
          : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`The trace page answered ${response.statusCode ?? 'nothing'}`))
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.length > MAX_BODY) request.destroy(new Error('The trace page is too long'))
        })
        response.once('end', () => resolve(body))
        response.once('error', reject)
      },
    )
    request.once('error', (error) => {
      socket?.destroy()
      reject(error)
    })
    request.end()
  })
}

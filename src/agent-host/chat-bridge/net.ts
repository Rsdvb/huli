// Huli: the chat bridges' requests and long connections. They go the way Kite's own requests go,
// through the proxy Settings › Advanced or the environment names, else directly (which a TUN
// still catches): Telegram cannot be reached from China otherwise. Bodies and answers are capped,
// every request has a deadline, and no message names an address, which may carry a bot's token.

import type { IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import net, { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { WebSocket } from 'ws'
import { tunnel, type DownloadHop } from '../node-proxy/download'

export type Route = (url: URL) => DownloadHop | null

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: Buffer | string
  /** The whole exchange's deadline. */
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

export interface HttpAnswer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

const DEFAULT_TIMEOUT_MS = 30_000
/** Answers of the platforms' APIs are small; a file the user sent is the exception. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** A failure of the network, not of the platform's answer. */
export class NetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetError'
  }
}

function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** One request, directly or through the hop's tunnel; redirects are not followed. */
export async function httpRequest(
  route: Route,
  address: string,
  request: HttpRequest = {},
): Promise<HttpAnswer> {
  const url = new URL(address)
  if (url.protocol !== 'https:') throw new NetError('Only https addresses are reached')
  const signal = deadline(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const port = url.port ? Number(url.port) : 443
  const hop = route(url)
  let socket: Awaited<ReturnType<typeof tunnel>> | null = null
  try {
    socket = hop ? await tunnel(hop, host, port, signal) : null
  } catch (error) {
    throw new NetError(signal.aborted ? 'The proxy did not answer in time' : describe(error))
  }
  const body = request.body === undefined ? undefined : Buffer.from(request.body)
  return new Promise<HttpAnswer>((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path: `${url.pathname}${url.search}`,
        method: request.method ?? 'GET',
        signal,
        headers: {
          'User-Agent': 'Kite',
          ...request.headers,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
        ...(socket
          ? {
              createConnection: () => {
                socket!.resume()
                return tlsConnect({ socket: socket!, ...(isIP(host) ? {} : { servername: host }) })
              },
            }
          : { agent: false }),
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            response.destroy()
            reject(new NetError('The answer was larger than expected'))
          } else chunks.push(chunk)
        })
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        )
        response.once('error', (error) => reject(new NetError(describe(error))))
      },
    )
    req.once('error', (error) => {
      socket?.destroy()
      reject(new NetError(signal.aborted ? 'The request took too long' : describe(error)))
    })
    req.end(body)
  })
}

/** A request with a JSON body or none, whose answer is JSON; the status comes with it. */
export async function jsonRequest<T = unknown>(
  route: Route,
  address: string,
  request: Omit<HttpRequest, 'body'> & { json?: unknown },
): Promise<{ status: number; data: T; headers: IncomingHttpHeaders }> {
  const { json, ...rest } = request
  const answer = await httpRequest(route, address, {
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      ...rest.headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
  let data: unknown = null
  const text = answer.body.toString('utf8')
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      throw new NetError(`The platform answered ${answer.status} with no JSON`)
    }
  }
  return { status: answer.status, data: data as T, headers: answer.headers }
}

export interface FormPart {
  name: string
  value: string | { bytes: Buffer; fileName: string; mimeType: string }
}

/** A multipart/form-data body, as file uploads take. */
export function multipart(parts: readonly FormPart[]): { body: Buffer; contentType: string } {
  const boundary = `----kite${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const chunks: Buffer[] = []
  const quoted = (text: string) => text.replace(/["\r\n\\]/g, '_')
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"`
    if (typeof part.value === 'string') {
      chunks.push(Buffer.from(`${head}\r\n\r\n${part.value}\r\n`))
      continue
    }
    head += `; filename="${quoted(part.value.fileName)}"\r\nContent-Type: ${part.value.mimeType}\r\n\r\n`
    chunks.push(Buffer.from(head), part.value.bytes, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

export interface SocketOptions {
  headers?: Record<string, string>
  maxPayload?: number
  handshakeTimeoutMs?: number
}

/** Opens a WebSocket, through the hop's tunnel when the route names one; resolves once open. */
export async function openSocket(
  route: Route,
  address: string,
  options: SocketOptions = {},
): Promise<WebSocket> {
  const url = new URL(address)
  if (url.protocol !== 'wss:') throw new NetError('Only wss addresses are reached')
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const port = url.port ? Number(url.port) : 443
  const timeoutMs = options.handshakeTimeoutMs ?? 15_000
  const hop = route(new URL(`https://${url.host}/`))
  let socket: Awaited<ReturnType<typeof tunnel>> | null = null
  if (hop) {
    try {
      socket = await tunnel(hop, host, port, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      throw new NetError(describe(error))
    }
  }
  const ws = new WebSocket(address, {
    headers: { 'User-Agent': 'Kite', ...options.headers },
    perMessageDeflate: false,
    maxPayload: options.maxPayload ?? 4 * 1024 * 1024,
    handshakeTimeout: timeoutMs,
    ...(socket
      ? {
          createConnection: (() => {
            socket!.resume()
            return tlsConnect({ socket: socket!, ...(isIP(host) ? {} : { servername: host }) })
          }) as unknown as typeof net.createConnection,
        }
      : {}),
  })
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
      reject(new NetError(describe(error)))
    }
    ws.once('error', failed)
    ws.once('unexpected-response', (_req, response) =>
      failed(new Error(`The platform refused the connection (HTTP ${response.statusCode})`)),
    )
    ws.once('open', () => {
      ws.off('error', failed)
      // ws emits `error` as an EventEmitter does, which throws without a listener; `close` follows.
      ws.on('error', () => {})
      resolve(ws)
    })
  })
}

/** An error's own words, without any address it may name. */
export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '<address>').slice(0, 300)
}

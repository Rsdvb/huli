// Huli: the requests of Kite's own downloads: its Node.js install, and the harnesses' release
// archives, the ACP Registry's listing and the harness manifest. They go the way Kite's own
// requests go, as a subscription's download does: through the proxy Settings › Advanced or the
// environment names, else directly (which a Clash or Karing TUN still catches), and never through
// an agent's node. Huli's own; see tools/huli/README.md (Kite's own Node.js).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { request, type DownloadHop, type ProxyVariables } from '../node-proxy/download'

const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Neither nodejs.org nor the mirror needs more; no compression is asked for, so bytes are as stored.
const HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'Kite', Accept: '*/*' }

export interface TextOptions {
  signal: AbortSignal
  maxBytes: number
  /** Replaces the default headers' fields of the same name. */
  headers?: Readonly<Record<string, string>>
  /** How many redirects are followed; a redirect past them fails as its status. */
  maxRedirects?: number
  /** Fails once no byte arrives for this long, from the request on. */
  stallMs?: number
}

export interface FileOptions {
  signal: AbortSignal
  onBytes?(received: number, total: number | null): void
  /** Fails once no byte arrives for this long, from the request on. */
  stallMs?: number
}

export interface Transport {
  /** A small text file, such as `index.json` or `SHASUMS256.txt`, up to `maxBytes`. */
  text(url: string, options: TextOptions): Promise<string>
  /**
   * Streams a file to `file`, hashing it as it goes; `onBytes` hears how much arrived and how much
   * the server said it would send.
   */
  file(url: string, file: string, options: FileOptions): Promise<{ sha256: string; bytes: number }>
}

/** An answer the server gave that is not the file, such as 404. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** Nothing arrived for `stallMs`: the connection, the proxy or the server hangs. */
export class StalledError extends Error {
  constructor(readonly stallMs: number) {
    super(`Nothing arrived for ${Math.round(stallMs / 1000)} s`)
  }
}

/** The answer is larger than the caller takes. */
export class TooLargeError extends Error {}

/** The proxy variables of Kite's own requests, as the agent environment holds them. */
export function ownProxyVariables(get: (name: string) => string | undefined): ProxyVariables {
  const read = (name: string) => get(name) ?? get(name.toLowerCase()) ?? null
  return {
    http: read('HTTP_PROXY'),
    https: read('HTTPS_PROXY'),
    all: read('ALL_PROXY'),
    noProxy: read('NO_PROXY'),
  }
}

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

/**
 * The signal a request runs under: the caller's, and a stall's once nothing arrived for
 * `stallMs`; `alive` restarts the wait at each byte.
 */
function stallWatch(signal: AbortSignal, stallMs: number | undefined) {
  if (!stallMs) return { signal, alive: () => {}, done: () => {}, stalled: () => false }
  const stall = new AbortController()
  const fire = () => stall.abort(new StalledError(stallMs))
  let timer = setTimeout(fire, stallMs)
  return {
    signal: AbortSignal.any([signal, stall.signal]),
    alive: () => {
      clearTimeout(timer)
      timer = setTimeout(fire, stallMs)
    },
    done: () => clearTimeout(timer),
    stalled: () => stall.signal.aborted && !signal.aborted,
  }
}

async function open(
  url: string,
  route: (url: URL) => DownloadHop | null,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
  maxRedirects: number,
): Promise<IncomingMessage> {
  let current = new URL(url)
  for (let redirects = 0; ; redirects++) {
    // Plain http only to this computer, as a test's server is, and never after a redirect.
    const local = redirects === 0 && current.protocol === 'http:' && isLoopback(current.hostname)
    if (current.protocol !== 'https:' && !local) {
      throw new Error('Only https addresses are downloaded')
    }
    const response = await request(current, route(current), signal, headers)
    const status = response.statusCode ?? 0
    if (REDIRECTS.has(status)) {
      response.resume()
      const location = response.headers.location
      if (!location || redirects >= maxRedirects) throw new HttpStatusError(status)
      current = new URL(location, current)
      continue
    }
    if (status < 200 || status > 299) {
      response.resume()
      throw new HttpStatusError(status)
    }
    return response
  }
}

export function httpTransport(route: () => (url: URL) => DownloadHop | null): Transport {
  return {
    async text(url, options) {
      const watch = stallWatch(options.signal, options.stallMs)
      try {
        const response = await open(
          url,
          route(),
          watch.signal,
          { ...HEADERS, ...options.headers },
          options.maxRedirects ?? MAX_REDIRECTS,
        )
        watch.alive()
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response as AsyncIterable<Buffer>) {
          watch.alive()
          size += chunk.length
          if (size > options.maxBytes) {
            response.destroy()
            throw new TooLargeError(`${new URL(url).pathname} is larger than expected`)
          }
          chunks.push(chunk)
        }
        return Buffer.concat(chunks).toString('utf8')
      } catch (error) {
        if (watch.stalled()) throw new StalledError(options.stallMs ?? 0)
        throw error
      } finally {
        watch.done()
      }
    },
    async file(url, file, { signal, onBytes, stallMs }) {
      const watch = stallWatch(signal, stallMs)
      try {
        const response = await open(url, route(), watch.signal, HEADERS, MAX_REDIRECTS)
        watch.alive()
        const declared = Number(response.headers['content-length'])
        const total = Number.isSafeInteger(declared) && declared > 0 ? declared : null
        const hash = createHash('sha256')
        let bytes = 0
        const count = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            watch.alive()
            hash.update(chunk)
            bytes += chunk.length
            onBytes?.(bytes, total)
            done(null, chunk)
          },
        })
        await pipeline(response, count, createWriteStream(file, { mode: 0o600 }), {
          signal: watch.signal,
        })
        if (total !== null && bytes !== total) throw new Error('The download ended early')
        return { sha256: hash.digest('hex'), bytes }
      } catch (error) {
        if (watch.stalled()) throw new StalledError(stallMs ?? 0)
        throw error
      } finally {
        watch.done()
      }
    },
  }
}

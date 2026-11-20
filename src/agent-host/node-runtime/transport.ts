// Huli: the requests of Kite's own Node.js install. They go the way Kite's own requests go, as a
// subscription's download does: through the proxy Settings › Advanced or the environment names,
// else directly (which a Clash or Karing TUN still catches), and never through an agent's node.
// Huli's own; see tools/huli/README.md (Kite's own Node.js).

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { request, type DownloadHop } from '../node-proxy/download'

const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Neither nodejs.org nor the mirror needs more; no compression is asked for, so bytes are as stored.
const HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'Kite', Accept: '*/*' }

export interface Transport {
  /** A small text file, such as `index.json` or `SHASUMS256.txt`, up to `maxBytes`. */
  text(url: string, options: { signal: AbortSignal; maxBytes: number }): Promise<string>
  /**
   * Streams a file to `file`, hashing it as it goes; `onBytes` hears how much arrived and how much
   * the server said it would send.
   */
  file(
    url: string,
    file: string,
    options: { signal: AbortSignal; onBytes?(received: number, total: number | null): void },
  ): Promise<{ sha256: string; bytes: number }>
}

/** An answer the server gave that is not the file, such as 404. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

async function open(
  url: string,
  route: (url: URL) => DownloadHop | null,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  let current = new URL(url)
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'https:') throw new Error('Only https addresses are downloaded')
    const response = await request(current, route(current), signal, HEADERS)
    const status = response.statusCode ?? 0
    if (REDIRECTS.has(status)) {
      response.resume()
      const location = response.headers.location
      if (!location || redirects >= MAX_REDIRECTS) throw new HttpStatusError(status)
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
    async text(url, { signal, maxBytes }) {
      const response = await open(url, route(), signal)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > maxBytes) {
          response.destroy()
          throw new Error(`${new URL(url).pathname} is larger than expected`)
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    },
    async file(url, file, { signal, onBytes }) {
      const response = await open(url, route(), signal)
      const declared = Number(response.headers['content-length'])
      const total = Number.isSafeInteger(declared) && declared > 0 ? declared : null
      const hash = createHash('sha256')
      let bytes = 0
      const count = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk)
          bytes += chunk.length
          onBytes?.(bytes, total)
          done(null, chunk)
        },
      })
      await pipeline(response, count, createWriteStream(file, { mode: 0o600 }), { signal })
      if (total !== null && bytes !== total) throw new Error('The download ended early')
      return { sha256: hash.digest('hex'), bytes }
    },
  }
}

// Huli: the dev server previews' proxy against a real dev server on the loopback: who it lets
// through (the preview's cookie from a spent ticket, from the preview's own pages), where it goes
// (the one port, as localhost), what it rewrites, and when it ends.

import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  cookieName,
  cookieValue,
  DevPreviews,
  downstreamHeaders,
  entryTarget,
  MAX_DEVICE_PREVIEWS,
  previewBind,
  previewCookie,
  previewLocation,
  PreviewError,
  upstreamHeaders,
} from './previews'

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

let dev: Server
let devPort: number
let seen: Seen[]
let sockets: WebSocketServer
let clock: number
let previews: DevPreviews

const listen = (server: Server | net.Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )

beforeEach(async () => {
  seen = []
  clock = 1_000_000
  dev = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `http://localhost:${devPort}/next?a=1` })
        return void res.end()
      }
      if (req.url === '/cookies') {
        res.writeHead(200, {
          'Set-Cookie': [
            'sid=1; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None',
            `${cookieName(1234)}=stolen; Path=/`,
          ],
        })
        return void res.end('ok')
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.write('first;')
        // The rest only once the client said it read the first part.
        dev.once('next', () => res.end('second'))
        return
      }
      if (req.url === '/big') {
        res.writeHead(200)
        return void res.end('x'.repeat(4096))
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive' })
      res.end(`page ${req.url}`)
    })
  })
  sockets = new WebSocketServer({ server: dev })
  sockets.on('connection', (ws, req) => {
    ws.send(`hello ${req.headers.origin} ${req.headers.host}`)
    ws.on('message', (data) => ws.send(`echo ${String(data)}`))
  })
  devPort = await listen(dev)
  previews = new DevPreviews({
    log: () => {},
    now: () => clock,
    idleMs: 60_000,
    maxMs: 600_000,
    maxRequestBytes: 1024,
    maxResponseBytes: 2048,
  })
})

afterEach(async () => {
  previews.closeAll()
  sockets.close()
  dev.closeAllConnections()
  await new Promise((resolve) => dev.close(resolve))
})

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

/** Writes `text` on a fresh connection and reads what comes back until it closes. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let got = ''
    socket.on('data', (chunk) => (got += chunk.toString()))
    socket.on('error', () => resolve(got))
    socket.on('close', () => resolve(got))
    socket.write(text)
    setTimeout(() => socket.destroy(), 1500)
  })
}

/** Opens a preview of the dev server and spends its ticket, as the phone's web view does. */
async function opened(deviceId = 'phone') {
  const { port, path } = await previews.open(
    deviceId,
    { host: '127.0.0.1', port: devPort },
    '127.0.0.1',
  )
  const entry = await send(port, { path })
  expect(entry.status).toBe(303)
  const setCookie = entry.headers['set-cookie']![0]!
  const cookie = setCookie.split(';')[0]!
  return { port, path, cookie, setCookie, host: `127.0.0.1:${port}` }
}

describe('a preview', () => {
  it('lets the web view in once with its ticket, then by its cookie alone', async () => {
    const p = await opened()
    expect(p.setCookie).toMatch(
      /^kite_preview_\d+=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/,
    )
    expect(p.cookie.startsWith(`${cookieName(p.port)}=`)).toBe(true)
    // The ticket is spent: the same entry again is refused, and so is a made-up one.
    expect((await send(p.port, { path: p.path })).status).toBe(403)
    expect((await send(p.port, { path: `/__kite_preview/${'A'.repeat(43)}` })).status).toBe(403)
    expect(seen).toEqual([])
    const page = await send(p.port, { path: '/app', headers: { Cookie: p.cookie } })
    expect(page).toMatchObject({ status: 200, body: 'page /app' })
    // Without the cookie, or with another value, nothing reaches the dev server.
    expect((await send(p.port, { path: '/app' })).status).toBe(403)
    const wrong = `${cookieName(p.port)}=${'B'.repeat(43)}`
    expect((await send(p.port, { path: '/app', headers: { Cookie: wrong } })).status).toBe(403)
    expect(seen.map((s) => s.url)).toEqual(['/app'])
  })

  it('sends the web view on to a path of its own from the entry, never elsewhere', async () => {
    for (const [to, location] of [
      ['/src/main.tsx?x=1', '/src/main.tsx?x=1'],
      ['//evil.example/x', '/'],
      ['/\\evil.example', '/'],
      ['https://evil.example/', '/'],
      ['/__kite_preview/x', '/'],
    ]) {
      const { port, path } = await previews.open(
        'phone',
        { host: '127.0.0.1', port: devPort },
        '127.0.0.1',
      )
      const entry = await send(port, { path: `${path}?to=${encodeURIComponent(to!)}` })
      expect(entry.headers.location).toBe(location)
    }
    expect(entryTarget(`/a\r\nSet-Cookie: x=1`)).toBe('/')
  })

  it('takes a request from its own pages alone, by Origin and fetch metadata', async () => {
    const p = await opened()
    const own = `http://${p.host}`
    const ok = (headers: Record<string, string>) =>
      send(p.port, { path: '/x', headers: { Cookie: p.cookie, ...headers } }).then((a) => a.status)
    expect(await ok({ Origin: own, 'Sec-Fetch-Site': 'same-origin' })).toBe(200)
    expect(await ok({ 'Sec-Fetch-Site': 'none' })).toBe(200)
    // Another preview's page shares the site and so the cookie, not the origin.
    expect(await ok({ Origin: 'http://127.0.0.1:1' })).toBe(403)
    expect(await ok({ Origin: 'null' })).toBe(403)
    expect(await ok({ 'Sec-Fetch-Site': 'same-site' })).toBe(403)
    expect(await ok({ 'Sec-Fetch-Site': 'cross-site' })).toBe(403)
    expect(seen.length).toBe(2)
  })

  it('goes to its own port of the loopback alone, never as a forward proxy', async () => {
    const p = await opened()
    // An absolute URL, as a forward proxy is asked, is refused before anything is read.
    const absolute = await raw(
      p.port,
      `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nCookie: ${p.cookie}\r\n\r\n`,
    )
    expect(absolute).toMatch(/^HTTP\/1\.1 400/)
    const connect = await raw(
      p.port,
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nCookie: ${p.cookie}\r\n\r\n`,
    )
    expect(connect).not.toMatch(/^HTTP\/1\.1 200/)
    const star = await raw(
      p.port,
      `OPTIONS * HTTP/1.1\r\nHost: ${p.host}\r\nCookie: ${p.cookie}\r\n\r\n`,
    )
    expect(star).toMatch(/^HTTP\/1\.1 400/)
    expect(seen).toEqual([])
    // A path that reads as another host's is only a path of the dev server's.
    const tricky = await send(p.port, { path: '//example.com/x', headers: { Cookie: p.cookie } })
    expect(tricky.body).toBe('page //example.com/x')
    expect(seen[0]!.headers.host).toBe(`localhost:${devPort}`)
  })

  it('rewrites the headers as a page of localhost would send them, and keeps its cookie', async () => {
    const p = await opened()
    const own = `http://${p.host}`
    await send(p.port, {
      method: 'POST',
      path: '/api',
      body: 'hi',
      headers: {
        Cookie: `${p.cookie}; theme=dark; ${cookieName(9)}=other`,
        Origin: own,
        Referer: `${own}/page?q=1`,
        'X-Forwarded-For': '6.6.6.6',
        'X-Forwarded-Host': 'evil.example',
        Forwarded: 'for=6.6.6.6',
        'Proxy-Authorization': 'Basic x',
        'Content-Type': 'text/plain',
      },
    })
    const headers = seen[0]!.headers
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api', body: 'hi' })
    expect(headers.host).toBe(`localhost:${devPort}`)
    expect(headers.origin).toBe(`http://localhost:${devPort}`)
    expect(headers.referer).toBe(`http://localhost:${devPort}/page?q=1`)
    expect(headers.cookie).toBe('theme=dark')
    expect(headers['content-type']).toBe('text/plain')
    for (const name of [
      'x-forwarded-for',
      'x-forwarded-host',
      'forwarded',
      'proxy-authorization',
    ]) {
      expect(headers[name]).toBeUndefined()
    }
  })

  it("keeps the dev server's redirects and cookies on the preview's origin", async () => {
    const p = await opened()
    const redirect = await send(p.port, { path: '/redirect', headers: { Cookie: p.cookie } })
    expect(redirect).toMatchObject({ status: 302 })
    expect(redirect.headers.location).toBe('/next?a=1')
    const cookies = await send(p.port, { path: '/cookies', headers: { Cookie: p.cookie } })
    expect(cookies.headers['set-cookie']).toEqual(['sid=1; Path=/; HttpOnly; SameSite=Lax'])
  })

  it('streams a response as the dev server writes it', async () => {
    const p = await opened()
    const first = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: p.port, path: '/stream', headers: { Cookie: p.cookie } },
        (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            if (body === 'first;') dev.emit('next')
          })
          res.on('end', () => resolve(body))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(first).toBe('first;second')
  })

  it('cuts a request or a response past its size', async () => {
    const p = await opened()
    const large = await send(p.port, {
      method: 'POST',
      path: '/upload',
      body: 'x'.repeat(2048),
      headers: { Cookie: p.cookie },
    })
    expect(large.status).toBe(413)
    expect(seen).toEqual([])
    await expect(send(p.port, { path: '/big', headers: { Cookie: p.cookie } })).rejects.toThrow()
  })

  it("carries the dev server's WebSocket, as HMR's, with the cookie alone", async () => {
    const p = await opened()
    const own = `http://${p.host}`
    const ws = new WebSocket(`ws://${p.host}/?token=hmr`, 'vite-hmr', {
      headers: { Cookie: p.cookie, Origin: own },
    })
    const messages: string[] = []
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        messages.push(String(data))
        if (messages.length === 1) ws.send('ping')
        if (messages.length === 2) resolve()
      })
      ws.on('error', reject)
    })
    expect(messages).toEqual([
      `hello http://localhost:${devPort} localhost:${devPort}`,
      'echo ping',
    ])
    ws.close()
    const refused = new WebSocket(`ws://${p.host}/`, { headers: { Origin: own } })
    const status = await new Promise<number>((resolve) =>
      refused.on('unexpected-response', (_req, res) => resolve(res.statusCode!)),
    )
    expect(status).toBe(403)
    const foreign = new WebSocket(`ws://${p.host}/`, {
      headers: { Cookie: p.cookie, Origin: 'http://127.0.0.1:1' },
    })
    const foreignStatus = await new Promise<number>((resolve) =>
      foreign.on('unexpected-response', (_req, res) => resolve(res.statusCode!)),
    )
    expect(foreignStatus).toBe(403)
  })

  it('ends once unused for its idle time, or after its longest, and its port closes', async () => {
    const p = await opened()
    clock += 59_000
    expect((await send(p.port, { headers: { Cookie: p.cookie } })).status).toBe(200)
    clock += 59_000
    expect((await send(p.port, { headers: { Cookie: p.cookie } })).status).toBe(200)
    clock += 60_000
    expect((await send(p.port, { headers: { Cookie: p.cookie } })).status).toBe(403)
    await expect.poll(() => previews.size).toBe(0)
    await expect(send(p.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })

    const q = await opened()
    for (let step = 0; step < 10; step++) {
      clock += 55_000
      expect((await send(q.port, { headers: { Cookie: q.cookie } })).status).toBe(200)
    }
    // Used all along, it still ends at its longest.
    clock += 55_000
    expect((await send(q.port, { headers: { Cookie: q.cookie } })).status).toBe(403)
  })

  it('goes with its device, its open WebSocket too, and a new one has a new token', async () => {
    const p = await opened('phone')
    const other = await opened('tablet')
    const ws = new WebSocket(`ws://${p.host}/`, { headers: { Cookie: p.cookie } })
    await new Promise((resolve) => ws.once('message', resolve))
    const closed = new Promise((resolve) => ws.once('close', resolve))
    previews.revokeDevice('phone')
    await closed
    await expect(send(p.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect((await send(other.port, { headers: { Cookie: other.cookie } })).status).toBe(200)
    const again = await opened('phone')
    expect(again.cookie).not.toBe(p.cookie)
  })

  it('keeps one preview of a port for a device, and so many in all', async () => {
    const first = await previews.open('phone', { host: '127.0.0.1', port: devPort }, '127.0.0.1')
    const second = await previews.open('phone', { host: '127.0.0.1', port: devPort }, '127.0.0.1')
    expect(second.port).toBe(first.port)
    expect(second.path).not.toBe(first.path)
    // Closed and opened again, it takes its port again, so the dev server keeps its origin.
    previews.close('phone', devPort)
    const third = await previews.open('phone', { host: '127.0.0.1', port: devPort }, '127.0.0.1')
    expect(third.port).toBe(first.port)
    for (let port = 30_001; previews.size < MAX_DEVICE_PREVIEWS; port++) {
      await previews.open('phone', { host: '127.0.0.1', port }, '127.0.0.1')
    }
    await expect(
      previews.open('phone', { host: '127.0.0.1', port: 40_000 }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(PreviewError)
  })

  it("answers when the dev server stopped, without the dev server's port open", async () => {
    const p = await opened()
    sockets.close()
    dev.closeAllConnections()
    await new Promise((resolve) => dev.close(resolve))
    const down = await send(p.port, {
      headers: { Cookie: p.cookie, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })
    expect(down.status).toBe(502)
    expect(down.body).toContain(String(devPort))
    dev = createServer()
    await listen(dev)
  })
})

describe("a preview's headers", () => {
  it('drops the hop-by-hop ones and those the Connection header names', () => {
    const out = upstreamHeaders(
      [
        'Host',
        'x',
        'Connection',
        'keep-alive, X-Hop',
        'X-Hop',
        '1',
        'TE',
        'trailers',
        'Accept',
        '*/*',
      ],
      { own: 'http://192.168.1.5:40000', target: 5173, upgrade: false },
    )
    expect(out).toEqual(['Host', 'localhost:5173', 'Accept', '*/*'])
    const ws = upstreamHeaders(
      ['Host', 'x', 'Connection', 'Upgrade', 'Upgrade', 'websocket', 'Sec-WebSocket-Key', 'k'],
      { own: 'http://192.168.1.5:40000', target: 5173, upgrade: true },
    )
    expect(ws).toEqual([
      'Host',
      'localhost:5173',
      'Sec-WebSocket-Key',
      'k',
      'Connection',
      'Upgrade',
      'Upgrade',
      'websocket',
    ])
    // An Origin or a Referer of another origin is never passed on as localhost's.
    expect(
      upstreamHeaders(['Origin', 'http://evil.example', 'Referer', 'http://evil.example/'], {
        own: 'http://192.168.1.5:40000',
        target: 5173,
        upgrade: false,
      }),
    ).toEqual(['Host', 'localhost:5173'])
    expect(
      downstreamHeaders(['Transfer-Encoding', 'chunked', 'Keep-Alive', 'x', 'ETag', 'e'], 1),
    ).toEqual(['ETag', 'e'])
  })

  it("rewrites only the dev server's own redirects, and its cookies' domains", () => {
    expect(previewLocation('http://127.0.0.1:5173/a#b', 5173)).toBe('/a#b')
    expect(previewLocation('http://[::1]:5173/a', 5173)).toBe('/a')
    expect(previewLocation('http://localhost:3000/a', 5173)).toBe('http://localhost:3000/a')
    expect(previewLocation('https://accounts.example/login', 5173)).toBe(
      'https://accounts.example/login',
    )
    expect(previewLocation('/relative', 5173)).toBe('/relative')
    expect(previewCookie('a=1; domain=.localhost; secure; samesite=none')).toBe('a=1; SameSite=Lax')
    expect(previewCookie('kite_preview_4000=x')).toBeNull()
    expect(cookieValue('a=1; kite_preview_1=tok; b=2', 'kite_preview_1')).toBe('tok')
    expect(cookieValue('xkite_preview_1=tok', 'kite_preview_1')).toBeNull()
  })

  it('listens on an IPv4 address as itself', () => {
    expect(previewBind('::ffff:192.168.1.5')).toBe('192.168.1.5')
    expect(previewBind('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
    expect(previewBind(undefined)).toBeNull()
  })
})

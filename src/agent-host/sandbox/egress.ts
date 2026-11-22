// Huli: the only way out of a sandboxed session's container. The agent's container sits on a
// network of its own with no route anywhere (`--internal`); beside it, on that network and on the
// engine's bridge, runs this small proxy, as `node -e` in Kite's image. The agent gets it in its
// proxy variables. What it lets through:
//
// - `allow`: CONNECT and plain HTTP to the model's addresses only (`host`, `host:port` or
//   `*.suffix`; a bare host allows 443 and 80). Anything else is refused with 403.
// - `tunnel`: everything, but only through Kite: the agent host dials into the proxy's tunnel port,
//   published on the engine's loopback, and hands each request on to the agent's own listener of
//   Agent 网络. With no dial-in to take, a request is refused with 503.
//
// It imports Node's built-ins only, so it needs nothing in the image beside Node.js, and it fails
// closed: what it cannot parse or route, it refuses.

/** Where the agent's container finds the proxy: its alias on the session's network and port. */
export const EGRESS_HOST = 'kite-egress'
export const EGRESS_PORT = 3128
/** The port the agent host dials into in `tunnel` mode, published on the engine's loopback. */
export const TUNNEL_PORT = 7000

export const EGRESS_SOURCE = String.raw`'use strict'
const http = require('node:http')
const net = require('node:net')
const mode = process.env.KITE_EGRESS_MODE
const token = process.env.KITE_EGRESS_TOKEN || ''
const rules = (process.env.KITE_EGRESS_ALLOW || '')
  .split(',')
  .map((rule) => rule.trim().toLowerCase())
  .filter(Boolean)
const WAIT_MS = Number(process.env.KITE_EGRESS_WAIT_MS || 10000)
function target(text) {
  const m = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(text) || /^([a-z0-9.-]+):(\d{1,5})$/i.exec(text)
  if (!m) return null
  const port = Number(m[2])
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null
}
function allowed(host, port) {
  if (mode === 'tunnel') return true
  return rules.some((rule) => {
    const at = rule.lastIndexOf(':')
    const name = at > 0 && /^\d+$/.test(rule.slice(at + 1)) ? rule.slice(0, at) : rule
    const ports = name === rule ? [443, 80] : [Number(rule.slice(at + 1))]
    if (!ports.includes(port)) return false
    if (name.startsWith('*.')) return host.endsWith(name.slice(1)) && host.length > name.length - 1
    return host === name
  })
}
const pool = []
const waiting = []
function take() {
  return new Promise((resolve) => {
    const next = pool.shift()
    if (next) return resolve(next)
    const wait = { resolve, timer: setTimeout(() => {
      waiting.splice(waiting.indexOf(wait), 1)
      resolve(null)
    }, WAIT_MS) }
    waiting.push(wait)
  })
}
function offer(socket) {
  const wait = waiting.shift()
  if (wait) {
    clearTimeout(wait.timer)
    wait.resolve(socket)
  } else pool.push(socket)
  socket.once('close', () => {
    const i = pool.indexOf(socket)
    if (i >= 0) pool.splice(i, 1)
  })
}
function line(socket) {
  return new Promise((resolve) => {
    let text = ''
    const done = (value, rest) => {
      socket.off('data', data)
      socket.off('close', closed)
      socket.pause()
      if (rest && rest.length) socket.unshift(rest)
      resolve(value)
    }
    const data = (chunk) => {
      text += chunk.toString('latin1')
      const at = text.indexOf('\n')
      if (at >= 0) done(text.slice(0, at).trim(), Buffer.from(text.slice(at + 1), 'latin1'))
      else if (text.length > 1024) done(null)
    }
    const closed = () => done(null)
    socket.on('data', data)
    socket.on('close', closed)
    // A socket paused after an earlier line stays paused for a new listener.
    socket.resume()
  })
}
async function open(host, port) {
  if (mode !== 'tunnel') {
    return new Promise((resolve) => {
      const socket = net.connect(port, host, () => resolve(socket))
      socket.once('error', () => resolve(null))
    })
  }
  const socket = await take()
  if (!socket) return null
  socket.write(host + ':' + port + '\n')
  const answer = await line(socket)
  if (answer !== 'OK') {
    socket.destroy()
    return null
  }
  return socket
}
const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url)
  } catch {
    res.writeHead(400).end()
    return
  }
  const port = Number(url.port || 80)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'http:' || !allowed(host, port)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Kite sandbox: ' + host + ' is not allowed\n')
    return
  }
  const socket = await open(host, port)
  if (!socket) {
    res.writeHead(mode === 'tunnel' ? 503 : 502).end()
    return
  }
  const headers = { ...req.headers }
  for (const name of Object.keys(headers)) if (/^proxy-/i.test(name)) delete headers[name]
  const out = http.request(
    { method: req.method, path: url.pathname + url.search, headers, createConnection: () => socket },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers)
      answer.pipe(res)
    },
  )
  out.on('error', () => res.destroy())
  // A tunnel's socket comes paused from reading its answer line.
  socket.resume()
  req.pipe(out)
})
server.on('connect', async (req, client, head) => {
  const to = target(req.url || '')
  if (!to || !allowed(to.host, to.port)) {
    client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const socket = await open(to.host, to.port)
  if (!socket) {
    client.end('HTTP/1.1 ' + (mode === 'tunnel' ? '503' : '502') + ' Unavailable\r\nContent-Length: 0\r\n\r\n')
    return
  }
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head && head.length) socket.write(head)
  socket.pipe(client)
  client.pipe(socket)
  const close = () => {
    socket.destroy()
    client.destroy()
  }
  socket.on('error', close)
  client.on('error', close)
})
server.listen(Number(process.env.KITE_EGRESS_PORT || ${EGRESS_PORT}), '0.0.0.0', () => {
  process.stdout.write('egress ' + server.address().port + '\n')
})
if (mode === 'tunnel') {
  net
    .createServer(async (socket) => {
      socket.on('error', () => socket.destroy())
      const hello = await line(socket)
      if (!token || hello !== 'KITE ' + token) return socket.destroy()
      offer(socket)
    })
    .listen(Number(process.env.KITE_TUNNEL_PORT || ${TUNNEL_PORT}), '0.0.0.0', function () {
      process.stdout.write('tunnel ' + this.address().port + '\n')
    })
}
`

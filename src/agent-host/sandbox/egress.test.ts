// The container's only way out, run as the very source its sidecar runs: what it lets through to
// the model's addresses, what it refuses, and the tunnel through the agent host to Agent 网络.

import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EGRESS_SOURCE } from './egress'
import { EgressTunnel } from './tunnel'

const running: (ChildProcess | http.Server | EgressTunnel)[] = []

afterEach(async () => {
  for (const item of running.splice(0)) {
    if (item instanceof EgressTunnel) item.stop()
    else if (item instanceof http.Server) await new Promise((resolve) => item.close(resolve))
    else item.kill()
  }
})

/** A stand-in for a model's service: answers every request with its own name. */
async function standIn(name: string): Promise<number> {
  const server = http.createServer((req, res) => res.end(`${name} ${req.method} ${req.url}`))
  running.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

/** The egress proxy as a process of its own, and the ports it says it listens on. */
async function egress(env: Record<string, string>): Promise<{ egress: number; tunnel?: number }> {
  const child = spawn(process.execPath, ['-e', EGRESS_SOURCE], {
    env: { ...process.env, KITE_EGRESS_PORT: '0', KITE_TUNNEL_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  running.push(child)
  const ports: { egress?: number; tunnel?: number } = {}
  const wants = env.KITE_EGRESS_MODE === 'tunnel' ? 2 : 1
  await new Promise<void>((resolve, reject) => {
    let text = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      for (const [, kind, port] of text.matchAll(/(egress|tunnel) (\d+)\n/g)) {
        ports[kind as 'egress' | 'tunnel'] = Number(port)
      }
      if (Object.keys(ports).length >= wants) resolve()
    })
    child.once('exit', (code) => reject(new Error(`egress exited ${code}`)))
  })
  return ports as { egress: number; tunnel?: number }
}

/** CONNECT through the proxy, then one request over the tunnel; the status line, then the body. */
function connect(proxy: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let text = ''
    let status = 0
    socket.on('data', (chunk) => {
      text += chunk.toString()
      if (!status) {
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) return
        status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)
        text = text.slice(end + 4)
        if (status !== 200) return void socket.end()
        socket.write(`GET /hello HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`)
      }
    })
    socket.on('end', () => resolve({ status, body: text.split('\r\n\r\n').slice(1).join('') }))
    socket.on('error', reject)
  })
}

/** A plain HTTP request through the proxy, in the absolute form proxies take. */
function get(proxy: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxy,
        method: 'GET',
        path: url,
        headers: { host: new URL(url).host },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe("the container's egress proxy", () => {
  it("lets through only the model's addresses, and refuses every other", async () => {
    const model = await standIn('model')
    const other = await standIn('other')
    const proxy = await egress({
      KITE_EGRESS_MODE: 'allow',
      KITE_EGRESS_ALLOW: `localhost:${model}, *.example.invalid`,
    })
    expect(await connect(proxy.egress, `localhost:${model}`)).toEqual({
      status: 200,
      body: 'model GET /hello',
    })
    expect((await connect(proxy.egress, `localhost:${other}`)).status).toBe(403)
    expect((await connect(proxy.egress, `127.0.0.1:${model}`)).status).toBe(403)
    expect((await connect(proxy.egress, 'example.invalid:443')).status).toBe(403)
    expect((await connect(proxy.egress, 'evil-example.invalid:443')).status).toBe(403)
    expect(await get(proxy.egress, `http://localhost:${model}/a?b=1`)).toEqual({
      status: 200,
      body: 'model GET /a?b=1',
    })
    expect((await get(proxy.egress, `http://localhost:${other}/`)).status).toBe(403)
  })

  it('allows nothing without a list', async () => {
    const model = await standIn('model')
    const proxy = await egress({ KITE_EGRESS_MODE: 'allow', KITE_EGRESS_ALLOW: '' })
    expect((await connect(proxy.egress, `localhost:${model}`)).status).toBe(403)
  })

  it("sends everything through the agent host's tunnel to the agent's listener, and no other way", async () => {
    const model = await standIn('model')
    const other = await standIn('other')
    // The agent's listener of Agent 网络 stands in as a proxy that lets only `model` through.
    const listener = await egress({
      KITE_EGRESS_MODE: 'allow',
      KITE_EGRESS_ALLOW: `localhost:${model}`,
    })
    const proxy = await egress({
      KITE_EGRESS_MODE: 'tunnel',
      KITE_EGRESS_TOKEN: 'secret-token',
      KITE_EGRESS_WAIT_MS: '1500',
    })
    // With nobody dialled in, a request waits for a moment and is refused.
    expect((await connect(proxy.egress, `localhost:${model}`)).status).toBe(503)
    // A dial-in with the wrong token is never used.
    const stranger = new EgressTunnel({
      port: proxy.tunnel!,
      token: 'wrong',
      upstream: listener.egress,
      spare: 2,
    })
    running.push(stranger)
    expect((await connect(proxy.egress, `localhost:${model}`)).status).toBe(503)
    stranger.stop()
    const tunnel = new EgressTunnel({
      port: proxy.tunnel!,
      token: 'secret-token',
      upstream: listener.egress,
      spare: 2,
    })
    running.push(tunnel)
    expect(await connect(proxy.egress, `localhost:${model}`)).toEqual({
      status: 200,
      body: 'model GET /hello',
    })
    // The listener refuses it, so the proxy does too.
    expect((await connect(proxy.egress, `localhost:${other}`)).status).toBe(503)
    expect(await get(proxy.egress, `http://localhost:${model}/x`)).toEqual({
      status: 200,
      body: 'model GET /x',
    })
    // Several at once each take a connection of their own.
    const many = await Promise.all(
      Array.from({ length: 5 }, () => connect(proxy.egress, `localhost:${model}`)),
    )
    expect(many.map((one) => one.status)).toEqual([200, 200, 200, 200, 200])
  })
})

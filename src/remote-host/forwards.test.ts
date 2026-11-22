import { EventEmitter } from 'node:events'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientForwards } from './client-forwards'
import { HostForwards } from './forwards'

class FakeSocket extends EventEmitter {
  destroyed = false
  writableLength = 0
  write(): boolean {
    return true
  }
  end(): void {}
  pause(): void {}
  resume(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

function hostForwards() {
  const sent: unknown[] = []
  const connected: string[] = []
  const sockets: FakeSocket[] = []
  const forwards = new HostForwards({
    send: (message) => sent.push(message),
    sendBytes: () => {},
    transport: { buffered: () => 0, drained: async () => {} },
    connect: (host, port) => {
      connected.push(`${host}:${port}`)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as net.Socket
    },
    log: () => {},
  })
  return { forwards, sent, connected, sockets }
}

describe('HostForwards grants', () => {
  it('opens only a port the owner forwarded, for its scope', () => {
    const t = hostForwards()
    t.forwards.open(1, { sessionId: 's1', host: 'localhost', port: 5173 })
    expect(t.connected).toEqual([])
    expect(t.sent).toEqual([
      { type: 'stream.cancel', stream: 1, error: expect.objectContaining({ code: 'forbidden' }) },
    ])
    expect(t.forwards.grant('s1', 5173)).toBe(true)
    t.forwards.open(3, { sessionId: 's1', host: 'localhost', port: 5173 })
    // Another scope, or another address of the loopback, is no grant of it.
    t.forwards.open(5, { sessionId: 's2', host: 'localhost', port: 5173 })
    t.forwards.open(7, { sessionId: 's1', host: '127.0.0.1', port: 5173 })
    expect(t.connected).toEqual(['localhost:5173'])
    expect(t.forwards.has(3)).toBe(true)
    expect(t.forwards.has(5)).toBe(false)
  })

  it('takes a grant back with its connections', () => {
    const t = hostForwards()
    t.forwards.grant('', 3000)
    t.forwards.open(1, { sessionId: '', host: 'localhost', port: 3000 })
    t.forwards.revoke('', 3000)
    expect(t.sockets[0]!.destroyed).toBe(true)
    expect(t.forwards.has(1)).toBe(false)
    t.forwards.open(3, { sessionId: '', host: 'localhost', port: 3000 })
    expect(t.connected).toEqual(['localhost:3000'])
  })

  it('keeps as many grants as it may, and drops them with the session', () => {
    const t = hostForwards()
    for (let port = 2000; port < 2256; port++) expect(t.forwards.grant('', port)).toBe(true)
    expect(t.forwards.grant('', 3000)).toBe(false)
    expect(t.forwards.grant('', 2000)).toBe(true)
    t.forwards.close()
    t.forwards.open(1, { sessionId: '', host: 'localhost', port: 2000 })
    expect(t.connected).toEqual([])
  })
})

describe('ClientForwards listeners', () => {
  const servers: net.Server[] = []
  const clients: ClientForwards[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.closeAll()
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  })

  const client = () => {
    const forwards = new ClientForwards({
      send: () => true,
      sendBytes: () => Promise.resolve(),
      nextStream: () => 1,
      log: () => {},
    })
    clients.push(forwards)
    return forwards
  }

  const freePort = async (): Promise<number> => {
    const server = net.createServer()
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as net.AddressInfo
    await new Promise((done) => server.close(done))
    return port
  }

  it('listens at the host’s own port when it is free, and at another when it is not', async () => {
    const forwards = client()
    const port = await freePort()
    expect(await forwards.listen('', { host: 'localhost', port }, true)).toBe(port)
    const taken = net.createServer()
    servers.push(taken)
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done))
    const busy = (taken.address() as net.AddressInfo).port
    const other = await forwards.listen('', { host: 'localhost', port: busy }, true)
    expect(other).not.toBeNull()
    expect(other).not.toBe(busy)
  })

  it('stops one listener, which listens again when asked', async () => {
    const forwards = client()
    const port = await freePort()
    expect(await forwards.listen('s1', { host: 'localhost', port }, true)).toBe(port)
    forwards.stopOne('s1', { host: 'localhost', port })
    await new Promise((done) => setTimeout(done, 20))
    expect(await forwards.listen('s1', { host: 'localhost', port }, true)).toBe(port)
  })
})

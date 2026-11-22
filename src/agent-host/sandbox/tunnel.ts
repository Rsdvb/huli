// Huli: the agent host's side of a container's way out through Agent 网络. The container cannot
// reach the agent's listener, which serves 127.0.0.1 only, so the host dials into the egress
// proxy's tunnel port (published on the engine's loopback) and keeps a few connections waiting.
// The proxy names a target on one; the host asks the agent's listener to CONNECT there, answers
// OK or ERR, and joins the two. Every connection says the session's token first, and nothing is
// ever opened anywhere but the agent's listener.

import net from 'node:net'

export interface TunnelOptions {
  /** The tunnel port, on 127.0.0.1, as the engine published it. */
  port: number
  token: string
  /** The port of the agent's listener of Agent 网络, on 127.0.0.1. */
  upstream: number
  /** Connections kept waiting for a request. */
  spare?: number
  log?(message: string): void
}

const TARGET = /^([a-z0-9.-]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i
const RETRY_MS = 1_000
const ANSWER_MS = 15_000

export class EgressTunnel {
  private stopped = false
  private readonly waiting = new Set<net.Socket>()
  private readonly joined = new Set<net.Socket>()

  constructor(private readonly options: TunnelOptions) {
    for (let i = 0; i < (options.spare ?? 4); i++) this.dial()
  }

  stop(): void {
    this.stopped = true
    for (const socket of [...this.waiting, ...this.joined]) socket.destroy()
    this.waiting.clear()
    this.joined.clear()
  }

  private dial(): void {
    if (this.stopped) return
    const socket = net.connect(this.options.port, '127.0.0.1')
    let asked = false
    socket.setNoDelay(true)
    socket.once('connect', () => {
      socket.write(`KITE ${this.options.token}\n`)
      this.waiting.add(socket)
    })
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('latin1')
      const at = text.indexOf('\n')
      if (at < 0) {
        if (text.length > 1024) socket.destroy()
        return
      }
      socket.off('data', onData)
      socket.pause()
      asked = true
      this.waiting.delete(socket)
      // The proxy took this one: another waits in its place.
      this.dial()
      const rest = Buffer.from(text.slice(at + 1), 'latin1')
      void this.serve(socket, text.slice(0, at).trim(), rest)
    }
    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      this.waiting.delete(socket)
      // One that never carried a request went away, as while the proxy starts: dial again.
      if (!asked && !this.stopped) setTimeout(() => this.dial(), RETRY_MS).unref()
    })
  }

  private async serve(socket: net.Socket, target: string, rest: Buffer): Promise<void> {
    if (!TARGET.test(target)) {
      socket.end('ERR target\n')
      return
    }
    const upstream = await this.connect(target)
    if (!upstream) {
      socket.end('ERR refused\n')
      return
    }
    if (this.stopped) {
      upstream.destroy()
      socket.destroy()
      return
    }
    socket.write('OK\n')
    if (rest.length > 0) upstream.write(rest)
    this.joined.add(socket)
    const close = (): void => {
      upstream.destroy()
      socket.destroy()
      this.joined.delete(socket)
    }
    socket.on('close', close)
    upstream.on('close', close)
    upstream.on('error', close)
    socket.pipe(upstream)
    upstream.pipe(socket)
    socket.resume()
  }

  /** A connection through the agent's listener to `target`, or null when it refuses it. */
  private connect(target: string): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      const upstream = net.connect(this.options.upstream, '127.0.0.1')
      const timer = setTimeout(() => finish(null), ANSWER_MS)
      let text = ''
      const finish = (value: net.Socket | null, leftover?: Buffer): void => {
        clearTimeout(timer)
        upstream.off('data', onData)
        if (!value) upstream.destroy()
        else {
          upstream.pause()
          if (leftover && leftover.length > 0) upstream.unshift(leftover)
        }
        resolve(value)
      }
      const onData = (chunk: Buffer): void => {
        text += chunk.toString('latin1')
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) {
          if (text.length > 8192) finish(null)
          return
        }
        const ok = /^HTTP\/1\.[01] 200\b/.test(text)
        finish(ok ? upstream : null, Buffer.from(text.slice(end + 4), 'latin1'))
      }
      upstream.once('connect', () => {
        upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      })
      upstream.on('data', onData)
      upstream.once('error', () => finish(null))
    })
  }
}

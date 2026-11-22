// Huli: driving a program that runs as administrator, through the elevated broker of Kite's
// computer use helper (native/computer-helper/windows/Broker.cs), which the owner starts himself
// at Windows' administrator prompt. The host makes a random pipe name and a token for the
// session; the broker's command line carries only the token's SHA-256, its pipe admits only the
// owner's account and the host's own process, and the token goes over the pipe as the first line.
// The broker then relays Cua Driver's tools for that program's windows alone, in the background.

import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { LogFn } from '../storage'
import type { ElevateRequest } from './helper'
import { DRIVER_CALL_MS } from './driver'

/** The broker ends after this long without a request; the hold's own end comes sooner. */
export const ELEVATED_IDLE_MS = 5 * 60_000
/** How long the host tries to reach a broker that started. */
const CONNECT_MS = 20_000
const HELLO_MS = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** What starting the broker needs. */
export interface ElevatedStart {
  /** The program's process, which the broker serves alone. */
  target: number
  /** Kite's user, by SID, whom alone the pipe admits. */
  user: string
  /** Starts the broker; null when the user said no at the administrator prompt. */
  launch(request: ElevateRequest): Promise<number | null>
  log: LogFn
  /** The process that connects; the host's own. */
  client?: number
  idleMs?: number
  connectMs?: number
}

export function pipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`
}

/** A new session's pipe name, token and the token's SHA-256, which alone goes on the command line. */
export function newSecrets(): { pipe: string; token: string; tokenSha256: string } {
  const token = randomBytes(32).toString('hex')
  return {
    pipe: `kite-computer-${randomBytes(16).toString('hex')}`,
    token,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
  }
}

function loadSdk() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/shared/stdio.js'),
  ]).then(([client, stdio]) => ({ ...client, ...stdio }))
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>

/** Connects to the pipe, trying again while the broker is still creating it. */
export async function connectPipe(path: string, withinMs: number): Promise<net.Socket> {
  const deadline = Date.now() + withinMs
  for (;;) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(path)
        socket.once('connect', () => {
          socket.removeAllListeners('error')
          resolve(socket)
        })
        socket.once('error', reject)
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'EBUSY') || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/**
 * Sends the token as the first line and reads the broker's answer, which is the first line back;
 * what follows it is the MCP stream's.
 */
export function hello(socket: net.Socket, token: string): Promise<{ pid: number; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error: Error | null, value?: { pid: number; rest: Buffer }) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve(value!)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\n')
      if (end < 0) {
        if (buffer.length > 4096) done(new Error('The elevated helper answered too much.'))
        return
      }
      let answer: { ok?: unknown; pid?: unknown; error?: unknown }
      try {
        answer = JSON.parse(buffer.subarray(0, end).toString('utf8')) as typeof answer
      } catch {
        done(new Error('The elevated helper answered something else.'))
        return
      }
      if (answer.ok !== true || typeof answer.pid !== 'number') {
        const why = typeof answer.error === 'string' ? answer.error : 'refused'
        done(new Error(`The elevated helper refused Kite: ${why}.`))
        return
      }
      done(null, { pid: answer.pid, rest: buffer.subarray(end + 1) })
    }
    const onClose = () => done(new Error('The elevated helper closed the connection.'))
    const onError = (error: Error) => done(error)
    const timer = setTimeout(() => done(new Error('The elevated helper did not answer.')), HELLO_MS)
    timer.unref?.()
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.once('error', onError)
    socket.write(`${JSON.stringify({ token })}\n`)
  })
}

/** MCP's newline-delimited JSON-RPC over the broker's pipe. */
class PipeTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer: InstanceType<Sdk['ReadBuffer']>

  constructor(
    private readonly socket: net.Socket,
    private readonly rest: Buffer,
    private readonly sdk: Sdk,
  ) {
    this.buffer = new sdk.ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES })
  }

  start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => this.take(chunk))
    this.socket.on('error', (error) => this.onerror?.(error))
    this.socket.on('close', () => this.onclose?.())
    if (this.rest.length > 0) this.take(this.rest)
    return Promise.resolve()
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(this.sdk.serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  close(): Promise<void> {
    this.socket.destroy()
    return Promise.resolve()
  }

  private take(chunk: Buffer): void {
    try {
      this.buffer.append(chunk)
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
        this.onmessage?.(message)
      }
    } catch (error) {
      this.onerror?.(error as Error)
    }
  }
}

/** The broker, once it proved itself and took the token, as a driver the service calls. */
export class ElevatedDriver {
  private closed = false
  /** Told once when the broker ends, whoever ended it. */
  onClosed: (() => void) | null = null

  private constructor(
    private readonly client: Client,
    readonly brokerPid: number,
    readonly target: number,
  ) {
    client.onclose = () => this.ended()
  }

  /**
   * Starts the broker through `launch`, connects and hands it the token. Null when the user said
   * no at the administrator prompt; throws when the broker could not be reached or refused Kite.
   */
  static async start(options: ElevatedStart): Promise<ElevatedDriver | null> {
    const secrets = newSecrets()
    const launched = await options.launch({
      pipe: secrets.pipe,
      user: options.user,
      client: options.client ?? process.pid,
      target: options.target,
      tokenSha256: secrets.tokenSha256,
      idleMs: options.idleMs ?? ELEVATED_IDLE_MS,
    })
    if (launched === null) return null
    const sdk = await loadSdk()
    const socket = await connectPipe(pipePath(secrets.pipe), options.connectMs ?? CONNECT_MS)
    let pid: number
    let rest: Buffer
    try {
      ;({ pid, rest } = await hello(socket, secrets.token))
    } catch (error) {
      socket.destroy()
      throw error
    }
    const client = new sdk.Client({ name: 'kettu', version: '1' })
    try {
      await client.connect(new PipeTransport(socket, rest, sdk))
    } catch (error) {
      socket.destroy()
      throw error
    }
    options.log('info', `Elevated computer use helper started, process ${pid}`)
    return new ElevatedDriver(client, pid, options.target)
  }

  get running(): boolean {
    return !this.closed
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.closed) throw new Error('The elevated helper has ended.')
    return (await this.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: DRIVER_CALL_MS,
    })) as CallToolResult
  }

  /** Ends the broker: it exits once the pipe closes, and Cua Driver with it. */
  async stop(): Promise<void> {
    if (this.closed) return
    try {
      await this.client.close()
    } catch {
      // Already gone.
    }
    this.ended()
  }

  private ended(): void {
    if (this.closed) return
    this.closed = true
    const told = this.onClosed
    this.onClosed = null
    told?.()
  }
}

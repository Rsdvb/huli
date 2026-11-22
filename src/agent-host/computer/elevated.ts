// Huli: driving a program that runs as administrator, through the elevated broker of Kite's
// computer use helper (native/computer-helper/windows/Broker.cs), which the owner installs once into
// Program Files and confirms each time: at Windows' administrator prompt, then in the broker's own
// window, which names the program. The host makes a random pipe name and a token for the session;
// the broker's command line carries only the token's SHA-256. Kite cannot ask Windows who serves a
// pipe, so the installed helper's connect mode, started here from Program Files, checks the server
// is the broker the prompt started before it hands over the token; the broker in turn checks that
// its client is that connect, started by this host. The broker then relays Cua Driver's tools for
// that program's windows alone, in the background, and confirms risky steps in its own window.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { LogFn } from '../storage'
import type { ComputerHelperLike } from './helper'

/** The broker ends after this long without a request; the hold's own end comes sooner. */
export const ELEVATED_IDLE_MS = 5 * 60_000
/** A call may wait on the owner's answer in the broker's window, which gives up at two minutes. */
export const ELEVATED_CALL_MS = 3 * 60_000
/** The broker answers once the owner answered its start window. */
const ANSWER_MS = 3 * 60_000
const MAX_MESSAGE_BYTES = 96 * 1024 * 1024
const HELPER_FILE = 'kite-computer-helper.exe'

/** What starting the broker needs. */
export interface ElevatedStart {
  /** The program's process, which the broker serves alone. */
  target: number
  /** Kite's user, by SID, whom alone the pipe admits. */
  user: string
  helper: Pick<ComputerHelperLike, 'process' | 'elevate'>
  /** The install folder, whose helper runs the connect end. */
  installDir: string
  /** The language of the broker's own windows. */
  lang: 'zh-CN' | 'en'
  log: LogFn
  /** The host's own process, the connect end's parent. */
  host?: number
  idleMs?: number
  /** A test build's helper, which takes its install folder on the command line. */
  testBuild?: boolean
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
type Connect = ChildProcessByStdio<Writable, Readable, null>

/**
 * Starts the connect end, hands it the token and reads the broker's answer, its first line; what
 * follows that line is the MCP stream's.
 */
export function connect(
  program: string,
  args: string[],
  token: string,
  withinMs = ANSWER_MS,
): Promise<{ child: Connect; pid: number; rest: Buffer }> {
  const child = spawn(program, ['connect', ...args], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error: Error | null, value?: { pid: number; rest: Buffer }) => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) {
        child.kill()
        reject(error)
      } else {
        resolve({ child, ...value! })
      }
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
        done(new Error(`The elevated helper refused: ${why}.`))
        return
      }
      done(null, { pid: answer.pid, rest: buffer.subarray(end + 1) })
    }
    const onExit = () => done(new Error('The elevated helper did not answer.'))
    const onError = (error: Error) => done(error)
    const timer = setTimeout(() => done(new Error('The elevated helper did not answer.')), withinMs)
    timer.unref?.()
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
    child.stdin.on('error', () => {})
    child.stdin.write(`${JSON.stringify({ token })}\n`)
  })
}

/** MCP's newline-delimited JSON-RPC over the connect end's stdio. */
class ConnectTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer: InstanceType<Sdk['ReadBuffer']>

  constructor(
    private readonly child: Connect,
    private readonly rest: Buffer,
    private readonly sdk: Sdk,
  ) {
    this.buffer = new sdk.ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES })
  }

  start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => this.take(chunk))
    this.child.on('error', (error) => this.onerror?.(error))
    this.child.on('exit', () => this.onclose?.())
    if (this.rest.length > 0) this.take(this.rest)
    return Promise.resolve()
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(this.sdk.serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  close(): Promise<void> {
    this.child.stdin.end()
    this.child.kill()
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

/** The broker, once the owner confirmed it and it took the token, as a driver the service calls. */
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
   * Starts the broker through the administrator prompt and connects to it through the installed
   * helper. Null when the user said no at the prompt; throws when the program could not be named,
   * the broker could not be reached or verified, or the owner said no in its window.
   */
  static async start(options: ElevatedStart): Promise<ElevatedDriver | null> {
    const info = await options.helper.process(options.target)
    if (!info.image || !info.started) throw new Error('The program could not be identified.')
    const secrets = newSecrets()
    const host = options.host ?? process.pid
    const launched = await options.helper.elevate({
      pipe: secrets.pipe,
      user: options.user,
      host,
      target: options.target,
      targetImage: info.image,
      targetStarted: info.started,
      tokenSha256: secrets.tokenSha256,
      idleMs: options.idleMs ?? ELEVATED_IDLE_MS,
      lang: options.lang,
    })
    if (launched === null) return null
    const sdk = await loadSdk()
    const args = ['--pipe', secrets.pipe, '--server', String(launched)]
    if (options.testBuild) args.push('--install-dir', options.installDir)
    const { child, pid, rest } = await connect(
      path.join(options.installDir, HELPER_FILE),
      args,
      secrets.token,
    )
    const client = new sdk.Client({ name: 'kettu', version: '1' })
    try {
      await client.connect(new ConnectTransport(child, rest, sdk))
    } catch (error) {
      child.kill()
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
      timeout: ELEVATED_CALL_MS,
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

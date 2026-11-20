// A scripted `doubao` for tests: a child process in this process that records its command line and
// the prompt it reads on stdin, and replays what the real CLI printed (doubao/fixtures, captured
// from Doubao CLI 2.37.2 and scrubbed) or what a test answers.

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { PermissionAnswer, SessionTarget } from '../connection'
import type { HostedSpawn, HostedSpawnOptions } from '../driver'
import {
  newTurnScope,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
} from '../session-updates'

const FIXTURES = path.join(import.meta.dirname, '..', 'doubao', 'fixtures')

/** A fixture's text as the CLI printed it. */
export function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** A stream-json fixture's lines. */
export function fixtureLines(name: string): string[] {
  return fixtureText(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
}

/** What one run prints and how it ends. */
export interface FakeReply {
  /** Lines of stdout, printed one at a time. */
  lines?: string[]
  /** Lines of stderr, printed before stdout. */
  stderr?: string[]
  code?: number
  /** Holds the run before it exits, as a turn that takes a while. */
  hold?: Promise<void>
}

export type FakeResponder = (run: FakeDoubao) => FakeReply | Promise<FakeReply>

export class FakeDoubao extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  /** What it read on stdin, once stdin ended. */
  input = ''
  /** Set once the host stopped it. */
  stopped = false
  private closed = false

  constructor(
    readonly options: HostedSpawnOptions,
    responder: FakeResponder,
  ) {
    super()
    const chunks: Buffer[] = []
    this.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    this.stdin.on('end', () => {
      this.input = Buffer.concat(chunks).toString('utf8')
      void this.play(responder)
    })
    options.signal?.addEventListener('abort', () => {
      this.stopped = true
      this.close(null, 'SIGTERM')
    })
  }

  /** Its arguments after the command. */
  get args(): string[] {
    return this.options.args
  }

  private async play(responder: FakeResponder): Promise<void> {
    const reply = await responder(this)
    for (const line of reply.stderr ?? []) this.stderr.write(`${line}\n`)
    for (const line of reply.lines ?? []) {
      if (this.closed) return
      this.stdout.write(`${line}\n`)
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (reply.hold) await reply.hold
    this.close(reply.code ?? 0, null)
  }

  private close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => {
      this.emit('exit', code, signal)
      this.emit('close', code, signal)
    })
  }

  kill(): boolean {
    this.stopped = true
    this.close(null, 'SIGTERM')
    return true
  }
}

/** A spawn that runs a FakeDoubao for each process, and every one it ran. */
export function fakeDoubaoSpawn(responder: FakeResponder): {
  spawn: HostedSpawn
  runs: FakeDoubao[]
} {
  const runs: FakeDoubao[] = []
  const spawn: HostedSpawn = (options) => {
    const run = new FakeDoubao(options, responder)
    runs.push(run)
    return run as unknown as ChildProcess
  }
  return { spawn, runs }
}

/** A session's thread that takes a mapper's output as a session does. */
export class DoubaoThread implements SessionTarget {
  state: ThreadState
  readonly effects: MapperEffect[] = []
  readonly scope = newTurnScope()
  replaying = false
  now = 1_000
  private ids = 0

  constructor(cwd: string, id = 's') {
    this.state = threadFromSnapshot({
      session: {
        id,
        agentId: 'doubao',
        projectPath: cwd,
        acpSessionId: id,
        status: 'running',
        title: null,
        config: [],
        commands: [],
        usage: null,
        error: null,
        turnStartedAt: null,
        turnStartUsed: null,
        createdAt: 0,
        updatedAt: 0,
        parentId: null,
        origin: 'user',
        subagent: null,
        routine: null,
        queue: [],
        queuePaused: false,
      },
      entries: [],
      seq: 0,
    })
  }

  get entries(): ThreadEntry[] {
    return threadEntries(this.state)
  }

  context(): MapperContext {
    return {
      thread: this.state,
      replaying: this.replaying,
      cancelling: false,
      scope: this.scope,
      now: this.now++,
      nextId: () => `e:${++this.ids}`,
      sessionIdFor: () => null,
    }
  }

  apply(output: MapperOutput): void {
    this.state = applyPatches(this.state, output.patches)
    this.effects.push(...output.effects)
  }

  requestPermission(): Promise<PermissionAnswer> {
    return Promise.resolve('cancelled')
  }

  send(): void {}

  startMode(): string | null {
    return null
  }
}

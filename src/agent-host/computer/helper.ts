// Huli: Kite's own computer use helper (native/computer-helper), started when a computer use
// session first needs it and ended with the session: which processes run elevated (Windows), the
// system's text recognition (Windows and macOS), and the administrator prompts that install the
// elevated helper and start its broker (Windows). One JSON object per line each way, each answer
// naming its request.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { LogFn } from '../storage'

/** A request the helper does not answer in this time fails; the administrator prompt waits longer. */
const CALL_MS = 30_000
const PROMPT_MS = 11 * 60_000
/** An idle helper ends after this, though the service ends it with the session first. */
export const HELPER_IDLE_MS = 3 * 60_000
const MAX_ANSWER_BYTES = 8 * 1024 * 1024

/** How a process runs against the helper's own token: its integrity level and elevation. */
export interface ProcessLevel {
  integrity: number | null
  elevated: boolean | null
}

export interface ElevationReport {
  /** The helper's own integrity level, which is Kite's. */
  self: number | null
  pids: Record<string, ProcessLevel>
}

/** A line of text the system's recognition found, in the screenshot's own pixels. */
export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface OcrReport {
  languages: string[]
  width: number
  height: number
  lines: OcrLine[]
}

/** A process's image path and start time (a FILETIME, as text), which the broker checks. */
export interface ProcessInfo {
  image: string | null
  started: string | null
}

/**
 * The elevated helper's install folder (the system's Program Files) and how it stands: missing;
 * current (its files the ones the record its elevated command wrote names, only administrators able
 * to change them, of this helper's protocol and for this Kite program); outdated (another protocol
 * or Kite program, or not the install just asked for); or tampered (other files, or looser rights).
 */
export interface InstallState {
  installDir: string
  state: 'missing' | 'current' | 'outdated' | 'tampered'
  exitCode?: number
}

export interface ElevateRequest {
  pipe: string
  user: string
  /** The agent host's process, whose child the broker's client must be. */
  host: number
  target: number
  targetImage: string
  targetStarted: string
  tokenSha256: string
  idleMs: number
  lang: 'zh-CN' | 'en'
}

/** What the service needs of the helper; a stand-in in tests. */
export interface ComputerHelperLike {
  whoami(): Promise<{ sid: string | null; pid: number; integrity: number | null }>
  elevation(pids: number[]): Promise<ElevationReport>
  ocr(image: string): Promise<OcrReport>
  process(pid: number): Promise<ProcessInfo>
  layout(client: string): Promise<InstallState>
  /** Null when the user said no at the administrator prompt. */
  install(client: string): Promise<InstallState | null>
  uninstall(): Promise<InstallState | null>
  /**
   * The process id of the launcher the prompt started, the broker's parent, or null when the user
   * said no at the administrator prompt.
   */
  elevate(request: ElevateRequest): Promise<number | null>
  stop(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ComputerHelperDeps {
  path: string
  log: LogFn
  idleMs?: number
  /** A test build's install folder in place of Program Files. */
  installDir?: string
}

export class ComputerHelper implements ComputerHelperLike {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private idle: ReturnType<typeof setTimeout> | null = null
  /** The program is not there, as in a checkout that never fetched it: no start is tried again. */
  private missing = false

  constructor(private readonly deps: ComputerHelperDeps) {}

  whoami(): Promise<{ sid: string | null; pid: number; integrity: number | null }> {
    return this.request('whoami', {}, CALL_MS)
  }

  elevation(pids: number[]): Promise<ElevationReport> {
    return this.request('elevation', { pids }, CALL_MS)
  }

  ocr(image: string): Promise<OcrReport> {
    return this.request('ocr', { image }, CALL_MS)
  }

  process(pid: number): Promise<ProcessInfo> {
    return this.request('process', { pid }, CALL_MS)
  }

  layout(client: string): Promise<InstallState> {
    return this.request('layout', { client, ...this.installDir() }, CALL_MS)
  }

  async install(client: string): Promise<InstallState | null> {
    const answer = await this.request<InstallState & { cancelled?: boolean }>(
      'install',
      { client, ...this.installDir() },
      PROMPT_MS,
    )
    return answer.cancelled ? null : answer
  }

  async uninstall(): Promise<InstallState | null> {
    const answer = await this.request<InstallState & { cancelled?: boolean }>(
      'uninstall',
      { ...this.installDir() },
      PROMPT_MS,
    )
    return answer.cancelled ? null : answer
  }

  /** The install folder a test build was given; Program Files otherwise. */
  private installDir(): { installDir?: string } {
    return this.deps.installDir ? { installDir: this.deps.installDir } : {}
  }

  async elevate(request: ElevateRequest): Promise<number | null> {
    const answer = await this.request<{ pid?: number | null; cancelled?: boolean }>(
      'elevate',
      { ...request, ...this.installDir() },
      PROMPT_MS,
    )
    if (answer.cancelled) return null
    if (typeof answer.pid !== 'number') throw new Error('The elevated helper did not start.')
    return answer.pid
  }

  /** Ends the helper, and with it any request in flight. */
  stop(): void {
    this.clearIdle()
    const child = this.child
    this.child = null
    this.buffer = ''
    this.failAll(new Error('The computer use helper stopped.'))
    child?.stdin.end()
    child?.kill()
  }

  private request<T>(op: string, fields: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.missing)
      return Promise.reject(new Error('Kite’s computer use helper is not installed.'))
    const child = this.start()
    this.clearIdle()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The computer use helper did not answer ${op} in time.`))
        this.armIdle()
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`)
    })
  }

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    if (this.child) return this.child
    const child = spawn(this.deps.path, ['serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.read(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') this.missing = true
      this.deps.log('warn', `Computer use helper failed: ${error.message}`)
      if (this.child === child) this.stop()
    })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.failAll(new Error('The computer use helper exited.'))
    })
    this.deps.log('info', `Computer use helper started, process ${child.pid ?? 'unknown'}`)
    return child
  }

  private read(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_ANSWER_BYTES && !this.buffer.includes('\n')) {
      this.deps.log('warn', 'Computer use helper sent an answer too long; it was ended.')
      this.stop()
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.answer(line)
    }
  }

  private answer(line: string): void {
    let message: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!pending) return
    this.pending.delete(message.id as number)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'failed'))
    this.armIdle()
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private armIdle(): void {
    if (this.pending.size > 0 || !this.child) return
    this.clearIdle()
    this.idle = setTimeout(() => this.stop(), this.deps.idleMs ?? HELPER_IDLE_MS)
    this.idle.unref?.()
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }
}

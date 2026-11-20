// One Doubao CLI run at a time for the account. Every `doubao` process talks to one shared service
// of the account, which the first of them starts as its child and which serves the others too.
// Ending that process's tree, as Stop does and as the host does to whatever an exited process
// leaves behind, takes the service with it, and every other run stops with "运行时与共享服务断开连接"
// (seen with 2.37.2). So turns and sign-ins run one at a time, and a read such as a listing runs
// alone, or beside a turn once that turn's process is at work and so has the service; a read cut
// off when that turn ends is tried again by its caller.

export type GateUse = 'turn' | 'read'

interface Waiter {
  use: GateUse
  start(): void
  /** Called with how many turns run or wait before this one, as that changes. */
  ahead?(count: number): void
  told: number
}

export interface GateEntry {
  /** Tells the waiter its place among the turns while it waits. */
  ahead?(count: number): void
  signal?: AbortSignal
}

export class DoubaoGate {
  private turn = false
  /** The running turn's process answered, so it has the account's service. */
  private working = false
  private reads = 0
  private readonly waiting: Waiter[] = []

  /** Whether a turn or sign-in runs now. */
  get busy(): boolean {
    return this.turn
  }

  /** The running turn's process printed its first line: reads may run beside it. */
  atWork(): void {
    if (!this.turn || this.working) return
    this.working = true
    this.pump()
  }

  /** Waits for the gate to let `use` run, and resolves with what lets it go again. */
  enter(use: GateUse, entry: GateEntry = {}): Promise<() => void> {
    const { signal } = entry
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        if (use === 'turn') {
          this.turn = false
          this.working = false
        } else this.reads--
        this.pump()
      }
      const waiter: Waiter = {
        use,
        told: -1,
        start: () => {
          signal?.removeEventListener('abort', abort)
          if (use === 'turn') this.turn = true
          else this.reads++
          resolve(release)
        },
        ...(entry.ahead ? { ahead: entry.ahead } : {}),
      }
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        reject(signal?.reason)
        this.pump()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiting.push(waiter)
      this.pump()
    })
  }

  /**
   * Starts what may start, in order: a turn once nothing runs; a read once no other read runs,
   * beside a turn at work, or when nothing runs and no turn waits before it.
   */
  private pump(): void {
    let turnWaits = false
    for (let i = 0; i < this.waiting.length;) {
      const waiter = this.waiting[i]!
      const free =
        waiter.use === 'turn'
          ? !this.turn && this.reads === 0 && !turnWaits
          : this.reads === 0 && (this.turn ? this.working : !turnWaits)
      if (free) {
        this.waiting.splice(i, 1)
        waiter.start()
        continue
      }
      if (waiter.use === 'turn') turnWaits = true
      i++
    }
    let ahead = this.turn ? 1 : 0
    for (const waiter of this.waiting) {
      if (waiter.use !== 'turn') continue
      if (waiter.told !== ahead) {
        waiter.told = ahead
        waiter.ahead?.(ahead)
      }
      ahead++
    }
  }
}

/** The account's gate: Doubao CLI keeps one sign-in for the computer's user. */
export const DOUBAO_GATE = new DoubaoGate()

// Huli: flags a running turn that has produced nothing for a while, so the user hears of a turn
// that may be stuck instead of finding it hours later. Any update the agent sends counts as
// output, a tool's progress too; the notices Kite writes itself, such as a retry's, do not, so a
// request retried over and over still counts as silence. A turn that waits for the user's answer
// is never flagged, and its silence counts from when the wait ended. A flag clears by itself once
// output comes again; Keep waiting clears it and counts the silence from then.

import type { Stall } from '@shared/supervisor'
import type { ThreadState } from '@shared/thread'
import type { MapperOutput } from './session-updates'

/** What the watch reads of a session when its time comes. */
export interface StallState {
  /** A turn runs. */
  running: boolean
  /** The turn, or a subagent of it, waits for the user's answer. */
  waiting: boolean
  /** Its latest update is a retry that has not gone through yet. */
  retrying: boolean
}

export interface StallWatchDeps {
  now(): number
  /** The silence after which a turn is flagged, in ms; 0 for never. */
  thresholdMs(): number
  /** The session as it is now; null for one that is gone. */
  state(sessionId: string): StallState | null
  /** The session's flag changed: set once per stall, null once it clears. */
  changed(sessionId: string, stall: Stall | null): void
}

interface Watched {
  quietSince: number
  timer: ReturnType<typeof setTimeout> | null
  stall: Stall | null
}

/** The id prefix of the notices Kite's mappers write while a request is retried. */
const RETRY_NOTICE = 'n:retry:'

export class StallWatch {
  private readonly sessions = new Map<string, Watched>()

  constructor(private readonly deps: StallWatchDeps) {}

  /** A turn started: its silence counts from now. */
  turnStarted(sessionId: string): void {
    this.quiet(sessionId)
  }

  /** The agent sent something for the session's turn: a flag clears, and silence counts anew. */
  output(sessionId: string): void {
    const watched = this.sessions.get(sessionId)
    if (!watched) return
    // Most updates come in bursts; the timer moves only once a stretch of it has passed.
    const now = this.deps.now()
    if (!watched.stall && watched.timer && now - watched.quietSince < 1000) return
    this.quiet(sessionId)
  }

  /** A wait for the user started or ended: no flag while it waits, and silence counts after it. */
  waitChanged(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.quiet(sessionId)
  }

  /** Keep waiting: the flag clears and the silence counts from now. */
  snooze(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.quiet(sessionId)
  }

  /** The turn ended, or the session went: nothing is watched until the next turn. */
  turnEnded(sessionId: string): void {
    const watched = this.sessions.get(sessionId)
    if (!watched) return
    if (watched.timer) clearTimeout(watched.timer)
    this.sessions.delete(sessionId)
    if (watched.stall) this.deps.changed(sessionId, null)
  }

  /** The threshold changed: every running turn is timed by the new one. */
  settingsChanged(): void {
    for (const [sessionId, watched] of this.sessions) this.arm(sessionId, watched)
  }

  /** The session's flag, while it has one. */
  stallOf(sessionId: string): Stall | null {
    return this.sessions.get(sessionId)?.stall ?? null
  }

  stop(): void {
    for (const watched of this.sessions.values()) if (watched.timer) clearTimeout(watched.timer)
    this.sessions.clear()
  }

  private quiet(sessionId: string): void {
    const watched = this.sessions.get(sessionId) ?? { quietSince: 0, timer: null, stall: null }
    this.sessions.set(sessionId, watched)
    watched.quietSince = this.deps.now()
    if (watched.stall) {
      watched.stall = null
      this.deps.changed(sessionId, null)
    }
    this.arm(sessionId, watched)
  }

  private arm(sessionId: string, watched: Watched): void {
    if (watched.timer) clearTimeout(watched.timer)
    watched.timer = null
    const threshold = this.deps.thresholdMs()
    if (threshold <= 0) {
      if (watched.stall) {
        watched.stall = null
        this.deps.changed(sessionId, null)
      }
      return
    }
    if (watched.stall) return
    const delay = Math.max(0, watched.quietSince + threshold - this.deps.now())
    watched.timer = setTimeout(() => {
      watched.timer = null
      this.due(sessionId, watched)
    }, delay)
    watched.timer.unref?.()
  }

  private due(sessionId: string, watched: Watched): void {
    if (this.sessions.get(sessionId) !== watched) return
    const state = this.deps.state(sessionId)
    if (!state?.running) {
      this.turnEnded(sessionId)
      return
    }
    if (state.waiting) {
      // Its end restarts the count; until then the turn is looked at again a threshold later.
      watched.quietSince = this.deps.now()
      this.arm(sessionId, watched)
      return
    }
    watched.stall = { since: watched.quietSince, reason: state.retrying ? 'retrying' : 'silent' }
    this.deps.changed(sessionId, watched.stall)
  }
}

/**
 * Whether a mapper output is the agent's own: anything but notices Kite wrote, which say what
 * happened to a request rather than what the agent did. An empty output still is, as a tool's
 * progress that changes nothing shown.
 */
export function agentOutput(output: MapperOutput, thread: Pick<ThreadState, 'byId'>): boolean {
  if (output.patches.length === 0) return true
  return !output.patches.every(
    (patch) =>
      (patch.op === 'entry.add' && patch.entry.kind === 'notice') ||
      (patch.op === 'entry.update' && thread.byId[patch.id]?.kind === 'notice'),
  )
}

/** Whether the turn's latest entry is a retry still under way, as the mappers' notices say. */
export function retrying(thread: Pick<ThreadState, 'order' | 'byId'>): boolean {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (!entry || entry.kind === 'git') continue
    return (
      entry.kind === 'notice' && entry.id.startsWith(RETRY_NOTICE) && entry.severity === 'warning'
    )
  }
  return false
}

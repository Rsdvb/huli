// Huli: snoozing and settling sessions (会话整理). The rules are pure functions over a session's
// stored state and a few facts about it; `SessionTidy` keeps one timer for the next moment any of
// them changes a session: a snooze ending or a session settling by itself. Nothing runs between
// those moments, and a request or a failure in a snoozed or settled session brings it back at once.

import {
  DEFAULT_TIDY,
  MAX_SNOOZE_MS,
  MERGED_QUIET_MS,
  TIDY_DAY_MS,
  type SessionSettled,
  type SessionSnooze,
  type SettledBy,
  type TidySettings,
} from '@shared/session-tidy'

/** A session's tidy state as its record keeps it; absent when it has none. */
export interface StoredTidy {
  /** Out of the active list until `until`; `reset` names the agent's plan reset as the time. */
  snooze?: { until: number; reset?: true }
  settled?: SessionSettled
  /** The user's 永不收起: no rule settles it. */
  never?: true
  /** The user brought it back from settled: no rule settles it again until their next message. */
  keptAt?: number
  /** The pull request whose merge settled it, which never settles it again. */
  merged?: string
}

/** What the rules read of a session, cheaply, each time it changes. */
export interface TidyFacts {
  /** The user's own top-level session in the list: not archived, not prepared. */
  listed: boolean
  pinned: boolean
  /** A turn runs or waits on the user, it waits for its plan, or automation runs for it. */
  busy: boolean
  /** Its latest activity. */
  updatedAt: number
  /** Its pull request that merged, by URL; null for none. */
  merged: string | null
}

/** How long a session found at work when it was due to settle waits before it is looked at again. */
export const BUSY_RECHECK_MS = 60 * 60_000

/** The longest a timer is set for; a later moment is reached by setting it again. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** When a session settles by itself, and by which rule; null while no rule would settle it. */
export function settleAt(
  tidy: StoredTidy | undefined,
  facts: TidyFacts,
  settings: TidySettings,
): { at: number; by: Exclude<SettledBy, 'user'> } | null {
  if (!settings.autoSettle || !facts.listed || facts.pinned || facts.busy) return null
  if (tidy?.never || tidy?.keptAt !== undefined || tidy?.snooze || tidy?.settled) return null
  const idle = facts.updatedAt + settings.idleDays * TIDY_DAY_MS
  const merged =
    settings.merged && facts.merged !== null && facts.merged !== tidy?.merged
      ? facts.updatedAt + MERGED_QUIET_MS
      : null
  return merged !== null && merged <= idle ? { at: merged, by: 'merged' } : { at: idle, by: 'idle' }
}

/**
 * The session's tidy state at `now`: a snooze whose time came ends, and a session a rule settles
 * is settled, unless `working` finds it at work, which looks again later. `due` is the next
 * moment the state would change by time alone; null for none.
 */
export function tidyStep(
  tidy: StoredTidy | undefined,
  facts: TidyFacts,
  settings: TidySettings,
  now: number,
  working: () => boolean = () => false,
): { tidy: StoredTidy | undefined; due: number | null } {
  const next: StoredTidy = { ...tidy }
  if (next.snooze && next.snooze.until <= now) delete next.snooze
  let due = next.snooze?.until ?? null
  const settle = settleAt(next, facts, settings)
  if (settle) {
    if (settle.at > now) due = due === null ? settle.at : Math.min(due, settle.at)
    else if (working()) due = now + BUSY_RECHECK_MS
    else {
      next.settled = { at: now, by: settle.by }
      if (settle.by === 'merged' && facts.merged !== null) next.merged = facts.merged
    }
  }
  return { tidy: tidyOrNone(next), due }
}

/** The state, or undefined when it holds nothing, so a record keeps no empty field. */
export function tidyOrNone(tidy: StoredTidy): StoredTidy | undefined {
  return Object.keys(tidy).length === 0 ? undefined : tidy
}

/** The state with the snooze set, or ended for null; a snooze takes a session out of settled. */
export function withSnooze(
  tidy: StoredTidy | undefined,
  until: number | null,
  reset: boolean,
): StoredTidy | undefined {
  const next: StoredTidy = { ...tidy }
  if (until === null) delete next.snooze
  else {
    next.snooze = reset ? { until, reset: true } : { until }
    delete next.settled
  }
  return tidyOrNone(next)
}

/**
 * The state settled by the user, or brought back, which keeps the rules off it until the user's
 * next message.
 */
export function withSettled(
  tidy: StoredTidy | undefined,
  settled: boolean,
  now: number,
): StoredTidy | undefined {
  const next: StoredTidy = { ...tidy }
  if (settled) {
    next.settled = { at: now, by: 'user' }
    delete next.snooze
    delete next.keptAt
  } else if (next.settled) {
    delete next.settled
    next.keptAt = now
  }
  return tidyOrNone(next)
}

/** The state with 永不收起 set or cleared; setting it brings back a session a rule settled. */
export function withNever(tidy: StoredTidy | undefined, never: boolean): StoredTidy | undefined {
  const next: StoredTidy = { ...tidy }
  if (never) {
    next.never = true
    if (next.settled && next.settled.by !== 'user') delete next.settled
  } else delete next.never
  return tidyOrNone(next)
}

/**
 * The state after the user wrote to the session, or it needed them: back in the active list, and
 * on `message` under the rules again.
 */
export function withActivity(
  tidy: StoredTidy | undefined,
  message: boolean,
): StoredTidy | undefined {
  if (!tidy) return undefined
  const next: StoredTidy = { ...tidy }
  delete next.snooze
  delete next.settled
  if (message) delete next.keptAt
  return tidyOrNone(next)
}

/** Whether a snooze's time can be taken: after now, and within `MAX_SNOOZE_MS`. */
export function snoozeInRange(until: number, now: number): boolean {
  return until > now && until <= now + MAX_SNOOZE_MS
}

/**
 * The summary's part of it: the snooze and settle the lists show, and 永不收起, each only when
 * set, so a session with none reads as from before.
 */
export function tidySummary(tidy: StoredTidy | undefined): {
  snooze?: SessionSnooze
  settled?: SessionSettled
  neverSettle?: true
} {
  return {
    ...(tidy?.snooze
      ? { snooze: { until: tidy.snooze.until, reset: tidy.snooze.reset === true } }
      : {}),
    ...(tidy?.settled ? { settled: { ...tidy.settled } } : {}),
    ...(tidy?.never ? { neverSettle: true as const } : {}),
  }
}

function sameTidy(a: StoredTidy | undefined, b: StoredTidy | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** What the timer needs of the session manager. */
export interface TidyRecord {
  id: string
  parentId: string | null
  origin: string
  tidy?: StoredTidy
}

export interface TidyPort<R extends TidyRecord> {
  now(): number
  /** Settings > Features has it on. */
  on(): boolean
  settings(): TidySettings | undefined
  records(): Iterable<R>
  facts(record: R): TidyFacts
  /** Background work goes on in it, as its agent said; read only when it is due to settle. */
  working(record: R): boolean
  /** Saves the index, without sending the summary. */
  save(record: R): void
  /** Sends the session's summary. */
  touch(sessionId: string): void
}

/**
 * The tidy state of the sessions over time: each change of a session looks at its own state at
 * once, and one timer, set for the soonest moment any of them is due, looks at them all then.
 */
export class SessionTidy<R extends TidyRecord> {
  private timer: { at: number; handle: ReturnType<typeof setTimeout> } | null = null
  private stopped = false

  constructor(private readonly port: TidyPort<R>) {}

  /** A parent older than the rules sends none, and then none settles a session. */
  private settings(): TidySettings {
    return this.port.settings() ?? { ...DEFAULT_TIDY, autoSettle: false }
  }

  /** Looks at every session once the host has settled after its start. */
  start(delayMs: number): void {
    this.arm(this.port.now() + delayMs)
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  /** The session changed: its own state at once, and the timer earlier when it falls due sooner. */
  check(record: R): void {
    if (this.stopped || !own(record) || !this.port.on()) return
    const { tidy, due } = tidyStep(
      record.tidy,
      this.port.facts(record),
      this.settings(),
      this.port.now(),
      () => this.port.working(record),
    )
    if (!sameTidy(tidy, record.tidy)) {
      this.set(record, tidy)
      this.port.save(record)
    }
    this.arm(due)
  }

  /** Every session, then the timer for the soonest one due. */
  sweep(): void {
    this.clear()
    if (this.stopped || !this.port.on()) return
    const settings = this.settings()
    const now = this.port.now()
    const changed: R[] = []
    let next: number | null = null
    for (const record of this.port.records()) {
      if (!own(record)) continue
      const { tidy, due } = tidyStep(record.tidy, this.port.facts(record), settings, now, () =>
        this.port.working(record),
      )
      if (!sameTidy(tidy, record.tidy)) {
        this.set(record, tidy)
        changed.push(record)
      }
      if (due !== null) next = next === null ? due : Math.min(next, due)
    }
    for (const record of changed) {
      this.port.save(record)
      this.port.touch(record.id)
    }
    this.arm(next)
  }

  /** The settings or the feature's switch changed: every session is looked at again. */
  changed(): void {
    this.sweep()
  }

  /**
   * Sets the session's state as the user chose, then sends its summary, which looks at it again;
   * false when nothing changed.
   */
  apply(record: R, change: (tidy: StoredTidy | undefined) => StoredTidy | undefined): boolean {
    const tidy = change(record.tidy)
    if (sameTidy(tidy, record.tidy)) return false
    this.set(record, tidy)
    this.port.save(record)
    this.port.touch(record.id)
    return true
  }

  private set(record: R, tidy: StoredTidy | undefined): void {
    if (tidy) record.tidy = tidy
    else delete record.tidy
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer.handle)
    this.timer = null
  }

  private arm(due: number | null): void {
    if (due === null || this.stopped) return
    if (this.timer && this.timer.at <= due) return
    this.clear()
    const wait = Math.min(Math.max(0, due - this.port.now()), MAX_TIMER_MS)
    const handle = setTimeout(() => this.sweep(), wait)
    // A due snooze or settle is no reason to keep a host process alive.
    ;(handle as { unref?: () => void }).unref?.()
    this.timer = { at: due, handle }
  }
}

/** The user's own top-level session, the only kind snoozed or settled. */
function own(record: TidyRecord): boolean {
  return record.parentId === null && record.origin === 'user'
}

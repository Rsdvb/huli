// Huli: the recycle bin (回收站) on the agent host. Each kind's store marks what it deletes and
// keeps it out of its lists; this gathers them for the page, restores and purges them by key, and
// deletes for good what has stayed longer than the settings keep it: once the host has settled
// after its start, then on one timer set for the next moment anything is due. Nothing polls.
// Huli's own; see tools/huli/README.md (Recycle bin).

import {
  BIN_DAY_MS,
  binKey,
  parseBinKey,
  purgeAt,
  type BinItem,
  type BinKind,
  type BinList,
  type BinProjectChoice,
  type BinRestoreResult,
  type RecycleBinSettings,
} from '@shared/recycle-bin'
import { HostError } from './errors'
import type { LogFn } from './storage'

/** An item as a kind lists it: what the page shows but when it is purged, which the bin adds. */
export type SourceItem = Omit<BinItem, 'key' | 'kind' | 'purgeAt' | 'size'> & {
  size?: number | null
}

/** One kind's part of the bin, kept by that kind's own store. */
export interface BinSource {
  readonly kind: BinKind
  /** What it holds now, newest or not; the bin sorts. */
  items(): Promise<SourceItem[]>
  /** The bytes on disk of these items, by id, where known; the page asks only when it opens. */
  sizes?(items: readonly SourceItem[]): Promise<Record<string, number>>
  /** Puts these back; a session whose project is in the bin or gone needs `choice`. */
  restore(ids: readonly string[], choice: BinProjectChoice | undefined): Promise<BinRestoreResult>
  /** Deletes these for good, as a delete did before the bin. */
  purge(ids: readonly string[]): Promise<void>
}

export interface RecycleBinDeps {
  sources: readonly BinSource[]
  settings(): RecycleBinSettings
  /** What the bin holds changed, for the pages showing it. */
  changed(): void
  log: LogFn
  now?: () => number
  /** How long after `start` the first purge waits, so the host's start stays its own. */
  startupMs?: number
  /** After each purge by time: what a kind sweeps beside the items, such as unnamed files. */
  swept?(): Promise<void>
}

/** The longest a timer is set for; a later moment is reached by setting it again. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** A shorter keep takes effect a minute after it is chosen, so a slip of the menu loses nothing. */
const SETTINGS_GRACE_MS = 60_000
/** How long the first purge waits after the host starts. */
const STARTUP_MS = 30_000
/** Changes this close together are told to the pages once. */
const NOTIFY_MS = 100

export class RecycleBin {
  private timer: { at: number; handle: ReturnType<typeof setTimeout> } | null = null
  private notifying: ReturnType<typeof setTimeout> | null = null
  private sweeping: Promise<void> | null = null
  private stopped = false
  private readonly now: () => number
  private readonly byKind: ReadonlyMap<BinKind, BinSource>

  constructor(private readonly deps: RecycleBinDeps) {
    this.now = deps.now ?? Date.now
    this.byKind = new Map(deps.sources.map((source) => [source.kind, source]))
  }

  /** The first purge, once the host has settled after its start. */
  start(): void {
    this.arm(this.now() + (this.deps.startupMs ?? STARTUP_MS))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer.handle)
    this.timer = null
    if (this.notifying) clearTimeout(this.notifying)
    this.notifying = null
  }

  /** Tells the pages once for a burst of changes, as a restore of a project makes. */
  private changed(): void {
    if (this.notifying || this.stopped) return
    this.notifying = setTimeout(() => {
      this.notifying = null
      this.deps.changed()
    }, NOTIFY_MS)
    this.notifying.unref?.()
  }

  /** Everything in the bin, the latest deleted first, with sizes where they are known. */
  async list(): Promise<BinList> {
    const settings = this.deps.settings()
    const groups = await Promise.all(
      this.deps.sources.map(async (source) => {
        const items = await source.items().catch((error: unknown) => {
          this.deps.log('warn', `The recycle bin could not read ${source.kind}: ${message(error)}`)
          return [] as SourceItem[]
        })
        const sizes = source.sizes ? await source.sizes(items).catch(() => ({})) : {}
        return items.map((item): BinItem => ({
          ...item,
          key: binKey(source.kind, item.id),
          kind: source.kind,
          purgeAt: purgeAt(item.deletedAt, settings),
          size: (sizes as Record<string, number>)[item.id] ?? item.size ?? null,
        }))
      }),
    )
    const items = groups.flat().sort((a, b) => b.deletedAt - a.deletedAt)
    return { items, keepDays: settings.keepDays }
  }

  /** Puts the items back where they were; see `BinRestoreResult` for the sessions held back. */
  async restore(keys: readonly string[], choice?: BinProjectChoice): Promise<BinRestoreResult> {
    const result: BinRestoreResult = { restored: [], held: [] }
    for (const [source, ids] of this.byKindOf(keys)) {
      const done = await source.restore(ids, choice)
      result.restored.push(...done.restored)
      result.held.push(...done.held)
    }
    if (result.restored.length > 0) this.changed()
    return result
  }

  /** Deletes the items for good. */
  async purge(keys: readonly string[]): Promise<void> {
    for (const [source, ids] of this.byKindOf(keys)) await this.purgeOf(source, ids)
    this.changed()
  }

  /** Deletes everything in the bin for good. */
  async empty(): Promise<void> {
    for (const source of this.deps.sources) {
      const items = await source.items().catch(() => [] as SourceItem[])
      await this.purgeOf(
        source,
        items.map((item) => item.id),
      )
    }
    this.changed()
  }

  /** Something went into the bin or left it: the timer is set if none is, for the new item. */
  added(): void {
    this.changed()
    const keep = this.keepMs()
    if (keep !== null && !this.timer && !this.stopped) this.arm(this.now() + keep)
  }

  /** The settings' days changed: the next purge is planned again, a minute out at the soonest. */
  settingsChanged(): void {
    if (this.stopped) return
    void this.plan(this.now() + SETTINGS_GRACE_MS).then(() => this.changed())
  }

  private keepMs(): number | null {
    const { keepDays } = this.deps.settings()
    return keepDays === null ? null : keepDays * BIN_DAY_MS
  }

  private byKindOf(keys: readonly string[]): [BinSource, string[]][] {
    const out = new Map<BinSource, string[]>()
    for (const key of keys) {
      const parsed = parseBinKey(key)
      const source = parsed ? this.byKind.get(parsed.kind) : undefined
      if (!parsed || !source)
        throw new HostError('not_found', `Nothing in the recycle bin is ${key}`)
      out.set(source, [...(out.get(source) ?? []), parsed.id])
    }
    return [...out]
  }

  private async purgeOf(source: BinSource, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      await source.purge(ids)
    } catch (error) {
      this.deps.log('warn', `The recycle bin could not purge ${source.kind}: ${message(error)}`)
      throw error
    }
  }

  /** Purges what is due now, then sets the timer for the next item due. */
  private sweep(): Promise<void> {
    this.sweeping ??= this.sweepNow().finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  private async sweepNow(): Promise<void> {
    const keep = this.keepMs()
    if (keep === null) {
      await this.deps.swept?.().catch(() => {})
      return
    }
    const now = this.now()
    let purged = 0
    for (const source of this.deps.sources) {
      const items = await source.items().catch(() => [] as SourceItem[])
      const due = items.filter((item) => item.deletedAt + keep <= now).map((item) => item.id)
      if (due.length === 0) continue
      try {
        await source.purge(due)
        purged += due.length
      } catch (error) {
        this.deps.log('warn', `The recycle bin could not purge ${source.kind}: ${message(error)}`)
      }
    }
    if (purged > 0) {
      this.deps.log('info', `The recycle bin deleted ${purged} item(s) kept past their days`)
      this.changed()
    }
    await this.deps.swept?.().catch(() => {})
    await this.plan(null)
  }

  /** Sets the timer for the earliest item due, not before `soonest`; none while nothing is. */
  private async plan(soonest: number | null): Promise<void> {
    const keep = this.keepMs()
    if (this.timer) clearTimeout(this.timer.handle)
    this.timer = null
    if (keep === null || this.stopped) return
    let earliest: number | null = null
    for (const source of this.deps.sources) {
      const items = await source.items().catch(() => [] as SourceItem[])
      for (const item of items) {
        if (earliest === null || item.deletedAt < earliest) earliest = item.deletedAt
      }
    }
    if (earliest === null) return
    this.arm(Math.max(earliest + keep, soonest ?? 0))
  }

  private arm(at: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer.handle)
    const wait = Math.min(Math.max(0, at - this.now()), MAX_TIMER_MS)
    const handle = setTimeout(() => {
      this.timer = null
      // A moment past the longest timer is reached by looking again, which purges nothing early.
      void this.sweep().catch((error: unknown) => {
        this.deps.log('warn', `The recycle bin's purge failed: ${message(error)}`)
      })
    }, wait)
    handle.unref?.()
    this.timer = { at, handle }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Reads the usage tab's figures from the computer: the chosen range by day together with the last
// year for the heatmap, the hours of the day, and a one-day range's own hours apart, so the rest
// shows while they are read and their failure stays in their section.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostEvent } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { UsageScope, UsageStatus, UsageSummary } from '@shared/usage'
import { withinRefreshLimit } from '../host'
import { errorText } from '../sessions'
import {
  addDays,
  CLOCK_DAYS,
  clockZones,
  dayOf,
  dayStarts,
  FIRST_DAY,
  heatmapRange,
  hourStarts,
  oneDay,
  rangeOf,
  type DayRange,
  type RangeChoice,
} from './model'

export interface UsageRead {
  /** The choice and scope it was read for, to tell a stale read from the one asked. */
  key: string
  choice: RangeChoice
  scope: UsageScope
  today: number
  range: DayRange
  /** The day starts the summary's days count over: the range and the heatmap's year. */
  starts: number[]
  /** The range the summary's clock sums the hours of the day over. */
  clock: DayRange
  summary: UsageSummary
  status: UsageStatus
}

export interface HoursRead {
  key: string
  starts: number[]
  summary: UsageSummary
}

export function choiceKey(choice: RangeChoice, scope: UsageScope): string {
  if (choice.kind === 'custom') return `${scope}:custom:${choice.from}:${choice.to}`
  if (choice.kind === 'all') return `${scope}:all`
  return `${scope}:${choice.kind}:${choice.step}`
}

/** How long a run of usage.changed events gathers before the figures are read again. */
const CHANGED_AFTER = 2000

/** Whether two reads show the same: then the screen keeps the last and its charts. */
function sameRead(a: UsageRead | null, b: UsageRead): boolean {
  return (
    !!a &&
    a.key === b.key &&
    a.scope === b.scope &&
    a.today === b.today &&
    a.range.from === b.range.from &&
    a.range.to === b.range.to &&
    a.clock.from === b.clock.from &&
    a.clock.to === b.clock.to &&
    a.starts.length === b.starts.length &&
    JSON.stringify(a.status) === JSON.stringify(b.status) &&
    JSON.stringify(a.summary) === JSON.stringify(b.summary)
  )
}

/**
 * The figures for `choice`, read while connected. `focused` is whether the screen shows: the year
 * of data is read again on a change only then, else once it shows again.
 */
export function useUsage(
  link: HostLink | null,
  connected: boolean,
  choice: RangeChoice,
  wanted: UsageScope,
  focused = true,
) {
  const [read, setRead] = useState<UsageRead | null>(null)
  const [hours, setHours] = useState<HoursRead | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hoursError, setHoursError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const asked = useRef(0)
  const latest = useRef<UsageRead | null>(null)
  latest.current = read
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  const key = choiceKey(choice, wanted)

  const readHours = useCallback(
    async (range: DayRange, scope: UsageScope, readKey: string, ticket: number) => {
      if (!link) return
      setHoursError(null)
      try {
        const starts = hourStarts(range)
        const summary = (await withinRefreshLimit((signal) =>
          link.request(
            'usage.summary',
            { dayStarts: starts, from: range.from, to: range.to, scope },
            signal,
          ),
        )) as UsageSummary
        if (ticket === asked.current) setHours({ key: readKey, starts, summary })
      } catch (failure) {
        if (ticket === asked.current) setHoursError(errorText(failure))
      }
    },
    [link],
  )

  const load = useCallback(async () => {
    if (!link) return
    const ticket = ++asked.current
    const chosen = choiceRef.current
    setLoading(true)
    try {
      // A read waits for a dropped link to come back; the limit makes it fail, so a pull settles.
      const status = (await withinRefreshLimit((signal) =>
        link.request('usage.status', undefined, signal),
      )) as UsageStatus
      const scope: UsageScope = status.fromComputer ? wanted : 'kettu'
      const today = dayOf(Date.now())
      const heat = heatmapRange(today, FIRST_DAY)
      const before = latest.current
      // All time starts at the first day with usage, known only from an answer.
      let first = before && before.scope === scope ? before.summary.first : null
      for (let pass = 0; pass < 2; pass++) {
        const range = rangeOf(chosen, today, first)
        const starts = dayStarts({
          from: Math.min(range.from, heat.from),
          to: Math.max(range.to, heat.to),
        })
        const clock = oneDay(range) ? { from: addDays(range.to, -CLOCK_DAYS), to: range.to } : range
        const summary = (await withinRefreshLimit((signal) =>
          link.request(
            'usage.summary',
            {
              dayStarts: starts,
              from: range.from,
              to: range.to,
              scope,
              clock: { ...clock, zones: clockZones(clock.from, clock.to) },
            },
            signal,
          ),
        )) as UsageSummary
        if (ticket !== asked.current) return
        if (pass === 0 && rangeOf(chosen, today, summary.first).from !== range.from) {
          first = summary.first
          continue
        }
        const readKey = choiceKey(chosen, wanted)
        const next: UsageRead = {
          key: readKey,
          choice: chosen,
          scope,
          today,
          range,
          starts,
          clock,
          summary,
          status,
        }
        setRead((current) => (sameRead(current, next) ? current : next))
        setError(null)
        if (oneDay(range)) void readHours(range, scope, readKey, ticket)
        else {
          setHours(null)
          setHoursError(null)
        }
        return
      }
    } catch (failure) {
      if (ticket === asked.current) setError(errorText(failure))
    } finally {
      if (ticket === asked.current) setLoading(false)
    }
  }, [link, wanted, readHours])

  // Reads again whenever the choice or scope changes; the key stands for the choice.
  useEffect(() => {
    void key
    if (link && connected) void load()
  }, [key, link, connected, load])

  // A change while the screen is hidden waits for it to show; shown, a run of changes reads once.
  const stale = useRef(false)
  const shown = useRef(focused)
  shown.current = focused
  useEffect(() => {
    if (!link) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = link.onHostEvent((raw: unknown) => {
      const event = raw as HostEvent
      if (event.type === 'usage.changed') {
        if (!shown.current) {
          stale.current = true
          return
        }
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void load()
        }, CHANGED_AFTER)
      }
      if (event.type === 'usage.status') {
        setRead((current) =>
          current && JSON.stringify(current.status) !== JSON.stringify(event.status)
            ? { ...current, status: event.status }
            : current,
        )
      }
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [link, load])
  useEffect(() => {
    if (!focused || !stale.current || !connected) return
    stale.current = false
    void load()
  }, [focused, connected, load])

  /** Asks the computer to read the agents' logs again, then the figures. */
  const sync = useCallback(async () => {
    if (link && latest.current?.status.fromComputer) {
      void link.request('usage.sync', undefined).catch(() => {})
    }
    await load()
  }, [link, load])

  const retryHours = useCallback(() => {
    const current = latest.current
    if (!current || !oneDay(current.range)) return
    void readHours(current.range, current.scope, current.key, asked.current)
  }, [readHours])

  return { read, hours, error, hoursError, loading, key, load, sync, retryHours }
}

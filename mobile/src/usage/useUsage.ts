// Reads the usage tab's figures from the computer: the chosen range by day together with the last
// year for the heatmap, the hours of the day, and a one-day range's own hours apart, so the rest
// shows while they are read and their failure stays in their section.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostEvent } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { UsageScope, UsageStatus, UsageSummary } from '@shared/usage'
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
  return choice.kind === 'custom'
    ? `${scope}:custom:${choice.from}:${choice.to}`
    : `${scope}:${choice.kind}`
}

export function useUsage(
  link: HostLink | null,
  connected: boolean,
  choice: RangeChoice,
  wanted: UsageScope,
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
        const summary = (await link.request('usage.summary', {
          dayStarts: starts,
          from: range.from,
          to: range.to,
          scope,
        })) as UsageSummary
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
      const status = (await link.request('usage.status', undefined)) as UsageStatus
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
        const summary = (await link.request('usage.summary', {
          dayStarts: starts,
          from: range.from,
          to: range.to,
          scope,
          clock: { ...clock, zones: clockZones(clock.from, clock.to) },
        })) as UsageSummary
        if (ticket !== asked.current) return
        if (pass === 0 && rangeOf(chosen, today, summary.first).from !== range.from) {
          first = summary.first
          continue
        }
        const readKey = choiceKey(chosen, wanted)
        setRead({
          key: readKey,
          choice: chosen,
          scope,
          today,
          range,
          starts,
          clock,
          summary,
          status,
        })
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

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw: unknown) => {
      const event = raw as HostEvent
      if (event.type === 'usage.changed') void load()
      if (event.type === 'usage.status') {
        setRead((current) => (current ? { ...current, status: event.status } : current))
      }
    })
  }, [link, load])

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

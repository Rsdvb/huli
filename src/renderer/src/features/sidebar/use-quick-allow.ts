import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'
import { afterAnswers, quickAllowOfEntries, type QuickAllow } from './quick-allow-model'
import { rowWaitingSources } from './waiting'

/** The session a row's first wait is in, as a key that moves whenever what waits there may have. */
function sourceKey(byId: Readonly<Record<string, SessionSummary>>, rootId: string, count: number) {
  const source = rowWaitingSources(byId, rootId, count)[0]
  if (!source) return ''
  const { id, updatedAt, permissionCount } = source.summary
  return `${id}\n${updatedAt}\n${permissionCount}`
}

interface Read {
  key: string
  allow: QuickAllow | null
}

/**
 * What a Needs you row's 允许 would answer: read from the session its first wait is in while
 * `active` (the row under the pointer or the focus), and again whenever that session changes then.
 * Nothing is read for a row nobody points at. A read under way keeps the last one in view: each
 * names its requests by id, so a click on it answers just what it shows, or is told it was answered.
 */
export function useQuickAllow(rootId: string, count: number, active: boolean) {
  const key = useSessionsStore((s) => (active ? sourceKey(s.byId, rootId, count) : ''))
  const [read, setRead] = useState<Read | null>(null)
  // Answered from this row: a read that set out before the answer still lists them.
  const done = useRef(new Set<string>())
  const readKey = read?.key

  useEffect(() => {
    if (!key || readKey === key) return
    const sessionId = key.slice(0, key.indexOf('\n'))
    let live = true
    host('sessions.requests', { sessionId })
      .then(({ entries }) => {
        const found = quickAllowOfEntries(sessionId, entries)
        if (live) setRead({ key, allow: found && afterAnswers(found, done.current) })
      })
      .catch(() => {
        if (live) setRead({ key, allow: null })
      })
    return () => {
      live = false
    }
  }, [key, readKey])

  const answered = useCallback((requestIds: readonly string[]) => {
    for (const id of requestIds) done.current.add(id)
    setRead((before) =>
      before?.allow ? { ...before, allow: afterAnswers(before.allow, done.current) } : before,
    )
  }, [])

  return { allow: read?.allow ?? null, answered }
}

/** Whether the pointer is on the row or the focus inside it, from the row's own events. */
export function useRowActive(row: RefObject<HTMLElement | null>): boolean {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    const element = row.current
    if (!element) return
    // Over rather than enter, so a pointer already on the row when it starts waiting counts at its
    // next move onto one of the row's parts.
    const enter = () => setHover(true)
    const leave = () => setHover(false)
    const focusIn = () => setFocus(true)
    const focusOut = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) setFocus(false)
    }
    element.addEventListener('pointerover', enter)
    element.addEventListener('pointerleave', leave)
    element.addEventListener('focusin', focusIn)
    element.addEventListener('focusout', focusOut)
    return () => {
      element.removeEventListener('pointerover', enter)
      element.removeEventListener('pointerleave', leave)
      element.removeEventListener('focusin', focusIn)
      element.removeEventListener('focusout', focusOut)
    }
  }, [row])
  return hover || focus
}

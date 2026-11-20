// The route the link to the computer takes now, for the settings pages that show it. It can change
// under a kept link, as when the phone leaves the Wi-Fi, so it is read again every few seconds,
// but only while the page shows, and handed on only when it changed: the same route read again no
// longer redraws the whole page.

import { useEffect, useState } from 'react'
import { useIsFocused } from 'expo-router'
import { currentRoute, type CurrentRoute } from '../connection'

const EVERY_MS = 2000

function same(a: CurrentRoute | null, b: CurrentRoute | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'relay' || b.kind === 'relay') return a.kind === b.kind
  return a.address.host === b.address.host && a.address.port === b.address.port
}

/** The current route while `watching`; `again` is anything whose change calls for a read now. */
export function useCurrentRoute(watching: boolean, again?: unknown): CurrentRoute | null {
  const focused = useIsFocused()
  const [route, setRoute] = useState<CurrentRoute | null>(() => currentRoute())
  useEffect(() => {
    if (!watching || !focused) return
    const read = () => {
      const next = currentRoute()
      setRoute((was) => (same(was, next) ? was : next))
    }
    read()
    const timer = setInterval(read, EVERY_MS)
    return () => clearInterval(timer)
  }, [watching, focused, again])
  return route
}

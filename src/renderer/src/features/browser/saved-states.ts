import { useEffect, useState } from 'react'
import type { SavedStateSummary } from '@shared/browser'

/**
 * Huli: the saved sign-in states, read when asked for and kept up to date by main's event while
 * something shows them; null until read.
 */
export function useSavedStates(active: boolean): SavedStateSummary[] | null {
  const [states, setStates] = useState<SavedStateSummary[] | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    window.kettu.browser.savedStates().then(
      (list) => {
        if (!cancelled) setStates(list)
      },
      () => {
        if (!cancelled) setStates([])
      },
    )
    const off = window.kettu.browser.onSavedStates((list) => setStates(list))
    return () => {
      cancelled = true
      off()
    }
  }, [active])
  return states
}

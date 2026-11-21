// Work an event asks for that only a screen in view needs, as reading a list again: done at once
// while the screen shows, else once, when it shows again, however many events came meanwhile.

import { useCallback, useEffect, useRef } from 'react'
import { useIsFocused, useNavigation } from 'expo-router'

/** A function that runs `run` now while the screen shows, or once it shows again. */
export function useWhenShown(run: () => void): () => void {
  const focused = useIsFocused()
  const shown = useRef(focused)
  shown.current = focused
  const latest = useRef(run)
  latest.current = run
  const pending = useRef(false)
  useEffect(() => {
    if (!focused || !pending.current) return
    pending.current = false
    latest.current()
  }, [focused])
  return useCallback(() => {
    if (shown.current) latest.current()
    else pending.current = true
  }, [])
}

/**
 * Runs `run` each time the screen comes into view: when its navigator focuses it, and for a tab
 * also when its tab is pressed, which the native tab bar reports itself.
 */
export function useOnShown(run: () => void): void {
  const navigation = useNavigation()
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    const call = () => latest.current()
    const listen = navigation.addListener.bind(navigation) as unknown as (
      event: 'focus' | 'tabPress',
      callback: () => void,
    ) => () => void
    const offFocus = listen('focus', call)
    const offPress = listen('tabPress', call)
    return () => {
      offFocus()
      offPress()
    }
  }, [navigation])
}

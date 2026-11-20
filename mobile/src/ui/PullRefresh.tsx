// Pull to refresh for a screen's scroll view. The system spinner stands for the user's own pull
// alone: a refresh the app starts by itself (on launch, back in front, on reconnecting) shows in
// the list's sync line (SyncNote) instead. iOS can fire the refresh control with no finger on the
// list, as when the content inset or offset changes under it; such a refresh is turned down, and
// the control ends at once. Under the floating header (ScrollHeader.tsx) iOS already places the
// spinner below the header through the content inset, so only Android, which pads the content
// instead, moves it down: on iOS the offset put it a header lower, over the list's rows.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Platform, RefreshControl } from 'react-native'
import type { CollapsingHeader } from './ScrollHeader'
import { useTokens } from './tokens'

/** The longest a pull waits for a reload that does not say when it ends. */
const SETTLE_LIMIT = 10_000

/**
 * For a reload that says nothing of when it ends: a promise that settles once `watched`, what the
 * reload brings, next changes, or after a limit, so the pull's spinner lasts as long as the read.
 */
export function useNextChange(watched: unknown): () => Promise<void> {
  const waiters = useRef<(() => void)[]>([])
  useEffect(() => {
    const settled = waiters.current
    waiters.current = []
    for (const settle of settled) settle()
  }, [watched])
  useEffect(
    () => () => {
      for (const settle of waiters.current) settle()
    },
    [],
  )
  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(settle, SETTLE_LIMIT)
        function settle() {
          clearTimeout(timer)
          resolve()
        }
        waiters.current.push(settle)
      }),
    [],
  )
}

/**
 * The refresh control for `refreshControl`, spinning while `run` runs; none without `run`. With
 * the screen's header, a refresh iOS fires without the user's finger on the list is ignored.
 */
export function usePullRefresh(
  run: (() => Promise<unknown> | void) | undefined,
  header?: CollapsingHeader,
): ReactElement | undefined {
  const { c } = useTokens()
  const [refreshing, setRefreshing] = useState(false)
  const busy = useRef(false)
  const latest = useRef(run)
  latest.current = run
  if (!run) return undefined
  return (
    <RefreshControl
      refreshing={refreshing}
      tintColor={c.textSecondary}
      {...(Platform.OS === 'android' && header ? { progressViewOffset: header.height } : {})}
      onRefresh={() => {
        if (busy.current) return
        if (Platform.OS === 'ios' && header && !header.touched()) return
        busy.current = true
        setRefreshing(true)
        void Promise.resolve()
          .then(() => latest.current?.())
          .catch(() => {})
          .finally(() => {
            busy.current = false
            setRefreshing(false)
          })
      }}
    />
  )
}

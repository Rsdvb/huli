// A value outside React that components read through selectors: each redraws only when what it
// selected changes, by reference or by the equality it gives. The host's lists and an open
// session's thread are kept this way, as the desktop keeps its Zustand stores.

import { useRef, useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  subscribe(listener: () => void): () => void
}

export interface WritableStore<T> extends Store<T> {
  set(next: T | ((was: T) => T)): void
}

export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (was: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const noSubscribe = () => () => {}

/**
 * Part of `store`: re-renders only when `select`'s answer changes by `equal` (reference by
 * default). A new answer equal to the last keeps the last's reference. While `paused` it keeps
 * its last answer and hears no change, as for a screen covered by another; it catches up after.
 */
export function useSelector<T, S>(
  store: Store<T>,
  select: (value: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
  paused = false,
): S {
  const memo = useRef<{ value: T; select: (value: T) => S; selected: S } | null>(null)
  const read = () => {
    if (paused && memo.current) return memo.current.selected
    const value = store.get()
    const was = memo.current
    if (was && Object.is(was.value, value) && was.select === select) return was.selected
    const next = select(value)
    const selected = was && equal(was.selected, next) ? was.selected : next
    memo.current = { value, select, selected }
    return selected
  }
  return useSyncExternalStore(paused ? noSubscribe : store.subscribe, read, read)
}

/** Arrays equal item by item, by reference. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/** Objects equal field by field, by reference: for a selector that picks several fields. */
export function sameFields<T extends object>(a: T, b: T): boolean {
  for (const key in a) if (a[key] !== b[key]) return false
  for (const key in b) if (!(key in a)) return false
  return true
}

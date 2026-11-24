import { create } from 'zustand'
import { readJson, removeKey, writeJson } from '@renderer/lib/storage'

// The width of the thread's column as the user dragged it, kept on this device in localStorage and
// shared by every session. Null leaves it at the width the text size gives.

const KEY = 'thread-width'

/** The least the column is dragged to, in px. */
export const MIN_WIDTH = 480

function load(): number | null {
  const stored = readJson<unknown>(KEY, null)
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= MIN_WIDTH
    ? Math.round(stored)
    : null
}

export const useThreadWidth = create<{ width: number | null }>(() => ({ width: load() }))

/** Sets the column's width in px, or null to give it the text size's width again. */
export function setThreadWidth(width: number | null): void {
  useThreadWidth.setState({ width })
}

// A dragged width goes straight to the boxes that read --thread-column, as session.css sizes them
// from it. Setting the property instead, on the root or a session's view, restyled every element
// under it on each move of a width grip: the whole page, or the whole thread.
const sheet = new CSSStyleSheet()
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]

function apply(width: number | null): void {
  sheet.replaceSync(
    width === null
      ? ''
      : [
          `.ks-session .ks-thread__column { max-width: ${width + 64}px; }`,
          `.ks-session .max-w-\\(--thread-column\\) { max-width: ${width}px; }`,
          `.ks-session .ks-recap { max-width: min(${width + 16}px, calc(100% - 32px)); }`,
        ].join('\n'),
  )
}

apply(useThreadWidth.getState().width)

let saveTimer: ReturnType<typeof setTimeout> | undefined
useThreadWidth.subscribe(({ width }) => {
  apply(width)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => (width === null ? removeKey(KEY) : writeJson(KEY, width)), 300)
})

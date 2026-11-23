// What `browser_wait_for` looks for in each frame of a page it can reach: text that shows, or
// elements a CSS selector matches, through open shadow roots too.

import type { BrowserWaitState } from '@shared/browser'

/** One frame's answer to SEARCH. */
export type FrameSearch =
  { found: boolean } | { matched: number; visible: number } | { error: string }

/** Whether elements in these states make the wait end. */
export function selectorMet(state: BrowserWaitState, matched: number, visible: number): boolean {
  switch (state) {
    case 'visible':
      return visible > 0
    case 'hidden':
      return visible === 0
    case 'attached':
      return matched > 0
    case 'detached':
      return matched === 0
  }
}

/** Whether a ref's element in these states makes the wait end. */
export function elementMet(state: BrowserWaitState, connected: boolean, visible: boolean): boolean {
  return selectorMet(state, connected ? 1 : 0, connected && visible ? 1 : 0)
}

/**
 * Runs in a frame with `{ text }` or `{ selector }` and answers a FrameSearch: whether the frame's
 * text holds the text, or how many elements the selector matches and how many of them show.
 */
export const SEARCH = `(query) => {
  const roots = [document]
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  }
  if (typeof query.text === 'string') {
    const parts = [document.body ? document.body.innerText : '']
    for (const root of roots.slice(1)) {
      for (const child of root.children) parts.push(child.innerText || child.textContent || '')
    }
    return { found: parts.join('\\n').includes(query.text) }
  }
  const shows = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    if (getComputedStyle(el).visibility === 'hidden') return false
    return typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true })
  }
  let matched = 0
  let visible = 0
  for (const root of roots) {
    let found
    try {
      found = root.querySelectorAll(query.selector)
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
    for (const el of found) {
      matched += 1
      if (shows(el)) visible += 1
    }
  }
  return { matched, visible }
}`

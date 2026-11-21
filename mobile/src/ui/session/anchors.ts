// `#anchor` links in a reply: the headings of the texts mounted now, under the slug GitHub gives
// a heading, and the way a scrolling screen brings one into view.

import { createContext } from 'react'
import type { Inline } from './markdown'

/** What a heading's view gives to be scrolled to. */
export interface AnchorTarget {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void
}

/** Brings a view of the screen's scrolling content into view; null where nothing can. */
export const RevealContext = createContext<((target: AnchorTarget) => void) | null>(null)

/** The words of a heading's runs, marks left out. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.t === 'text' || node.t === 'code'
        ? node.v
        : node.t === 'image'
          ? node.alt
          : inlineText(node.c),
    )
    .join('')
}

// The punctuation GitHub drops from an anchor: ASCII's but `-` and `_`, and the general, CJK and
// full-width marks. Spelled out, as the phone's engine may not take Unicode property escapes.
const PUNCTUATION =
  /[!-,./:-@[-^`{-~\u2000-\u206f\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g

/** GitHub's anchor for a heading: lower case, spaces as dashes, punctuation dropped. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(PUNCTUATION, '').replace(/ /g, '-')
}

/** The anchor a link names, as a heading's slug: `#Setup%20steps` is `setup-steps`. */
export function anchorSlug(href: string): string {
  let fragment = href.slice(1)
  try {
    fragment = decodeURIComponent(fragment)
  } catch {
    // Kept as written.
  }
  return headingSlug(fragment)
}

const headings = new Map<string, Set<AnchorTarget>>()

/** Keeps a mounted heading of the text `scope` names; the function returned drops it. */
export function keepHeading(scope: string, slug: string, target: AnchorTarget): () => void {
  const key = `${scope}\n${slug}`
  let set = headings.get(key)
  if (!set) headings.set(key, (set = new Set()))
  set.add(target)
  return () => {
    set.delete(target)
    if (set.size === 0 && headings.get(key) === set) headings.delete(key)
  }
}

/** The first mounted heading of `scope` with this slug, or null. */
export function findHeading(scope: string, slug: string): AnchorTarget | null {
  const set = headings.get(`${scope}\n${slug}`)
  return set ? (set.values().next().value ?? null) : null
}

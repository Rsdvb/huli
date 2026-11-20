// What the search page looks in and how it matches: scopes, the words of a query, local matching
// of titles and projects, the cache's threads for full text while the computer is away, and the
// recent searches, kept in the Keychain beside the preferences.

import { useSyncExternalStore } from 'react'
import * as SecureStore from 'expo-secure-store'
import { cachedThreadIds, entryText, readThread } from './cache'

export type SearchScope = 'all' | 'sessions' | 'content' | 'projects' | 'artifacts'

export const SCOPES: readonly { key: SearchScope; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'sessions', label: '会话' },
  { key: 'content', label: '对话内容' },
  { key: 'projects', label: '项目' },
  { key: 'artifacts', label: 'Artifacts' },
]

export function isScope(value: unknown): value is SearchScope {
  return SCOPES.some((s) => s.key === value)
}

/** A query's words, lowercased; a match holds every one of them. */
export function wordsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Whether a query is long enough to search what was said: the computer looks only for two
 * characters or more of its words together (shared/search-fold.ts), so a single 字 finds nothing.
 */
export function longEnough(words: readonly string[]): boolean {
  return Array.from(words.join('')).length >= 2
}

export function matches(text: string, words: string[]): boolean {
  if (words.length === 0) return false
  const lower = text.toLowerCase()
  return words.every((w) => lower.includes(w))
}

/** Text cut into runs that match a word and runs that do not, for highlighting. */
export function splitMatches(text: string, words: string[]): { text: string; hit: boolean }[] {
  if (words.length === 0 || !text) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    let at = lower.indexOf(w)
    while (at >= 0) {
      for (let i = at; i < at + w.length; i++) marks[i] = true
      at = lower.indexOf(w, at + w.length)
    }
  }
  const runs: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last.hit === marks[i]) last.text += text[i]
    else runs.push({ text: text[i]!, hit: marks[i]! })
  }
  return runs
}

/** A line of text around its first match, on one line and cut at both ends. */
export function snippetAround(text: string, words: string[], room = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const first = Math.min(
    ...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0),
    Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(first)) return flat.slice(0, room)
  const start = Math.max(0, first - Math.floor(room / 3))
  const end = Math.min(flat.length, start + room)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface LocalHit {
  sessionId: string
  snippet: string
  role: 'user' | 'agent'
}

/**
 * Full text in the threads the phone has cached, for when the computer cannot be asked: at most
 * the latest pages of the last sessions opened, so it says less than the computer would.
 */
export async function searchCachedThreads(
  computer: string,
  words: string[],
): Promise<{ hits: LocalHit[]; searched: number }> {
  const ids = await cachedThreadIds(computer)
  const hits: LocalHit[] = []
  for (const id of ids) {
    const thread = await readThread(computer, id)
    if (!thread) continue
    for (let i = thread.entries.length - 1; i >= 0; i--) {
      const entry = thread.entries[i]!
      const text = entryText(entry)
      if (text && matches(text, words)) {
        hits.push({
          sessionId: id,
          snippet: snippetAround(text, words),
          role: entry.kind === 'user' ? 'user' : 'agent',
        })
        break
      }
    }
  }
  return { hits, searched: ids.length }
}

const RECENT_ITEM = 'huli.search.recent'
const RECENT_KEPT = 12
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

let recent: string[] = []
const listeners = new Set<() => void>()

function publish(next: string[]): void {
  recent = next
  for (const listener of listeners) listener()
  const write =
    next.length > 0
      ? SecureStore.setItemAsync(RECENT_ITEM, JSON.stringify(next), OPTIONS)
      : SecureStore.deleteItemAsync(RECENT_ITEM, OPTIONS)
  void write.catch(() => {})
}

void SecureStore.getItemAsync(RECENT_ITEM, OPTIONS)
  .then((text) => {
    const list = text ? (JSON.parse(text) as unknown) : null
    if (Array.isArray(list)) {
      recent = list.filter((q): q is string => typeof q === 'string').slice(0, RECENT_KEPT)
      for (const listener of listeners) listener()
    }
  })
  .catch(() => {})

export function useRecentSearches(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => recent,
  )
}

export function rememberSearch(query: string): void {
  const text = query.trim()
  if (text.length < 1) return
  publish([text, ...recent.filter((q) => q !== text)].slice(0, RECENT_KEPT))
}

export function forgetSearch(query: string): void {
  publish(recent.filter((q) => q !== query))
}

export function clearSearches(): void {
  publish([])
}

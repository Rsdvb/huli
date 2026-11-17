// Deep links into Huli, for widgets, notifications, the share extension and anything else that
// opens the app. The scheme is `huli` (app.json). The links:
//
//   huli://                       the 会话 tab
//   huli://session/<sessionId>    a session
//   huli://new                    a new session
//   huli://search?q=<text>        search, the text filled in and searched (q may be left out)
//   huli://artifacts              the Artifacts tab
//   huli://artifact/<artifactId>  an artifact, full screen (`version=<n>` for an older one)
//   huli://routines               the 定时任务 tab
//   huli://usage                  the 用量 tab
//
// Any of them may add `host=<id>` (`huli://session/abc?host=1a2b3c4d5e6f`) to show that computer
// first. The id is either the computer's id in the app (SavedHost.id: the first 6 bytes of its key
// in hex, 12 characters) or the id its notifications carry (its relay host id, a push's
// `content.host`). An id no paired computer has is ignored: the link opens on the active one.
// Values are percent-encoded as in any URL query.
//
// A link waits until the app can show it: the paired computers have been read (a cold start), the
// app is unlocked (Face ID), and the computer it names is the active one. Then it navigates.

import { useEffect, useSyncExternalStore } from 'react'
import { router, useRootNavigationState } from 'expo-router'
import { ARTIFACT_ID } from '@shared/artifacts'
import { useHost } from './host'
import { useLockState } from './lock'
import type { SavedHost } from './store'

export type TabName = 'index' | 'artifacts' | 'routines' | 'usage'

export type LinkTarget =
  | { kind: 'session'; id: string }
  | { kind: 'artifact'; id: string; version: number | null }
  | { kind: 'new' }
  | { kind: 'search'; q: string }
  | { kind: 'tab'; tab: TabName }

export interface AppLink {
  /** Where to go; null only switches to the computer, as a notification about none does. */
  target: LinkTarget | null
  /** A computer's id or its notifications' id; null for the active computer. */
  host: string | null
}

const TABS: Record<string, TabName> = {
  '': 'index',
  artifacts: 'artifacts',
  routines: 'routines',
  usage: 'usage',
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

// React Native's URLSearchParams lacks most of its methods, so the query is read by hand.
function query(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of text.split('&')) {
    if (!part) continue
    const at = part.indexOf('=')
    const key = decode(at < 0 ? part : part.slice(0, at))
    if (!out.has(key)) out.set(key, at < 0 ? '' : decode(part.slice(at + 1)))
  }
  return out
}

/** The link a URL or path stands for; null for anything else, which the router keeps for itself. */
export function parseLink(url: string): AppLink | null {
  let rest = url.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(rest)
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== 'huli') return null
    rest = rest.slice(scheme[0].length)
  }
  const hash = rest.indexOf('#')
  if (hash >= 0) rest = rest.slice(0, hash)
  const at = rest.indexOf('?')
  const path = (at >= 0 ? rest.slice(0, at) : rest).replace(/^\/+|\/+$/g, '')
  const params = query(at >= 0 ? rest.slice(at + 1) : '')
  const host = params.get('host')?.trim() || null
  const [head = '', id, ...more] = path.split('/')
  let target: LinkTarget | null = null
  if (head === 'session' && id && more.length === 0) target = { kind: 'session', id: decode(id) }
  else if (head === 'artifact' && id && more.length === 0 && ARTIFACT_ID.test(decode(id))) {
    const version = params.get('version') ?? ''
    target = {
      kind: 'artifact',
      id: decode(id),
      version: /^[1-9][0-9]{0,8}$/.test(version) ? Number(version) : null,
    }
  } else if (path === 'new') target = { kind: 'new' }
  else if (path === 'search') target = { kind: 'search', q: params.get('q') ?? '' }
  else if (path in TABS) target = { kind: 'tab', tab: TABS[path]! }
  return target ? { target, host } : null
}

/** Builds a link, for code in the app that hands one out. */
export function linkTo(target: LinkTarget, host?: string | null): string {
  const suffix = (params: [string, string][]) => {
    const list = params.filter(([, v]) => v !== '')
    if (host) list.push(['host', host])
    return list.length > 0
      ? `?${list.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
      : ''
  }
  switch (target.kind) {
    case 'session':
      return `huli://session/${encodeURIComponent(target.id)}${suffix([])}`
    case 'artifact':
      return `huli://artifact/${encodeURIComponent(target.id)}${suffix([
        ['version', target.version === null ? '' : String(target.version)],
      ])}`
    case 'new':
      return `huli://new${suffix([])}`
    case 'search':
      return `huli://search${suffix([['q', target.q]])}`
    case 'tab':
      return `huli://${target.tab === 'index' ? '' : target.tab}${suffix([])}`
  }
}

/** The computer an id in a link names, by either of its ids. */
export function computerFor(computers: SavedHost[], id: string): SavedHost | null {
  return computers.find((h) => h.id === id) ?? computers.find((h) => h.pushId === id) ?? null
}

let pending: AppLink | null = null
const listeners = new Set<() => void>()

/** Opens a link as soon as the app can; a newer link replaces one still waiting. */
export function openLink(link: AppLink): void {
  pending = link
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function navigate(target: LinkTarget): void {
  switch (target.kind) {
    case 'session':
      router.push({ pathname: '/session/[id]', params: { id: target.id } })
      return
    case 'artifact':
      router.push({
        pathname: '/artifact/[id]',
        params: target.version ? { id: target.id, version: String(target.version) } : { id: target.id },
      })
      return
    case 'new':
      router.push('/new')
      return
    case 'search':
      router.push({ pathname: '/search', params: target.q ? { q: target.q } : {} })
      return
    case 'tab':
      if (router.canDismiss()) router.dismissAll()
      router.navigate(target.tab === 'index' ? '/' : `/${target.tab}`)
  }
}

/** Opens waiting links once the app is ready, unlocked and on the computer they name. */
export function LinkBridge() {
  const host = useHost()
  const lock = useLockState()
  const navigation = useRootNavigationState()
  const link = useSyncExternalStore(subscribe, () => pending)
  const mounted = !!navigation?.key
  const activeId = host.host?.id ?? null
  const { phase, computers, switchTo } = host

  useEffect(() => {
    if (!link || !mounted || phase !== 'ready' || lock.locked || lock.covered) return
    const wanted = link.host ? computerFor(computers, link.host) : null
    if (wanted && wanted.id !== activeId) {
      // The screens above the tabs belong to the computer being left.
      if (router.canDismiss()) router.dismissAll()
      switchTo(wanted.id)
      return
    }
    pending = null
    for (const listener of listeners) listener()
    // After the commit that shows the computer's tabs, so the route lands in them.
    const target = link.target
    if (target) setTimeout(() => navigate(target), 0)
  }, [link, mounted, phase, lock.locked, lock.covered, computers, activeId, switchTo])

  return null
}

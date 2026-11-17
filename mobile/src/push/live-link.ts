// The active computer's link, for work that runs outside any screen: answering from a
// notification, often while the app is in the background or was launched only for that. The bridge
// publishes the link the host provider keeps, with which computer it is, so an answer goes only
// to the computer that sent the notification and never opens a second connection beside it.

import type { HostLink } from '@shared/remote/link'
import { computerFor } from '../links'
import type { SavedHost } from '../store'

interface Live {
  link: HostLink
  active: SavedHost | null
  computers: SavedHost[]
}

let current: Live | null = null
const waiting = new Set<() => void>()

export function publishLink(live: Live | null): void {
  current = live
  for (const listener of [...waiting]) listener()
}

/** Why there is no link to answer on: none at all, or another computer is the active one. */
export class NoLink extends Error {
  constructor(readonly reason: 'none' | 'other-computer' | 'not-connected') {
    super(reason)
  }
}

function liveWithin(ms: number): Promise<Live | null> {
  if (current) return Promise.resolve(current)
  return new Promise((resolve) => {
    const done = (live: Live | null): void => {
      clearTimeout(timer)
      waiting.delete(check)
      resolve(live)
    }
    const check = (): void => {
      if (current) done(current)
    }
    const timer = setTimeout(() => done(null), ms)
    waiting.add(check)
  })
}

/** Whether the computer a notification names (by its notifications' id) is the active one. */
function isActive(live: Live, host: string | null): boolean {
  if (!host) return true
  const wanted = computerFor(live.computers, host)
  if (wanted) return wanted.id === live.active?.id
  // Its notifications' id is not known yet: only a phone with this one computer can tell.
  return live.computers.length === 1 && live.active !== null
}

/**
 * The link to the computer `host` names once it is connected, trying at once even in the
 * background, where it does not retry by itself. Rejects with NoLink after `ms`, when that
 * computer is not the active one, or when there is none.
 */
export async function connectedLink(host: string | null, ms: number): Promise<HostLink> {
  const deadline = Date.now() + ms
  const live = await liveWithin(ms)
  if (!live) throw new NoLink('none')
  if (!isActive(live, host)) throw new NoLink('other-computer')
  const { link } = live
  if (link.state.kind === 'connected') return link
  link.wake()
  return new Promise<HostLink>((resolve, reject) => {
    let settled = false
    let off: (() => void) | null = null
    const settle = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      if (error) reject(error)
      else resolve(link)
    }
    const timer = setTimeout(
      () => settle(new NoLink('not-connected')),
      Math.max(0, deadline - Date.now()),
    )
    // onState calls back at once with the current state, before it returns its remover.
    off = link.onState((state) => {
      if (state.kind === 'connected') settle(null)
      else if (state.kind === 'stopped') settle(new NoLink('not-connected'))
    })
    if (settled) off()
  })
}

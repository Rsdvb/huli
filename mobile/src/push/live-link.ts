// The paired computer's link, for work that runs outside any screen: answering from a notification,
// often while the app is in the background or was launched only for that. The bridge publishes the
// link the host provider keeps, so an answer never opens a second connection beside it.

import type { HostLink } from '@shared/remote/link'

let current: HostLink | null = null
const waiting = new Set<() => void>()

export function publishLink(link: HostLink | null): void {
  current = link
  for (const listener of [...waiting]) listener()
}

function linkWithin(ms: number): Promise<HostLink | null> {
  if (current) return Promise.resolve(current)
  return new Promise((resolve) => {
    const done = (link: HostLink | null): void => {
      clearTimeout(timer)
      waiting.delete(check)
      resolve(link)
    }
    const check = (): void => {
      if (current) done(current)
    }
    const timer = setTimeout(() => done(null), ms)
    waiting.add(check)
  })
}

/**
 * The link once it is connected, trying at once even in the background, where it does not retry
 * by itself; rejects after `ms`, or when there is no paired computer or it stopped.
 */
export async function connectedLink(ms: number): Promise<HostLink> {
  const deadline = Date.now() + ms
  const link = await linkWithin(ms)
  if (!link) throw new Error('no link')
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
      () => settle(new Error('not connected')),
      Math.max(0, deadline - Date.now()),
    )
    // onState calls back at once with the current state, before it returns its remover.
    off = link.onState((state) => {
      if (state.kind === 'connected') settle(null)
      else if (state.kind === 'stopped') settle(new Error('stopped'))
    })
    if (settled) off()
  })
}

// Keeps the iOS system integrations in step while the app runs (modules/huli-system): opens the
// links Siri, Shortcuts, the Control Center controls, Spotlight and Handoff leave for the app, as
// any huli:// link (links.ts waits until the app can show it), keeps the sessions in Spotlight
// (spotlight.ts), and advertises the open session as the current activity, for Handoff and Siri
// suggestions, without its title while the user hides what notifications say. iOS only; elsewhere
// the module is missing and this does nothing.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { usePathname } from 'expo-router'
import { HuliSystem } from '../../modules/huli-system'
import { sameFields, useHostSelector, type HostData } from '../host'
import { openLink, parseLink } from '../links'
import { prefsLoaded, usePref } from '../prefs'
import { folder, sessionTitle } from '../sessions'
import { syncSpotlight } from './spotlight'

function takeLink(): void {
  const url = HuliSystem?.takeOpenURL()
  const link = url ? parseLink(url) : null
  if (link) openLink(link)
}

function sessionIn(pathname: string): string | null {
  const match = /^\/session\/([^/]+)$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return match[1]!
  }
}

/** What Spotlight and the open session's activity need: not the link's state, which changes often. */
const pick = (d: HostData) => ({
  phase: d.phase,
  hostId: d.computers.hosts.find((h) => h.id === d.computers.active)?.id ?? null,
  computers: d.computers.hosts,
  sessions: d.sessions,
  agents: d.agents,
  projects: d.projects,
  loaded: d.loaded,
})

export function SystemBridge() {
  const { phase, hostId, computers, sessions, agents, projects, loaded } = useHostSelector(
    pick,
    sameFields,
  )
  const hidePreviews = usePref('hidePreviews')
  const pathname = usePathname()
  const ready = prefsLoaded()
  const hidden = hidePreviews
  const computerIds = computers.map((c) => c.id).join('\n')

  useEffect(() => {
    if (!HuliSystem) return
    takeLink()
    const subscription = HuliSystem.addListener('onOpenURL', takeLink)
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'active') takeLink()
    })
    return () => {
      subscription.remove()
      app.remove()
    }
  }, [])

  useEffect(() => {
    if (!HuliSystem || !ready || phase === 'loading') return
    const timer = setTimeout(
      () =>
        syncSpotlight({
          paired: phase === 'ready',
          computers: computerIds ? computerIds.split('\n') : [],
          active: hostId && loaded ? { id: hostId, sessions, agents, projects } : null,
          hidden,
        }),
      2000,
    )
    return () => clearTimeout(timer)
  }, [ready, phase, computerIds, hostId, loaded, sessions, agents, projects, hidden])

  const sessionId = sessionIn(pathname)
  const open = sessionId ? sessions.get(sessionId) : undefined
  const title = open && !hidden ? sessionTitle(open) : null
  const project = open && !hidden && !open.scratch ? folder(open.projectPath) : null
  useEffect(() => {
    if (!HuliSystem || !ready) return
    const current =
      sessionId && hostId
        ? JSON.stringify({
            id: sessionId,
            host: hostId,
            ...(title ? { title } : {}),
            ...(project ? { project } : {}),
          })
        : ''
    void HuliSystem.setCurrentSession(current).catch(() => {})
  }, [ready, sessionId, hostId, title, project])

  return null
}

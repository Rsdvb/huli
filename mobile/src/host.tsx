// The paired computer, shared by every screen: the kept link, its state, and the sessions, agents
// and projects it lists, kept current by its events.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import type { AgentStatus, HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { HostLink, LinkState } from '@shared/remote/link'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { deviceKey, linkTo } from './connection'
import { loadHost, saveHost, type SavedHost } from './store'

interface Ready {
  host: SavedHost
  key: KeyPair
  link: HostLink
}

export interface HostContextValue {
  phase: 'loading' | 'pair' | 'ready'
  notice: string | null
  host: SavedHost | null
  link: HostLink | null
  state: LinkState
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  projects: Project[]
  paired(host: SavedHost, key: KeyPair, paired: Paired): Promise<void>
  forget(notice: string | null): Promise<void>
  refresh(): Promise<void>
}

const HostContext = createContext<HostContextValue | null>(null)

export function useHost(): HostContextValue {
  const value = useContext(HostContext)
  if (!value) throw new Error('useHost outside HostProvider')
  return value
}

/** The link, for a screen that only shows while one is up. */
export function useLink(): HostLink {
  const { link } = useHost()
  if (!link) throw new Error('No link to the computer')
  return link
}

export function HostProvider(props: { children: ReactNode }) {
  const [phase, setPhase] = useState<HostContextValue['phase']>('loading')
  const [notice, setNotice] = useState<string | null>(null)
  const [ready, setReady] = useState<Ready | null>(null)
  const [state, setState] = useState<LinkState>({ kind: 'connecting' })
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(new Map())
  const [agents, setAgents] = useState<Map<string, AgentStatus>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const hostRef = useRef<SavedHost | null>(null)

  const start = useCallback((host: SavedHost, key: KeyPair, adopt?: Paired) => {
    hostRef.current = host
    setReady({ host, key, link: linkTo(host, key, adopt) })
    setPhase('ready')
  }, [])

  useEffect(() => {
    void (async () => {
      const [host, key] = await Promise.all([loadHost(), deviceKey()])
      if (host) start(host, key)
      else setPhase('pair')
    })()
  }, [start])

  const refresh = useCallback(async () => {
    const link = ready?.link
    if (!link) return
    const [list, agentList, projectList] = await Promise.all([
      link.request('sessions.list', {}) as Promise<SessionSummary[]>,
      link.request('agents.list', undefined) as Promise<AgentStatus[]>,
      link.request('projects.list', undefined) as Promise<Project[]>,
    ])
    setSessions(new Map(list.map((s) => [s.id, s])))
    setAgents(new Map(agentList.map((a) => [a.id, a])))
    setProjects(projectList)
  }, [ready])

  const forget = useCallback(async (next: string | null) => {
    setReady((current) => {
      current?.link.stop()
      return null
    })
    hostRef.current = null
    setSessions(new Map())
    await saveHost(null)
    setNotice(next)
    setPhase('pair')
  }, [])

  useEffect(() => {
    if (!ready) return
    const { link } = ready
    const offState = link.onState((next) => {
      setState(next)
      if (next.kind === 'connected') {
        const { welcome } = next
        const saved = hostRef.current!
        const addresses = welcome.addresses.length > 0 ? welcome.addresses : saved.addresses
        const changed =
          saved.name !== welcome.host.name ||
          saved.deviceName !== welcome.device.name ||
          JSON.stringify(saved.addresses) !== JSON.stringify(addresses)
        if (changed) {
          hostRef.current = { ...saved, name: welcome.host.name, deviceName: welcome.device.name, addresses }
          void saveHost(hostRef.current)
        }
        void refresh().catch(() => {})
      }
      if (next.kind === 'stopped' && next.reason === 'removed') {
        void forget('这台手机已在电脑上被移除，请重新配对。')
      }
    })
    const offEvents = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      switch (event.type) {
        case 'session.summary':
          setSessions((map) => new Map(map).set(event.summary.id, event.summary))
          break
        case 'session.removed':
          setSessions((map) => {
            const next = new Map(map)
            next.delete(event.sessionId)
            return next
          })
          break
        case 'agent.status':
          setAgents((map) => new Map(map).set(event.status.id, event.status))
          break
        case 'projects.changed':
          setProjects(event.projects)
          break
      }
    })
    const offApp = AppState.addEventListener('change', (status) => {
      if (status === 'active') link.wake()
    })
    link.start()
    return () => {
      offState()
      offEvents()
      offApp.remove()
      link.stop()
    }
  }, [ready, refresh, forget])

  const value: HostContextValue = {
    phase,
    notice,
    host: hostRef.current,
    link: ready?.link ?? null,
    state,
    sessions,
    agents,
    projects,
    paired: async (host, key, paired) => {
      await saveHost(host)
      setNotice(null)
      start(host, key, paired)
    },
    forget,
    refresh,
  }
  return <HostContext.Provider value={value}>{props.children}</HostContext.Provider>
}

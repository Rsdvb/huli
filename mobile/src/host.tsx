// The paired computers, shared by every screen: the one the app shows (the active one), its kept
// link and state, and the sessions, agents and projects it lists, kept current by its events.
// Only the active computer has a link; switching closes one link and opens the other. What the
// active computer listed last is kept in the cache (cache.ts) and shown at once on the next start.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Alert, AppState } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus, HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { HostLink, LinkState } from '@shared/remote/link'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { admin } from './admin'
import { clearComputer, dropThread, readLists, writeLists } from './cache'
import { deviceKey, linkTo } from './connection'
import { stopPush } from './push/sync'
import {
  computerName,
  loadComputers,
  saveComputers,
  type SavedComputers,
  type SavedHost,
} from './store'

interface Ready {
  host: SavedHost
  key: KeyPair
  link: HostLink
}

export interface HostContextValue {
  phase: 'loading' | 'pair' | 'ready'
  notice: string | null
  /** The active computer. */
  host: SavedHost | null
  /** Every paired computer, the active one included, in the order they were paired. */
  computers: SavedHost[]
  link: HostLink | null
  state: LinkState
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  projects: Project[]
  /** The lists hold something to show: the computer's answer, or the cache's copy of it. */
  loaded: boolean
  /** The lists are the cache's copy; the computer has not answered since the app started. */
  fromCache: boolean
  /** When the lists were last current with the computer; null when never. */
  syncedAt: number | null
  /**
   * The link has not been up for UNREACHABLE_AFTER (or has stopped): the computer is likely off,
   * Huli is not running there, or the networks differ. The link keeps retrying with backoff.
   */
  unreachable: boolean
  /** Tries the computer again now. */
  retry(): void
  paired(host: SavedHost, key: KeyPair, paired: Paired): Promise<void>
  /** Forgets the active computer without asking it anything, as when it removed this phone. */
  forget(notice: string | null): Promise<void>
  /** Unpairs a computer: tells it when it can be reached, then forgets it and its cache. */
  unpair(id: string): Promise<void>
  switchTo(id: string): void
  /** The name this phone shows for a computer; null goes back to the computer's own. */
  rename(id: string, label: string | null): void
  refresh(): Promise<void>
  /** The computer took a new name for this phone; kept until its next welcome says so too. */
  renamedDevice(name: string): void
  /** The id the active computer's notifications carry, which says which computer sent one. */
  notePushId(pushId: string): void
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

/** Resolves true once the link connects, false when it stops or the time runs out. */
function connectedWithin(link: HostLink, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let off: () => void = () => {}
    const finish = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    off = link.onState((state) => {
      if (state.kind === 'connected') finish(true)
      else if (state.kind === 'stopped') finish(false)
    })
    if (done) off()
  })
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EMPTY: SavedComputers = { active: null, hosts: [] }

/** How long the link may try before the app says the computer cannot be reached. */
export const UNREACHABLE_AFTER = 8000

export function HostProvider(props: { children: ReactNode }) {
  const [phase, setPhase] = useState<HostContextValue['phase']>('loading')
  const [notice, setNotice] = useState<string | null>(null)
  const [computers, setComputers] = useState<SavedComputers>(EMPTY)
  const [ready, setReady] = useState<Ready | null>(null)
  const [state, setState] = useState<LinkState>({ kind: 'connecting' })
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(new Map())
  const [agents, setAgents] = useState<Map<string, AgentStatus>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(false)
  const [fromCache, setFromCache] = useState(false)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const computersRef = useRef<SavedComputers>(EMPTY)
  const keyRef = useRef<KeyPair | null>(null)
  const linkRef = useRef<HostLink | null>(null)
  linkRef.current = ready?.link ?? null
  /** Counts the starts, so an answer meant for the computer before a switch is dropped. */
  const generation = useRef(0)
  /** The computer has answered since this start; the cache must not overwrite its lists. */
  const fresh = useRef(false)
  /** Computers being unpaired here, whose links stopping is no news to the user. */
  const unpairing = useRef(new Set<string>())

  const update = useCallback(
    (change: (hosts: SavedHost[]) => SavedHost[], active?: string | null) => {
      const current = computersRef.current
      const next: SavedComputers = {
        hosts: change(current.hosts),
        active: active === undefined ? current.active : active,
      }
      computersRef.current = next
      setComputers(next)
      void saveComputers(next).catch(() => {})
    },
    [],
  )

  const patchHost = useCallback(
    (id: string, change: Partial<SavedHost>) =>
      update((hosts) => hosts.map((h) => (h.id === id ? { ...h, ...change } : h))),
    [update],
  )

  const clearLists = useCallback(() => {
    setSessions(new Map())
    setAgents(new Map())
    setProjects([])
    setLoaded(false)
    setFromCache(false)
    setSyncedAt(null)
  }, [])

  const start = useCallback(
    (host: SavedHost, key: KeyPair, adopt?: Paired) => {
      const mine = ++generation.current
      fresh.current = false
      clearLists()
      setUnreachable(false)
      setState({ kind: 'connecting' })
      setReady({ host, key, link: linkTo(host, key, adopt) })
      setPhase('ready')
      void readLists(host.id).then((cached) => {
        if (!cached || mine !== generation.current || fresh.current) return
        setSessions(new Map(cached.sessions.map((s) => [s.id, s])))
        setAgents(new Map(cached.agents.map((a) => [a.id, a])))
        setProjects(cached.projects)
        setLoaded(true)
        setFromCache(true)
        setSyncedAt(cached.savedAt)
      })
    },
    [clearLists],
  )

  useEffect(() => {
    void (async () => {
      const [saved, key] = await Promise.all([loadComputers(), deviceKey()])
      keyRef.current = key
      computersRef.current = saved
      setComputers(saved)
      const active = saved.hosts.find((h) => h.id === saved.active)
      if (active) start(active, key)
      else setPhase('pair')
    })()
  }, [start])

  const refresh = useCallback(async () => {
    const link = ready?.link
    if (!link) return
    const mine = generation.current
    const [list, agentList, projectList] = await Promise.all([
      link.request('sessions.list', {}) as Promise<SessionSummary[]>,
      link.request('agents.list', undefined) as Promise<AgentStatus[]>,
      link.request('projects.list', undefined) as Promise<Project[]>,
    ])
    if (mine !== generation.current) return
    fresh.current = true
    setSessions(new Map(list.map((s) => [s.id, s])))
    setAgents(new Map(agentList.map((a) => [a.id, a])))
    setProjects(projectList)
    setLoaded(true)
    setFromCache(false)
    setSyncedAt(Date.now())
  }, [ready])

  /** Forgets a computer here: its push keys, its cache, its place in the list. */
  const drop = useCallback(
    async (id: string, next: string | null) => {
      const gone = computersRef.current.hosts.find((h) => h.id === id)
      await stopPush(null, gone?.pushId ?? null)
      void clearComputer(id)
      const rest = computersRef.current.hosts.filter((h) => h.id !== id)
      if (computersRef.current.active !== id) {
        update(() => rest)
        return
      }
      const successor = [...rest].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0] ?? null
      // The screens above the tabs show the computer that is going; none may outlive its link.
      try {
        if (router.canDismiss()) router.dismissAll()
      } catch {
        // Nothing is mounted yet to dismiss.
      }
      update(() => rest, successor?.id ?? null)
      generation.current++
      setReady((current) => {
        current?.link.stop()
        return null
      })
      clearLists()
      if (successor && keyRef.current) {
        start(successor, keyRef.current)
        if (next) Alert.alert('已解除配对', next)
      } else {
        setNotice(next)
        setPhase('pair')
      }
    },
    [update, clearLists, start],
  )

  const forget = useCallback(
    async (next: string | null) => {
      const id = computersRef.current.active
      if (id) await drop(id, next)
    },
    [drop],
  )

  const unpair = useCallback(
    async (id: string) => {
      const host = computersRef.current.hosts.find((h) => h.id === id)
      const key = keyRef.current
      if (!host || !key) return
      unpairing.current.add(id)
      const active = computersRef.current.active === id ? linkRef.current : null
      const link = active ?? linkTo(host, key)
      try {
        if (!active) link.start()
        if (await connectedWithin(link, active ? 0 : 5000)) {
          const welcome = link.state.kind === 'connected' ? link.state.welcome : null
          await stopPush(link, null)
          if (welcome) {
            await Promise.race([
              admin(link, 'remote.removeDevice', { id: welcome.device.id }),
              timeout(4000),
            ]).catch(() => {})
          }
        }
      } finally {
        if (!active) link.stop()
        await drop(id, null)
        unpairing.current.delete(id)
      }
    },
    [drop],
  )

  const switchTo = useCallback(
    (id: string) => {
      const key = keyRef.current
      const host = computersRef.current.hosts.find((h) => h.id === id)
      if (!host || !key || computersRef.current.active === id) return
      update((hosts) => hosts, id)
      start(host, key)
    },
    [update, start],
  )

  // Not connected for a while: the screens say so plainly instead of waiting on a spinner.
  useEffect(() => {
    if (state.kind === 'connected') {
      setUnreachable(false)
      return
    }
    if (state.kind === 'stopped') {
      setUnreachable(true)
      return
    }
    const timer = setTimeout(() => setUnreachable(true), UNREACHABLE_AFTER)
    return () => clearTimeout(timer)
  }, [state.kind, ready, attempt])

  const retry = useCallback(() => {
    const link = linkRef.current
    if (!link) return
    setUnreachable(false)
    setAttempt((n) => n + 1)
    link.wake()
  }, [])

  // The lists go to the cache a moment after they settle, never while they are the cache's own.
  const activeId = ready?.host.id ?? null
  useEffect(() => {
    if (!activeId || !loaded || fromCache) return
    const timer = setTimeout(() => {
      void writeLists(activeId, {
        savedAt: Date.now(),
        sessions: [...sessions.values()],
        agents: [...agents.values()],
        projects,
      })
    }, 1500)
    return () => clearTimeout(timer)
  }, [activeId, loaded, fromCache, sessions, agents, projects])

  useEffect(() => {
    if (!ready) return
    const { link } = ready
    const id = ready.host.id
    let wasConnected = false
    const offState = link.onState((next) => {
      setState(next)
      if (next.kind === 'connected') {
        wasConnected = true
        const { welcome } = next
        const saved = computersRef.current.hosts.find((h) => h.id === id)
        if (saved) {
          const addresses = welcome.addresses.length > 0 ? welcome.addresses : saved.addresses
          patchHost(id, {
            name: welcome.host.name,
            deviceName: welcome.device.name,
            platform: welcome.host.platform,
            addresses,
            lastSeen: Date.now(),
          })
        }
        void refresh().catch(() => {})
      } else if (wasConnected) {
        // The lists were current until now: that is when they were last in step.
        wasConnected = false
        setSyncedAt(Date.now())
        patchHost(id, { lastSeen: Date.now() })
      }
      if (next.kind === 'stopped' && next.reason === 'removed' && !unpairing.current.has(id)) {
        const name = computerName(computersRef.current.hosts.find((h) => h.id === id))
        void drop(id, `「${name}」已在电脑上移除这台手机，要用它请重新配对。`)
      }
    })
    const offEvents = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      switch (event.type) {
        case 'session.summary':
          setSessions((map) => new Map(map).set(event.summary.id, event.summary))
          break
        case 'session.removed':
          void dropThread(id, event.sessionId)
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
    // Back in front, the computer is tried at once rather than when the backoff says.
    const offApp = AppState.addEventListener('change', (status) => {
      if (status === 'active') retry()
    })
    link.start()
    return () => {
      offState()
      offEvents()
      offApp.remove()
      link.stop()
    }
  }, [ready, refresh, drop, patchHost, retry])

  const active = computers.hosts.find((h) => h.id === computers.active) ?? null

  const value: HostContextValue = {
    phase,
    notice,
    host: active,
    computers: computers.hosts,
    link: ready?.link ?? null,
    state,
    sessions,
    agents,
    projects,
    loaded,
    fromCache,
    syncedAt,
    unreachable,
    retry,
    paired: async (host, key, paired) => {
      keyRef.current = key
      const before = computersRef.current.hosts.find((h) => h.id === host.id)
      const saved: SavedHost = {
        ...host,
        ...(before?.label ? { label: before.label } : {}),
        ...(before?.pushId ? { pushId: before.pushId } : {}),
      }
      update(
        (hosts) => (before ? hosts.map((h) => (h.id === host.id ? saved : h)) : [...hosts, saved]),
        host.id,
      )
      setNotice(null)
      start(saved, key, paired)
    },
    forget,
    unpair,
    switchTo,
    rename: (id, label) => patchHost(id, { label: label?.trim() || undefined }),
    refresh,
    renamedDevice: (name) => {
      if (computers.active) patchHost(computers.active, { deviceName: name })
    },
    notePushId: (pushId) => {
      const id = computersRef.current.active
      if (!id) return
      const known = computersRef.current.hosts.find((h) => h.id === id)
      if (known?.pushId === pushId) return
      update((hosts) =>
        hosts.map((h) =>
          h.id === id ? { ...h, pushId } : h.pushId === pushId ? { ...h, pushId: undefined } : h,
        ),
      )
    },
  }
  return <HostContext.Provider value={value}>{props.children}</HostContext.Provider>
}

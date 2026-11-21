// The paired computers, shared by every screen: the one the app shows (the active one), its kept
// link and state, and the sessions, agents and projects it lists, kept current by its events.
// Only the active computer has a link; switching closes one link and opens the other. What the
// active computer listed last is kept in the cache (cache.ts) and shown at once on the next start.
//
// The data lives in a small external store rather than in a React context, so a screen subscribes
// through a selector (`useSession(id)`, `useHostState()`, `useLink()`...) and re-renders only when
// what it selected changed. A summary that comes in unchanged keeps its object, and so does the map
// that holds it, so rows compare by reference. `useHost()` still returns everything, for screens
// that want it all; it re-renders on any change, as the context did.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Alert } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus, HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { HostLink, LinkState } from '@shared/remote/link'
import type { SessionFolder } from '@shared/session-folders'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { admin } from './admin'
import { clearComputer, dropThread, readLists, writeLists } from './cache'
import { currentAddress, deviceKey, linkTo } from './connection'
import { dropDrafts } from './drafts'
import { dropOutbox } from './outbox'
import { watchWakeups, type WakeReason } from './reconnect'
import { createStore, sameFields, sameItems, useSelector } from './select'
import { stopPush } from './push/sync'
import { showLimitAlert } from './usage/limitAlert'
import {
  computerName,
  loadComputers,
  saveComputers,
  type RoutePick,
  type SavedComputers,
  type SavedHost,
} from './store'

interface Ready {
  host: SavedHost
  key: KeyPair
  link: HostLink
}

/** What the store holds; `useHost()` and the selectors read it. */
export interface HostData {
  phase: 'loading' | 'pair' | 'ready'
  notice: string | null
  computers: SavedComputers
  ready: Ready | null
  state: LinkState
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  projects: Project[]
  /** The user's folders of sessions on the computer; none from a computer without them. */
  folders: SessionFolder[]
  loaded: boolean
  fromCache: boolean
  syncedAt: number | null
  unreachable: boolean
  /** The link has not been up for DOWN_AFTER, so what says it is down may show. */
  down: boolean
  /** The last refresh of the lists failed or timed out; while `fromCache`, they are still old. */
  syncFailed: boolean
}

export interface HostActions {
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
  /** The way the phone reaches a computer from now on; null takes every way. */
  setRoute(id: string, route: RoutePick | null): void
  /** Reads the lists again; settles within REFRESH_LIMIT, connected or not. */
  refresh(): Promise<void>
  /** The computer took a new name for this phone; kept until its next welcome says so too. */
  renamedDevice(name: string): void
  /** The id the active computer's notifications carry, which says which computer sent one. */
  notePushId(pushId: string): void
}

export interface HostContextValue extends HostActions {
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
}

const EMPTY: SavedComputers = { active: null, hosts: [] }

// ---- The store ----

const store = createStore<HostData>({
  phase: 'loading',
  notice: null,
  computers: EMPTY,
  ready: null,
  state: { kind: 'connecting' },
  sessions: new Map(),
  agents: new Map(),
  projects: [],
  folders: [],
  loaded: false,
  fromCache: false,
  syncedAt: null,
  unreachable: false,
  down: false,
  syncFailed: false,
})
const subscribe = store.subscribe

/** The store as it is now, for code outside React or inside callbacks. */
export function getHost(): HostData {
  return store.get()
}

function setHost(change: Partial<HostData> | ((was: HostData) => Partial<HostData>)): void {
  store.set((data) => {
    const patch = typeof change === 'function' ? change(data) : change
    for (const key in patch) {
      if (patch[key as keyof HostData] !== data[key as keyof HostData]) return { ...data, ...patch }
    }
    return data
  })
}

/**
 * Part of the store: re-renders only when `select`'s answer changes by `equal` (reference by
 * default). A new answer equal to the last keeps the last's reference.
 */
export function useHostSelector<T>(
  select: (d: HostData) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  return useSelector(store, select, equal)
}

export { sameFields, sameItems }
const activeOf = (d: HostData): SavedHost | null =>
  d.computers.hosts.find((h) => h.id === d.computers.active) ?? null

const selectSessions = (d: HostData) => d.sessions
const selectAgents = (d: HostData) => d.agents
const selectProjects = (d: HostData) => d.projects
const selectFolders = (d: HostData) => d.folders
const selectState = (d: HostData) => d.state
const selectLink = (d: HostData) => d.ready?.link ?? null
const selectConnected = (d: HostData) => d.state.kind === 'connected'
const selectComputerId = (d: HostData) => activeOf(d)?.id ?? null
const selectLoaded = (d: HostData) => d.loaded
const selectDown = (d: HostData) => d.down
const selectStale = (d: HostData) => d.fromCache || (d.down && d.state.kind !== 'connected')

/** Every session; changes when any does. */
export function useSessions(): Map<string, SessionSummary> {
  return useHostSelector(selectSessions)
}

/** One session's summary; changes only when that one does. */
export function useSession(id: string | null | undefined): SessionSummary | undefined {
  return useHostSelector(useCallback((d: HostData) => (id ? d.sessions.get(id) : undefined), [id]))
}

const selectHasSessions = (d: HostData) => d.sessions.size > 0

/** Whether the lists hold any session, without following each one's changes. */
export function useHasSessions(): boolean {
  return useHostSelector(selectHasSessions)
}

export function useAgents(): Map<string, AgentStatus> {
  return useHostSelector(selectAgents)
}

export function useAgent(id: string | null | undefined): AgentStatus | undefined {
  return useHostSelector(useCallback((d: HostData) => (id ? d.agents.get(id) : undefined), [id]))
}

export function useProjects(): Project[] {
  return useHostSelector(selectProjects)
}

/** The active computer's folders of sessions, in the user's order. */
export function useFolders(): SessionFolder[] {
  return useHostSelector(selectFolders)
}

export function useHostState(): LinkState {
  return useHostSelector(selectState)
}

export function useConnected(): boolean {
  return useHostSelector(selectConnected)
}

export function useListsLoaded(): boolean {
  return useHostSelector(selectLoaded)
}

/**
 * The link has been down a moment: what says so (正在重新连接…) shows only then, so a quick
 * reconnect, as on coming back to the front, never flickers.
 */
export function useLinkDown(): boolean {
  return useHostSelector(selectDown)
}

/**
 * The lists may be behind the computer: they are the cache's copy, or the link has been down a
 * while. What they say runs is then only what ran when last heard of.
 */
export function useListsStale(): boolean {
  return useHostSelector(selectStale)
}

/** The active computer's id, which the caches are kept under. */
export function useComputerId(): string | null {
  return useHostSelector(selectComputerId)
}

/** The active computer as saved. */
export function useActiveHost(): SavedHost | null {
  return useHostSelector(activeOf)
}

/** The link, or null while there is none. */
export function useMaybeLink(): HostLink | null {
  return useHostSelector(selectLink)
}

/** The link, for a screen that only shows while one is up. */
export function useLink(): HostLink {
  const link = useMaybeLink()
  if (!link) throw new Error('No link to the computer')
  return link
}

const ActionsContext = createContext<HostActions | null>(null)

/** What can be done with the computers; the same functions for the life of the app. */
export function useHostActions(): HostActions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useHostActions outside HostProvider')
  return actions
}

const selectComputers = (d: HostData) => ({
  computers: d.computers,
  state: d.state,
  unreachable: d.unreachable,
})

/** The paired computers and the link, without the lists: for the sheets that manage computers. */
export function useComputers(): Pick<
  HostContextValue,
  'host' | 'computers' | 'state' | 'unreachable'
> &
  HostActions {
  const actions = useHostActions()
  const d = useHostSelector(selectComputers, sameFields)
  return useMemo(
    () => ({
      ...actions,
      host: d.computers.hosts.find((h) => h.id === d.computers.active) ?? null,
      computers: d.computers.hosts,
      state: d.state,
      unreachable: d.unreachable,
    }),
    [actions, d],
  )
}

const selectAll = (d: HostData) => d

/** Everything at once; re-renders on any change. Prefer a narrower hook in hot screens. */
export function useHost(): HostContextValue {
  const actions = useHostActions()
  const d = useHostSelector(selectAll)
  return useMemo(
    () => ({
      ...actions,
      phase: d.phase,
      notice: d.notice,
      host: activeOf(d),
      computers: d.computers.hosts,
      link: d.ready?.link ?? null,
      state: d.state,
      sessions: d.sessions,
      agents: d.agents,
      projects: d.projects,
      loaded: d.loaded,
      fromCache: d.fromCache,
      syncedAt: d.syncedAt,
      unreachable: d.unreachable,
    }),
    [actions, d],
  )
}

// ---- Keeping unchanged items ----

/** Plain data equal all the way down, as JSON would see it. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** A map of `list` by id that keeps `was`'s objects, and `was` itself, where nothing changed. */
function reconcile<T extends { id: string }>(was: Map<string, T>, list: T[]): Map<string, T> {
  const next = new Map<string, T>()
  let kept = list.length === was.size
  for (const item of list) {
    const old = was.get(item.id)
    if (old && same(old, item)) next.set(item.id, old)
    else {
      next.set(item.id, item)
      kept = false
    }
  }
  if (kept) {
    // Same items: keep the map unless the order changed.
    const a = was.keys()
    for (const id of next.keys()) if (a.next().value !== id) return next
    return was
  }
  return next
}

/** `map` with `item` set, or `map` itself when it holds an equal one. */
function withItem<T extends { id: string }>(map: Map<string, T>, item: T): Map<string, T> {
  const old = map.get(item.id)
  if (old && same(old, item)) return map
  return new Map(map).set(item.id, item)
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

/** A computer's folders of sessions; none from a computer older than folders, or on a failure. */
export function readFolders(link: HostLink, signal?: AbortSignal): Promise<SessionFolder[]> {
  return (link.request('folders.list', undefined, signal) as Promise<SessionFolder[]>).then(
    (list) => (Array.isArray(list) ? list : []),
    () => [],
  )
}

/** How long the link may try before the app says the computer cannot be reached. */
export const UNREACHABLE_AFTER = 8000

/** How long the link may be down before the app says it reconnects. */
const DOWN_AFTER = 600

/**
 * How long a refresh of the lists may take. A request waits for the link to come back rather than
 * failing, so without a limit a refresh made while the computer is away never settles, and a
 * pull-to-refresh spinner waiting on it stays on the home screen until the app is killed.
 */
const REFRESH_LIMIT = 15_000

/**
 * Runs a read of a list with a signal that aborts after REFRESH_LIMIT, so whatever waits on it, such
 * as a pull-to-refresh spinner, always settles, even when the read does not pass the signal on. A
 * read cut off by the limit fails in words.
 */
export async function withinRefreshLimit<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const limit = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      limit.abort()
      reject(new Error('电脑没有及时回应。'))
    }, REFRESH_LIMIT)
  })
  try {
    return await Promise.race([read(limit.signal), expired])
  } catch (error) {
    throw limit.signal.aborted ? new Error('电脑没有及时回应。') : error
  } finally {
    clearTimeout(timer)
  }
}

const selectReady = (d: HostData) => d.ready
const selectStateKind = (d: HostData) => d.state.kind

export function HostProvider(props: { children: ReactNode }) {
  const ready = useHostSelector(selectReady)
  const stateKind = useHostSelector(selectStateKind)
  const [attempt, setAttempt] = useState(0)
  const keyRef = useRef<KeyPair | null>(null)
  /** Counts the starts, so an answer meant for the computer before a switch is dropped. */
  const generation = useRef(0)
  /** The computer has answered since this start; the cache must not overwrite its lists. */
  const fresh = useRef(false)
  /** Computers being unpaired here, whose links stopping is no news to the user. */
  const unpairing = useRef(new Set<string>())

  const update = useCallback(
    (change: (hosts: SavedHost[]) => SavedHost[], active?: string | null) => {
      const current = getHost().computers
      const next: SavedComputers = {
        hosts: change(current.hosts),
        active: active === undefined ? current.active : active,
      }
      setHost({ computers: next })
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
    setHost({
      sessions: new Map(),
      agents: new Map(),
      projects: [],
      folders: [],
      loaded: false,
      fromCache: false,
      syncedAt: null,
      syncFailed: false,
    })
  }, [])

  const start = useCallback(
    (host: SavedHost, key: KeyPair, adopt?: Paired) => {
      const mine = ++generation.current
      fresh.current = false
      clearLists()
      const saved = () => getHost().computers.hosts.find((h) => h.id === host.id) ?? host
      setHost({
        unreachable: false,
        state: { kind: 'connecting' },
        ready: { host, key, link: linkTo(host, key, adopt, saved) },
        phase: 'ready',
      })
      void readLists(host.id).then((cached) => {
        if (!cached || mine !== generation.current || fresh.current) return
        setHost({
          sessions: new Map(cached.sessions.map((s) => [s.id, s])),
          agents: new Map(cached.agents.map((a) => [a.id, a])),
          projects: cached.projects,
          folders: cached.folders ?? [],
          loaded: true,
          fromCache: true,
          syncedAt: cached.savedAt,
        })
      })
    },
    [clearLists],
  )

  useEffect(() => {
    void (async () => {
      const [saved, key] = await Promise.all([loadComputers(), deviceKey()])
      keyRef.current = key
      setHost({ computers: saved })
      const active = saved.hosts.find((h) => h.id === saved.active)
      if (active) start(active, key)
      else setHost({ phase: 'pair' })
    })()
  }, [start])

  const refresh = useCallback(async () => {
    const link = getHost().ready?.link
    if (!link) return
    const mine = generation.current
    setHost({ syncFailed: false })
    try {
      const [list, agentList, projectList, folderList] = await withinRefreshLimit((signal) =>
        Promise.all([
          link.request('sessions.list', {}, signal) as Promise<SessionSummary[]>,
          link.request('agents.list', undefined, signal) as Promise<AgentStatus[]>,
          link.request('projects.list', undefined, signal) as Promise<Project[]>,
          readFolders(link, signal),
        ]),
      )
      if (mine !== generation.current) return
      fresh.current = true
      setHost((d) => ({
        sessions: reconcile(d.sessions, list),
        agents: reconcile(d.agents, agentList),
        projects: same(d.projects, projectList) ? d.projects : projectList,
        folders: same(d.folders, folderList) ? d.folders : folderList,
        loaded: true,
        fromCache: false,
        syncedAt: Date.now(),
        syncFailed: false,
      }))
    } catch (error) {
      if (mine === generation.current) setHost({ syncFailed: true })
      throw error
    }
  }, [])

  /** Forgets a computer here: its push keys, its cache, its place in the list. */
  const drop = useCallback(
    async (id: string, next: string | null) => {
      const gone = getHost().computers.hosts.find((h) => h.id === id)
      await stopPush(null, gone?.pushId ?? null)
      void clearComputer(id)
      dropDrafts(id)
      dropOutbox(id)
      const rest = getHost().computers.hosts.filter((h) => h.id !== id)
      if (getHost().computers.active !== id) {
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
      getHost().ready?.link.stop()
      setHost({ ready: null })
      clearLists()
      if (successor && keyRef.current) {
        start(successor, keyRef.current)
        if (next) Alert.alert('已解除配对', next)
      } else {
        setHost({ notice: next, phase: 'pair' })
      }
    },
    [update, clearLists, start],
  )

  const forget = useCallback(
    async (next: string | null) => {
      const id = getHost().computers.active
      if (id) await drop(id, next)
    },
    [drop],
  )

  const unpair = useCallback(
    async (id: string) => {
      const host = getHost().computers.hosts.find((h) => h.id === id)
      const key = keyRef.current
      if (!host || !key) return
      unpairing.current.add(id)
      const active = getHost().computers.active === id ? (getHost().ready?.link ?? null) : null
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
      const { computers } = getHost()
      const host = computers.hosts.find((h) => h.id === id)
      if (!host || !key || computers.active === id) return
      update((hosts) => hosts, id)
      start(host, key)
    },
    [update, start],
  )

  // Not connected for a while: the screens say so plainly instead of waiting on a spinner.
  useEffect(() => {
    if (stateKind === 'connected') {
      setHost({ unreachable: false })
      return
    }
    if (stateKind === 'stopped') {
      setHost({ unreachable: true })
      return
    }
    const timer = setTimeout(() => setHost({ unreachable: true }), UNREACHABLE_AFTER)
    return () => clearTimeout(timer)
  }, [stateKind, ready, attempt])

  useEffect(() => {
    if (stateKind === 'connected') {
      setHost({ down: false })
      return
    }
    if (stateKind === 'stopped') {
      setHost({ down: true })
      return
    }
    const timer = setTimeout(() => setHost({ down: true }), DOWN_AFTER)
    return () => clearTimeout(timer)
  }, [stateKind, ready])

  /** In development: what last set off a reconnect and when, for the time it took. */
  const reconnecting = useRef<{ reason: string; at: number } | null>(null)

  /** Tries the computer now, the backoff starting over, as when the app comes to the front. */
  const wake = useCallback((reason: WakeReason) => {
    const link = getHost().ready?.link
    if (!link) return
    if (__DEV__ && link.state.kind !== 'connected') {
      reconnecting.current = { reason, at: Date.now() }
    }
    setHost({ unreachable: false })
    setAttempt((n) => n + 1)
    link.reconnectNow()
  }, [])

  const retry = useCallback(() => wake('retry'), [wake])

  // The lists go to the cache a moment after they settle, never while they are the cache's own.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let seen: HostData | null = null
    const check = () => {
      const d = getHost()
      if (
        seen &&
        d.ready === seen.ready &&
        d.loaded === seen.loaded &&
        d.fromCache === seen.fromCache &&
        d.sessions === seen.sessions &&
        d.agents === seen.agents &&
        d.projects === seen.projects &&
        d.folders === seen.folders
      )
        return
      seen = d
      if (timer) clearTimeout(timer)
      timer = null
      const activeId = d.ready?.host.id ?? null
      if (!activeId || !d.loaded || d.fromCache) return
      timer = setTimeout(() => {
        timer = null
        void writeLists(activeId, {
          savedAt: Date.now(),
          sessions: [...d.sessions.values()],
          agents: [...d.agents.values()],
          projects: d.projects,
          folders: d.folders,
        })
      }, 1500)
    }
    const off = subscribe(check)
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const { link } = ready
    const id = ready.host.id
    let wasConnected = false
    const offState = link.onState((next) => {
      setHost({ state: next })
      if (next.kind === 'connected') {
        wasConnected = true
        const { welcome } = next
        const saved = getHost().computers.hosts.find((h) => h.id === id)
        if (saved) {
          const addresses = welcome.addresses.length > 0 ? welcome.addresses : saved.addresses
          const reached = currentAddress()
          patchHost(id, {
            name: welcome.host.name,
            deviceName: welcome.device.name,
            platform: welcome.host.platform,
            addresses,
            ...(welcome.relay ? { relay: welcome.relay } : {}),
            lastSeen: Date.now(),
            ...(reached ? { lastAddress: reached } : {}),
          })
        }
        const woke = reconnecting.current
        reconnecting.current = null
        if (__DEV__ && woke) {
          console.log(`[link] reconnected in ${Date.now() - woke.at} ms (${woke.reason})`)
        }
        void refresh().catch(() => {})
      } else if (wasConnected) {
        // The lists were current until now: that is when they were last in step.
        wasConnected = false
        setHost({ syncedAt: Date.now() })
        patchHost(id, { lastSeen: Date.now() })
        if (__DEV__) reconnecting.current = { reason: 'drop', at: Date.now() }
      }
      if (next.kind === 'stopped' && next.reason === 'removed' && !unpairing.current.has(id)) {
        const name = computerName(getHost().computers.hosts.find((h) => h.id === id))
        void drop(id, `「${name}」已在电脑上移除这台手机，要用它请重新配对。`)
      }
    })
    const offEvents = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      switch (event.type) {
        case 'session.summary':
          setHost((d) => ({ sessions: withItem(d.sessions, event.summary) }))
          break
        case 'session.removed':
          void dropThread(id, event.sessionId)
          setHost((d) => {
            if (!d.sessions.has(event.sessionId)) return {}
            const next = new Map(d.sessions)
            next.delete(event.sessionId)
            return { sessions: next }
          })
          break
        case 'agent.status':
          setHost((d) => ({ agents: withItem(d.agents, event.status) }))
          break
        case 'agent.removed':
          setHost((d) => {
            if (!d.agents.has(event.agentId)) return {}
            const next = new Map(d.agents)
            next.delete(event.agentId)
            return { agents: next }
          })
          // A harness's default agent comes back as an entry of the catalog, which only the
          // list says.
          void refresh().catch(() => {})
          break
        case 'projects.changed':
          setHost((d) => (same(d.projects, event.projects) ? {} : { projects: event.projects }))
          break
        case 'folders.changed':
          setHost((d) => (same(d.folders, event.folders) ? {} : { folders: event.folders }))
          break
        case 'agents.limitAlert':
          showLimitAlert(event.alert)
          break
      }
    })
    // Back in front, on a new network or with a notification, the computer is tried at once
    // rather than when the backoff says.
    const offWakeups = watchWakeups(wake)
    link.start()
    return () => {
      offState()
      offEvents()
      offWakeups()
      link.stop()
    }
  }, [ready, refresh, drop, patchHost, wake])

  const paired = useCallback(
    async (host: SavedHost, key: KeyPair, adopt: Paired) => {
      keyRef.current = key
      const before = getHost().computers.hosts.find((h) => h.id === host.id)
      const saved: SavedHost = {
        ...host,
        ...(before?.label ? { label: before.label } : {}),
        ...(before?.pushId ? { pushId: before.pushId } : {}),
      }
      update(
        (hosts) => (before ? hosts.map((h) => (h.id === host.id ? saved : h)) : [...hosts, saved]),
        host.id,
      )
      setHost({ notice: null })
      start(saved, key, adopt)
    },
    [update, start],
  )

  const actions = useMemo<HostActions>(
    () => ({
      retry,
      paired,
      forget,
      unpair,
      switchTo,
      rename: (id, label) => patchHost(id, { label: label?.trim() || undefined }),
      setRoute: (id, route) => {
        patchHost(id, { route: route ?? undefined })
        const ready = getHost().ready
        if (ready?.host.id === id) ready.link.reroute()
      },
      refresh,
      renamedDevice: (name) => {
        const active = getHost().computers.active
        if (active) patchHost(active, { deviceName: name })
      },
      notePushId: (pushId) => {
        const id = getHost().computers.active
        if (!id) return
        const known = getHost().computers.hosts.find((h) => h.id === id)
        if (known?.pushId === pushId) return
        update((hosts) =>
          hosts.map((h) =>
            h.id === id ? { ...h, pushId } : h.pushId === pushId ? { ...h, pushId: undefined } : h,
          ),
        )
      },
    }),
    [retry, paired, forget, unpair, switchTo, patchHost, refresh, update],
  )
  return <ActionsContext.Provider value={actions}>{props.children}</ActionsContext.Provider>
}

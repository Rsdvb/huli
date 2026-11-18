// 全部电脑: while home shows every paired computer, the computers other than the active one each get
// a light link of their own, which reads only their session lists, projects and folders and keeps
// them current by their events. Nothing else goes over it: no threads, no push, no watches. The
// active computer keeps its full link (host.tsx). What each one listed last is kept in its cache
// (cache.ts), so a computer that cannot be reached still shows what it had, marked offline.

import { useCallback, useEffect } from 'react'
import type { AgentStatus, HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { KeyPair } from '@shared/remote/noise'
import type { SessionFolder } from '@shared/session-folders'
import { readLists, writeLists } from './cache'
import { deviceKey, linkTo } from './connection'
import { getHost, readFolders, UNREACHABLE_AFTER } from './host'
import { createStore, useSelector } from './select'
import type { SavedHost } from './store'

export type FleetState = 'connecting' | 'connected' | 'offline'

export interface FleetComputer {
  id: string
  state: FleetState
  sessions: ReadonlyMap<string, SessionSummary>
  projects: Project[]
  folders: SessionFolder[]
  /** Something to show: the computer's answer or its cache. */
  loaded: boolean
}

const store = createStore<ReadonlyMap<string, FleetComputer>>(new Map())

interface Running {
  link: HostLink | null
  stop(): void
}

const running = new Map<string, Running>()
let key: Promise<KeyPair> | null = null

function patch(id: string, change: Partial<FleetComputer>): void {
  store.set((was) => {
    const old = was.get(id)
    if (!old) return was
    return new Map(was).set(id, { ...old, ...change })
  })
}

function start(host: SavedHost): void {
  const id = host.id
  let stopped = false
  let fresh = false
  let agents: AgentStatus[] = []
  let offTimer: ReturnType<typeof setTimeout> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const offs: (() => void)[] = []
  const entry: Running = {
    link: null,
    stop() {
      stopped = true
      if (offTimer) clearTimeout(offTimer)
      if (saveTimer) clearTimeout(saveTimer)
      for (const off of offs) off()
      entry.link?.stop()
      store.set((was) => {
        if (!was.has(id)) return was
        const next = new Map(was)
        next.delete(id)
        return next
      })
    },
  }
  running.set(id, entry)
  store.set((was) =>
    new Map(was).set(id, {
      id,
      state: 'connecting',
      sessions: new Map(),
      projects: [],
      folders: [],
      loaded: false,
    }),
  )

  const save = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const now = store.get().get(id)
      if (!now || stopped) return
      void writeLists(id, {
        savedAt: Date.now(),
        sessions: [...now.sessions.values()],
        agents,
        projects: now.projects,
        folders: now.folders,
      })
    }, 1500)
  }

  void readLists(id).then((cached) => {
    if (!cached || stopped) return
    agents = cached.agents
    if (fresh) return
    patch(id, {
      sessions: new Map(cached.sessions.map((s) => [s.id, s])),
      projects: cached.projects,
      folders: cached.folders ?? [],
      loaded: true,
    })
  })

  const refresh = async (link: HostLink) => {
    const [list, projects, folders] = await Promise.all([
      link.request('sessions.list', {}) as Promise<SessionSummary[]>,
      link.request('projects.list', undefined) as Promise<Project[]>,
      readFolders(link),
    ])
    if (stopped) return
    fresh = true
    patch(id, {
      sessions: new Map(list.map((s) => [s.id, s])),
      projects,
      folders,
      loaded: true,
    })
    save()
  }

  key ??= deviceKey()
  void key.then((k) => {
    if (stopped) return
    const saved = () => getHost().computers.hosts.find((h) => h.id === id) ?? host
    const link = linkTo(host, k, undefined, saved, true)
    entry.link = link
    const armOffline = () => {
      if (offTimer) clearTimeout(offTimer)
      offTimer = setTimeout(() => patch(id, { state: 'offline' }), UNREACHABLE_AFTER)
    }
    armOffline()
    offs.push(
      link.onState((state) => {
        if (state.kind === 'connected') {
          if (offTimer) clearTimeout(offTimer)
          offTimer = null
          patch(id, { state: 'connected' })
          void refresh(link).catch(() => {})
        } else if (state.kind === 'stopped') {
          patch(id, { state: 'offline' })
        } else if (store.get().get(id)?.state === 'connected') {
          patch(id, { state: 'connecting' })
          armOffline()
        }
      }),
      link.onHostEvent((raw) => {
        const event = raw as HostEvent
        const now = store.get().get(id)
        if (!now) return
        switch (event.type) {
          case 'session.summary':
            patch(id, { sessions: new Map(now.sessions).set(event.summary.id, event.summary) })
            save()
            break
          case 'session.removed': {
            if (!now.sessions.has(event.sessionId)) break
            const next = new Map(now.sessions)
            next.delete(event.sessionId)
            patch(id, { sessions: next })
            save()
            break
          }
          case 'projects.changed':
            patch(id, { projects: event.projects })
            save()
            break
          case 'folders.changed':
            patch(id, { folders: event.folders })
            save()
            break
        }
      }),
    )
    link.start()
  })
}

/** Links to the paired computers other than the active one while `on`, and to none otherwise. */
export function syncFleet(hosts: readonly SavedHost[], activeId: string | null, on: boolean): void {
  const wanted = on ? hosts.filter((h) => h.id !== activeId) : []
  for (const [id, entry] of running) {
    if (wanted.some((h) => h.id === id)) continue
    running.delete(id)
    entry.stop()
  }
  for (const host of wanted) if (!running.has(host.id)) start(host)
}

/** Tries every computer of the fleet again now, as a pull to refresh does. */
export function wakeFleet(): void {
  for (const entry of running.values()) entry.link?.reconnectNow()
}

/** A computer's light link while it is up, for an action on one of its sessions. */
export function fleetLink(computerId: string): HostLink | null {
  const link = running.get(computerId)?.link ?? null
  return link && link.state.kind === 'connected' ? link : null
}

const all = (value: ReadonlyMap<string, FleetComputer>) => value

/** The computers other than the active one, while home shows every computer. */
export function useFleet(): ReadonlyMap<string, FleetComputer> {
  return useSelector(store, all)
}

/** Keeps the fleet's links while `on` and the screen that asks is mounted. */
export function useFleetLinks(hosts: readonly SavedHost[], activeId: string | null, on: boolean) {
  const ids = hosts.map((h) => h.id).join(',')
  const sync = useCallback(
    () => syncFleet(getHost().computers.hosts, activeId, on),
    // The ids stand for the computers; a change of a computer's other fields is no reason to relink.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, activeId, on],
  )
  useEffect(() => {
    sync()
  }, [sync])
  useEffect(() => () => syncFleet([], null, false), [])
}

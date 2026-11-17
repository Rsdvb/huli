// A session folder's working tree changes, shared by the screens that show them: one watch on the
// computer per folder however many screens look, read again when it says the folder changed.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeviceResult,
  HostEvent,
  HostMethod,
  HostParams,
  SessionSummary,
} from '@shared/agent-host'
import type { ChangedFile, GitStatus } from '@shared/git'
import type { HostLink } from '@shared/remote/link'

export function call<M extends HostMethod>(
  link: HostLink,
  method: M,
  params: HostParams<M>,
): Promise<DeviceResult<M>> {
  return link.request(method, params) as Promise<DeviceResult<M>>
}

export function errorText(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : fallback
}

/** The folder a session works in: its worktree's when it has one, else its project's. */
export function sessionFolder(summary: Pick<SessionSummary, 'projectPath' | 'worktree'>): string {
  return summary.worktree ? summary.worktree.path : summary.projectPath
}

export interface Changes {
  status: GitStatus | null
  files: ChangedFile[] | null
  error: string | null
}

const EMPTY: Changes = { status: null, files: null, error: null }

interface Watch {
  link: HostLink
  folder: string
  users: number
  value: Changes
  listeners: Set<() => void>
  reading: boolean
  again: boolean
  off: () => void
}

const watches = new WeakMap<HostLink, Map<string, Watch>>()

function publish(watch: Watch, value: Changes) {
  watch.value = value
  for (const listener of watch.listeners) listener()
}

async function read(watch: Watch): Promise<void> {
  if (watch.reading) {
    watch.again = true
    return
  }
  watch.reading = true
  try {
    do {
      watch.again = false
      // `git.status` also keeps the folder watched for this phone, for `git.changed`.
      const status = await call(watch.link, 'git.status', { projectPath: watch.folder })
      const files = status.repo
        ? await call(watch.link, 'git.changes', { projectPath: watch.folder })
        : []
      if (watch.users > 0) publish(watch, { status, files, error: null })
    } while (watch.again && watch.users > 0)
  } catch (error) {
    if (watch.users > 0) publish(watch, { ...watch.value, error: errorText(error, '读不到改动') })
  } finally {
    watch.reading = false
  }
}

function acquire(link: HostLink, folder: string): Watch {
  let byFolder = watches.get(link)
  if (!byFolder) {
    byFolder = new Map()
    watches.set(link, byFolder)
  }
  const existing = byFolder.get(folder)
  if (existing) {
    existing.users++
    return existing
  }
  const watch: Watch = {
    link,
    folder,
    users: 1,
    value: EMPTY,
    listeners: new Set(),
    reading: false,
    again: false,
    off: () => {},
  }
  byFolder.set(folder, watch)
  let connected = false
  const offState = link.onState((state) => {
    const now = state.kind === 'connected'
    // A new connection is a new port on the computer, which watches nothing yet.
    if (now && !connected) void read(watch)
    connected = now
  })
  const offEvents = link.onHostEvent((raw) => {
    const event = raw as HostEvent
    if (event.type !== 'git.changed') return
    // The computer names the folder as it resolved it, which may differ from the session's path.
    if (event.status.projectPath !== watch.value.status?.projectPath) return
    publish(watch, { ...watch.value, status: event.status })
    void read(watch)
  })
  watch.off = () => {
    offState()
    offEvents()
  }
  return watch
}

function release(watch: Watch) {
  if (--watch.users > 0) return
  watch.off()
  watch.listeners.clear()
  watches.get(watch.link)?.delete(watch.folder)
  void watch.link.request('git.unwatch', { projectPath: watch.folder }).catch(() => {})
}

/** The folder's changes while the calling screen shows; null folder: none to watch. */
export function useChanges(link: HostLink, folder: string | null): Changes & { reload(): void } {
  const [value, setValue] = useState<Changes>(EMPTY)
  const current = useRef<Watch | null>(null)
  useEffect(() => {
    setValue(EMPTY)
    if (!folder) return
    const watch = acquire(link, folder)
    current.current = watch
    const update = () => setValue(watch.value)
    watch.listeners.add(update)
    update()
    return () => {
      watch.listeners.delete(update)
      current.current = null
      release(watch)
    }
  }, [link, folder])
  const reload = useCallback(() => {
    if (current.current) void read(current.current)
  }, [])
  return { ...value, reload }
}

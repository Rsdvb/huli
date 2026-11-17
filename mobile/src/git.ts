// A session folder's working tree changes, shared by the screens that show them: one watch on the
// computer per folder however many screens look, read again when it says the folder changed. Also
// the git writes the changes screen runs, one at a time per folder, and what it reads beside them.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeviceResult,
  HostEvent,
  HostMethod,
  HostParams,
  SessionSummary,
} from '@shared/agent-host'
import type { ChangedFile, GitOperation, GitStatus, GitTools, PullRequest } from '@shared/git'
import type { HostLink } from '@shared/remote/link'
import type { GitKind, GitRequest } from './gitRules'

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

/** Hands a status a write returned to the screens watching its folder, and reads its files. */
function receive(link: HostLink, folder: string, status: GitStatus) {
  const watch = watches.get(link)?.get(folder)
  if (!watch) return
  publish(watch, { ...watch.value, status })
  void read(watch)
}

// The writes running now, by folder, so every screen of the folder shows the same one.
const running = new Map<string, GitKind>()
const runningListeners = new Set<() => void>()

function setRunning(folder: string, kind: GitKind | null) {
  if (kind) running.set(folder, kind)
  else running.delete(folder)
  for (const listener of runningListeners) listener()
}

/** The write running in the folder now, or null. */
export function useGitRunning(folder: string | null): GitKind | null {
  const [kind, setKind] = useState<GitKind | null>(folder ? (running.get(folder) ?? null) : null)
  useEffect(() => {
    const update = () => setKind(folder ? (running.get(folder) ?? null) : null)
    update()
    runningListeners.add(update)
    return () => {
      runningListeners.delete(update)
    }
  }, [folder])
  return kind
}

function send(link: HostLink, projectPath: string, request: GitRequest): Promise<GitOperation> {
  switch (request.kind) {
    case 'fetch':
      return call(link, 'git.fetch', { projectPath })
    case 'pull':
      return call(link, 'git.pull', { projectPath })
    case 'push':
      return call(link, 'git.push', { projectPath, remote: request.remote, branch: request.branch })
    case 'publishBranch':
      return call(link, 'git.publishBranch', { projectPath, remote: request.remote })
    case 'publishRepo':
      return call(link, 'git.publish', {
        projectPath,
        name: request.name,
        visibility: request.visibility,
      })
    case 'switch':
      return call(link, 'git.switchBranch', {
        projectPath,
        branch: request.branch,
        create: request.create,
      })
    case 'commit':
      return call(link, 'git.commitChanges', {
        projectPath,
        message: request.message,
        paths: request.paths,
      })
    case 'discard':
      return call(link, 'git.discardChanges', { projectPath, paths: request.paths })
  }
}

export type GitResult =
  { ok: true; operation: GitOperation } | { ok: false; log: string; busy: boolean }

/** Runs a write in the folder, one at a time per folder, as the desktop's git store does. */
export async function runGit(
  link: HostLink,
  folder: string,
  request: GitRequest,
): Promise<GitResult> {
  if (running.has(folder)) return { ok: false, log: '此仓库正在执行另一个 git 操作。', busy: true }
  setRunning(folder, request.kind)
  try {
    const operation = await send(link, folder, request)
    receive(link, folder, operation.status)
    return { ok: true, operation }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return { ok: false, log: errorText(error, ''), busy: code === 'busy' }
  } finally {
    setRunning(folder, null)
  }
}

const tools = new WeakMap<HostLink, Promise<GitTools>>()

/** Whether git and the GitHub CLI are usable on the computer, read once per connection. */
export function useGitTools(link: HostLink, connected: boolean): GitTools | null {
  const [value, setValue] = useState<GitTools | null>(null)
  useEffect(() => {
    if (!connected) return
    let live = true
    let asked = tools.get(link)
    if (!asked) {
      asked = call(link, 'git.tools', undefined)
      tools.set(link, asked)
      asked.catch(() => tools.delete(link))
    }
    asked.then(
      (read) => live && setValue(read),
      () => {},
    )
    return () => {
      live = false
    }
  }, [link, connected])
  return value
}

export interface CurrentPr {
  pr: PullRequest | null
  loading: boolean
  error: string | null
  reload(): void
  /** Shows a pull request just created, before the next read. */
  set(pr: PullRequest): void
}

/**
 * The pull request of the folder's branch, read again when the branch or its tip changes; only
 * for a repository on GitHub.
 */
export function useCurrentPr(link: HostLink, status: GitStatus | null): CurrentPr {
  const folder = status?.projectPath ?? null
  const github = !!status?.remote?.github
  const key = `${status?.head.branch ?? ''}:${status?.head.oid ?? ''}:${status?.upstream?.name ?? ''}`
  const [state, setState] = useState<{
    pr: PullRequest | null
    loading: boolean
    error: string | null
  }>({ pr: null, loading: false, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!folder || !github) {
      setState({ pr: null, loading: false, error: null })
      return
    }
    let live = true
    setState((was) => ({ ...was, loading: true, error: null }))
    call(link, 'git.currentPullRequest', { projectPath: folder }).then(
      (pr) => live && setState({ pr, loading: false, error: null }),
      (error: unknown) =>
        live &&
        setState((was) => ({
          ...was,
          loading: false,
          error: errorText(error, '无法加载这个 Pull Request。'),
        })),
    )
    return () => {
      live = false
    }
  }, [link, folder, github, key, attempt])
  return {
    ...state,
    reload: () => setAttempt((n) => n + 1),
    set: (pr) => setState({ pr, loading: false, error: null }),
  }
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

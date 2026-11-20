// A project's files as the phone reads them with `files.list`: kept for a short while per folder,
// so the mention menu and the file browser share one read, and matched by name for a search.

import { useCallback, useEffect, useState } from 'react'
import type { FileList } from '@shared/files'
import type { HostLink } from '@shared/remote/link'
import { call, errorText } from './git'

const KEEP_MS = 60_000

const kept = new WeakMap<HostLink, Map<string, { at: number; list: Promise<FileList> }>>()

/** The folder's files, read again once the kept list is a minute old or `fresh` asks. */
export function readFiles(link: HostLink, folder: string, fresh = false): Promise<FileList> {
  let byFolder = kept.get(link)
  if (!byFolder) kept.set(link, (byFolder = new Map()))
  const known = byFolder.get(folder)
  if (known && !fresh && Date.now() - known.at < KEEP_MS) return known.list
  const list = call(link, 'files.list', { projectPath: folder })
  byFolder.set(folder, { at: Date.now(), list })
  list.catch(() => byFolder.delete(folder))
  return list
}

export interface ProjectFiles {
  list: FileList | null
  error: string | null
  reload(): void
}

export function useProjectFiles(
  link: HostLink,
  folder: string | null,
  enabled: boolean,
): ProjectFiles {
  const [list, setList] = useState<FileList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!enabled || !folder) return
    let live = true
    setError(null)
    readFiles(link, folder, round > 0).then(
      (next) => live && setList(next),
      (failed: unknown) => live && setError(errorText(failed, '没能读取项目的文件。')),
    )
    return () => {
      live = false
    }
  }, [link, folder, enabled, round])

  const reload = useCallback(() => setRound((n) => n + 1), [])
  return { list: folder ? list : null, error, reload }
}

/**
 * The paths whose name or path holds the query, names that start with it first. `lowered`, the
 * paths in lower case in the same order, spares a long list lowering every path on each keystroke.
 */
export function matchFiles(
  paths: readonly string[],
  query: string,
  limit = 40,
  lowered?: readonly string[],
): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const scored: { path: string; score: number }[] = []
  for (const [at, path] of paths.entries()) {
    const lower = lowered?.[at] ?? path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = name.startsWith(needle)
      ? 0
      : name.includes(needle)
        ? 1
        : lower.includes(needle)
          ? 2
          : -1
    if (score >= 0) scored.push({ path, score })
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
    )
    .slice(0, limit)
    .map((each) => each.path)
}

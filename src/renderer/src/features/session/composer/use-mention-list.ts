import { useDeferredValue, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadState } from '@shared/thread'
import { loadFiles, useFilesStore, watchFiles, type ProjectFiles } from '@renderer/stores/files'
import { useFurtherFolders } from '@renderer/stores/projects'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  foldersOf,
  joinedFiles,
  matchMentions,
  usedFiles,
  withRoots,
  type MentionRoot,
  type MentionRow,
} from './mentions'

export interface MentionList {
  rows: MentionRow[]
  /** Nothing is typed, so the rows are the files the session used. */
  used: boolean
  files: ProjectFiles | undefined
  /** No project is chosen yet, as on New session, so there are no files to mention. */
  noProject: boolean
}

const NO_PATHS: string[] = []
const NO_ROWS: MentionRow[] = []
const NO_FILES: (ProjectFiles | undefined)[] = []

const usedCache = new WeakMap<
  ThreadState,
  { projectPath: string; known: ReadonlySet<string>; used: string[] }
>()

/** The used files, worked out again only when this session's thread changes. */
function usedIn(
  thread: ThreadState | null | undefined,
  projectPath: string,
  known: ReadonlySet<string>,
): string[] {
  if (!thread) return NO_PATHS
  const hit = usedCache.get(thread)
  if (hit && hit.projectPath === projectPath && hit.known === known) return hit.used
  const used = usedFiles(thread, projectPath, known)
  usedCache.set(thread, { projectPath, known, used })
  return used
}

/**
 * The rows for a mention's query, or none while no mention is typed. The project's files are
 * listed again as each mention starts, and while it is open, so files made since show up.
 */
export function useMentionList(
  sessionId: string,
  projectPath: string | null,
  query: string | null,
): MentionList {
  const active = query !== null && projectPath !== null
  useEffect(() => {
    if (!active) return
    void loadFiles(projectPath)
    return watchFiles(projectPath)
  }, [active, projectPath])
  const files = useFilesStore((s) => (active ? s.byProject[projectPath] : undefined))
  // Huli: a project's further folders are listed too, only while a mention is open.
  const folders = useFurtherFolders(projectPath)
  const roots = useMemo<MentionRoot[]>(
    () =>
      folders
        .filter((folder) => !folder.missing)
        .map((folder) => ({ path: folder.path, name: folder.name })),
    [folders],
  )
  const rootKey = roots.map((root) => root.path).join('\n')
  useEffect(() => {
    if (!active || rootKey === '') return
    const stops = rootKey.split('\n').map((root) => {
      void loadFiles(root)
      return watchFiles(root)
    })
    return () => stops.forEach((stop) => stop())
  }, [active, rootKey])
  const furtherFiles = useFilesStore(
    useShallow((s) => (active ? roots.map((root) => s.byProject[root.path]) : NO_FILES)),
  )
  const joined = useMemo(() => {
    if (!files || roots.length === 0) return null
    return joinedFiles(
      files.paths,
      roots.map((root, i) => ({ root, paths: furtherFiles[i]?.paths ?? NO_PATHS })),
    )
  }, [files, roots, furtherFiles])
  // Matching tens of thousands of paths can trail the typing rather than hold it up; the rows
  // shown are always those of the query they were matched for.
  const typed = useDeferredValue(query)
  const used = useThreadsStore(
    useShallow((s) =>
      typed === '' && files && projectPath
        ? usedIn(s.replicas[sessionId]?.state, projectPath, files.known)
        : NO_PATHS,
    ),
  )
  const matched = useMemo(() => {
    if (!files || !typed) return NO_ROWS
    if (!joined) return matchMentions(typed, files.paths, foldersOf(files.paths))
    const rows = matchMentions(typed, joined.paths, foldersOf(joined.paths))
    return withRoots(rows, joined.roots, new Set(foldersOf(files.paths)), roots)
  }, [files, typed, joined, roots])
  const usedRows = useMemo(
    () => used.map((path) => ({ path, folder: false, positions: [] })),
    [used],
  )
  // The same object while nothing changed, so the composer can tell when the list did.
  const noProject = projectPath === null
  return useMemo(() => {
    if (typed === null || noProject) return { rows: NO_ROWS, used: false, files, noProject }
    return typed === ''
      ? { rows: usedRows, used: true, files, noProject }
      : { rows: matched, used: false, files, noProject }
  }, [typed, usedRows, matched, files, noProject])
}

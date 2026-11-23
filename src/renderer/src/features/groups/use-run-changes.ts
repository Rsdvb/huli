import { useEffect } from 'react'
import { create } from 'zustand'
import type { GitStatus } from '@shared/git'
import type { RunChanges } from '@shared/run-groups'
import { errorMessage, host } from '@renderer/lib/host'
import { useGitStore } from '@renderer/stores/git'

/** What a status read changes when the run's folder changes, so its stats are read again. */
function statusKey(status: GitStatus | undefined): string {
  if (!status) return ''
  const { head, changes } = status
  return [
    head.oid,
    changes.staged,
    changes.unstaged,
    changes.untracked,
    changes.insertions,
    changes.deletions,
  ].join(':')
}

export interface ChangesState {
  changes: RunChanges | null
  error: string | null
}

const NOTHING_YET: ChangesState = { changes: null, error: null }

// The latest read of each run's changes, shared by its card and its file list, and what that read
// was asked for, so two views of one run send one request and an older answer never wins.
const useChangesStore = create<{ byId: Record<string, ChangesState> }>(() => ({ byId: {} }))
const asked = new Map<string, string>()

function settle(sessionId: string, want: string, next: (was: ChangesState) => ChangesState): void {
  if (asked.get(sessionId) !== want) return
  useChangesStore.setState((s) => ({
    byId: { ...s.byId, [sessionId]: next(s.byId[sessionId] ?? NOTHING_YET) },
  }))
}

/**
 * Huli: a run's changes against its base, read when asked: once shown, again after each git status
 * event of its worktree that changed something and when its phase changes. Nothing is read while
 * the worktree stands still.
 */
export function useRunChanges(
  sessionId: string,
  worktreePath: string | null,
  phase: string,
): ChangesState {
  const key = useGitStore((s) => (worktreePath ? statusKey(s.status[worktreePath]) : ''))
  const want = `${worktreePath ?? ''}|${key}|${phase}`
  useEffect(() => {
    if (!worktreePath || asked.get(sessionId) === want) return
    asked.set(sessionId, want)
    host('groups.changes', { sessionId }).then(
      (changes) => settle(sessionId, want, () => ({ changes, error: null })),
      (error: unknown) =>
        settle(sessionId, want, (was) => ({ changes: was.changes, error: errorMessage(error) })),
    )
  }, [sessionId, worktreePath, want])
  return useChangesStore((s) => s.byId[sessionId] ?? NOTHING_YET)
}

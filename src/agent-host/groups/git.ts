// Huli: the git that keeping a best-of-N run needs beyond worktrees: what a checkout has not
// committed, whether it is amid an operation, committing a run's last changes to its branch, and a
// merge into the project's own checkout that undoes itself when it conflicts.

import { describeFailure, GIT_TIMEOUT_MS, type Exec, type ExecResult } from '../git/exec'

const MERGE_TIMEOUT_MS = 120_000
const MAX_LISTED = 20

export type GroupMerge =
  { merged: true; commit: string } | { merged: false; conflicts: string[]; error: string | null }

export interface GroupGit {
  /** The branch checked out, or null when HEAD is detached or unborn. */
  branch(cwd: string): Promise<string | null>
  /** Tracked files with changes, staged or not, at most 20; untracked files are left out. */
  trackedChanges(cwd: string): Promise<string[]>
  /** Whether anything is changed, staged or untracked. */
  anyChanges(cwd: string): Promise<boolean>
  /** A merge, rebase, cherry-pick or revert waits to be finished, or files are in conflict. */
  busy(cwd: string): Promise<boolean>
  /** Commits everything changed, staged or untracked, as one commit on the branch checked out. */
  commitAll(cwd: string, message: string): Promise<void>
  /** Commits on `branch` that `base` does not have. */
  commitsSince(cwd: string, base: string, branch: string): Promise<number>
  /** Merges `branch` into what `cwd` has checked out as a commit of its own; a conflict is undone. */
  merge(cwd: string, branch: string, message: string): Promise<GroupMerge>
}

function ok(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

function porcelainPaths(stdout: string): string[] {
  const fields = stdout.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length <= 3) continue
    paths.push(field.slice(3))
    // A rename or copy is followed by the path it came from.
    if (field[0] === 'R' || field[0] === 'C') i++
  }
  return paths
}

/** Only branches Kettu named reach here; one that could read as an option is refused anyway. */
function checkBranch(branch: string): string {
  if (branch === '' || branch.startsWith('-') || branch.includes('\0')) {
    throw new Error(`Not a branch name: ${branch}`)
  }
  return branch
}

export function createGroupGit(exec: Exec): GroupGit {
  const git = (cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) =>
    exec('git', args, { cwd, timeoutMs })
  const fail = (what: string, result: ExecResult): Error =>
    new Error(`${what} failed: ${describeFailure(result)}`)

  const conflicts = async (cwd: string): Promise<string[]> => {
    const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])
    if (!ok(result)) return []
    return result.stdout.split('\0').filter(Boolean).slice(0, MAX_LISTED)
  }
  const exists = async (cwd: string, ref: string): Promise<boolean> =>
    ok(await git(cwd, ['rev-parse', '--verify', '--quiet', ref]))

  return {
    async branch(cwd) {
      const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (!ok(result)) return null
      return (await exists(cwd, 'HEAD')) ? result.stdout.trim() || null : null
    },
    async trackedChanges(cwd) {
      const result = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
      if (!ok(result)) throw fail('git status', result)
      return porcelainPaths(result.stdout).slice(0, MAX_LISTED)
    },
    async anyChanges(cwd) {
      const result = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      if (!ok(result)) throw fail('git status', result)
      return porcelainPaths(result.stdout).length > 0
    },
    async busy(cwd) {
      const heads = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']
      const found = await Promise.all(heads.map((head) => exists(cwd, head)))
      if (found.some(Boolean)) return true
      return (await conflicts(cwd)).length > 0
    },
    async commitAll(cwd, message) {
      const added = await git(cwd, ['add', '--all', '--', '.'], MERGE_TIMEOUT_MS)
      if (!ok(added)) throw fail('git add', added)
      const committed = await git(cwd, ['commit', '--quiet', '-m', message], MERGE_TIMEOUT_MS)
      if (!ok(committed)) throw fail('git commit', committed)
    },
    async commitsSince(cwd, base, branch) {
      const result = await git(cwd, ['rev-list', '--count', `${base}..${checkBranch(branch)}`])
      if (!ok(result)) throw fail('git rev-list', result)
      return Number(result.stdout.trim()) || 0
    },
    async merge(cwd, branch, message) {
      const result = await git(
        cwd,
        ['merge', '--no-ff', '--no-edit', '-m', message, checkBranch(branch)],
        MERGE_TIMEOUT_MS,
      )
      if (ok(result)) {
        const head = await git(cwd, ['rev-parse', 'HEAD'])
        return { merged: true, commit: ok(head) ? head.stdout.trim() : '' }
      }
      const found = await conflicts(cwd)
      // A merge that stopped is undone, so the checkout is as it was before.
      if (found.length > 0 || (await exists(cwd, 'MERGE_HEAD'))) {
        const aborted = await git(cwd, ['merge', '--abort'], MERGE_TIMEOUT_MS)
        if (!ok(aborted)) throw fail('git merge --abort', aborted)
        return { merged: false, conflicts: found, error: null }
      }
      return { merged: false, conflicts: [], error: describeFailure(result) }
    },
  }
}

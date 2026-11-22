// Huli: a moved session's Git state. The source packs the branch's commits the target lacks, and
// its uncommitted changes as two commits made aside (the staged changes, then the working tree),
// into one bundle, without touching its own index, working tree or any branch, and without
// pushing anywhere; the temporary refs the bundle needs are gone as soon as it is written. The
// target unbundles it into its own clone, makes the branch and its worktree there, and puts the
// index and the working tree back as they were. Files .gitignore leaves out never move.

import { copyFile, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  MOVE_MAX_HAVES,
  withoutCredentials,
  type MoveGitPack,
  type MoveRemote,
} from '@shared/session-move'
import type { Platform } from '@shared/platform'
import { HostError } from '../errors'
import { describeFailure, type Exec, type ExecResult } from '../git/exec'
import { checkWorktreeBranch, folderNameFor, insideRoot } from '../worktrees/names'

const GIT_MS = 60_000
/** Writing a bundle, unbundling or checking out a large repository takes a while. */
const LONG_MS = 10 * 60_000
/** A clone runs as long as the network needs, within reason. */
export const CLONE_MS = 30 * 60_000
const MAX_SUFFIX = 100

/** Who the commits made aside are by: they only carry changes across and never reach a branch. */
const AUTHOR = {
  GIT_AUTHOR_NAME: 'Kite',
  GIT_AUTHOR_EMAIL: 'kite@localhost',
  GIT_COMMITTER_NAME: 'Kite',
  GIT_COMMITTER_EMAIL: 'kite@localhost',
}

function ok(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

function gitError(label: string, result: ExecResult): HostError {
  return new HostError('git_error', `${label}: ${describeFailure(result)}`)
}

export interface RepoFacts {
  top: string
  head: string
  branch: string | null
  /** The upstream's remote and its branch there, as `origin` and `feat`. */
  upstream: { remote: string; branch: string } | null
  remotes: MoveRemote[]
  changes: number
  operation: boolean
  submodules: boolean
  lfs: boolean
}

export type RepoInspection = RepoFacts | { problem: 'noGit' | 'noCommits' }

const git = (
  exec: Exec,
  cwd: string,
  args: string[],
  timeoutMs = GIT_MS,
  env?: NodeJS.ProcessEnv,
) => exec('git', args, { cwd, timeoutMs, ...(env ? { env } : {}) })

async function must(exec: Exec, cwd: string, args: string[], label: string, timeoutMs = GIT_MS) {
  const result = await git(exec, cwd, args, timeoutMs)
  if (!ok(result)) throw gitError(label, result)
  return result.stdout
}

/** The remotes' fetch URLs, without the passwords or tokens an HTTPS URL may hold. */
export async function remotesOf(exec: Exec, cwd: string): Promise<MoveRemote[]> {
  const result = await git(exec, cwd, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  // No remote at all exits with 1.
  if (result.failure === null && result.code === 1) return []
  if (!ok(result)) throw gitError('git config', result)
  const remotes: MoveRemote[] = []
  for (const line of result.stdout.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    const key = line.slice(0, space)
    const url = line.slice(space + 1).trim()
    if (!key.startsWith('remote.') || !key.endsWith('.url') || url === '') continue
    const name = key.slice('remote.'.length, -'.url'.length)
    if (name !== '' && !remotes.some((remote) => remote.name === name)) {
      remotes.push({ name, url: withoutCredentials(url) })
    }
  }
  return remotes
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/** Changed, staged and untracked files, as `git status` counts them. */
async function changeCount(exec: Exec, cwd: string): Promise<number> {
  const out = await must(
    exec,
    cwd,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'git status',
  )
  const fields = out.split('\0')
  let count = 0
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field === '') continue
    count++
    if (field[0] === 'R' || field[0] === 'C') i++
  }
  return count
}

/** What the source's folder holds of Git, read only. */
export async function inspectRepo(exec: Exec, cwd: string): Promise<RepoInspection> {
  const top = await git(exec, cwd, ['rev-parse', '--show-toplevel'])
  if (!ok(top)) return { problem: 'noGit' }
  const head = await git(exec, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (!ok(head) || head.stdout.trim() === '') return { problem: 'noCommits' }
  const symbolic = await git(exec, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = ok(symbolic) ? symbolic.stdout.trim() || null : null
  let upstream: RepoFacts['upstream'] = null
  if (branch !== null) {
    const ref = await git(exec, cwd, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)',
      '--',
      `refs/heads/${branch}`,
    ])
    const [remote, merge] = ok(ref) ? ref.stdout.trim().split('\0') : []
    if (remote && merge?.startsWith('refs/heads/')) {
      upstream = { remote, branch: merge.slice('refs/heads/'.length) }
    }
  }
  const paths = await git(exec, cwd, [
    'rev-parse',
    '--git-path',
    'MERGE_HEAD',
    '--git-path',
    'rebase-merge',
    '--git-path',
    'rebase-apply',
    '--git-path',
    'CHERRY_PICK_HEAD',
    '--git-path',
    'REVERT_HEAD',
  ])
  const marks = ok(paths) ? paths.stdout.split('\n').filter((line) => line.trim() !== '') : []
  const found = await Promise.all(marks.map((mark) => exists(path.resolve(cwd, mark.trim()))))
  const root = top.stdout.trim()
  const attributes = await readFile(path.join(root, '.gitattributes'), 'utf8').catch(() => '')
  return {
    top: root,
    head: head.stdout.trim(),
    branch,
    upstream,
    remotes: await remotesOf(exec, cwd),
    changes: await changeCount(exec, cwd),
    operation: found.some(Boolean),
    submodules: await exists(path.join(root, '.gitmodules')),
    lfs: /filter=lfs/.test(attributes),
  }
}

/** The remote a move matches and clones from: the upstream's, else `origin`, else the first. */
export function chooseRemote(
  remotes: readonly MoveRemote[],
  upstream: string | null,
): MoveRemote | null {
  return (
    remotes.find((remote) => remote.name === upstream) ??
    remotes.find((remote) => remote.name === 'origin') ??
    remotes[0] ??
    null
  )
}

/** The commits a repository has at its branches' and remote branches' tips, for a pack to leave out. */
export async function tipsOf(exec: Exec, cwd: string): Promise<string[]> {
  const out = await must(
    exec,
    cwd,
    ['for-each-ref', '--format=%(objectname)', 'refs/remotes/', 'refs/heads/', 'refs/tags/'],
    'git for-each-ref',
  )
  const tips = [...new Set(out.split('\n').map((line) => line.trim()))].filter((oid) =>
    /^[0-9a-f]{40,64}$/.test(oid),
  )
  return tips.slice(0, MOVE_MAX_HAVES)
}

/** Those of `oids` this repository has as commits. */
async function present(exec: Exec, cwd: string, oids: readonly string[]): Promise<string[]> {
  if (oids.length === 0) return []
  const result = await git(exec, cwd, ['rev-list', '--no-walk', '--ignore-missing', ...oids])
  if (!ok(result)) return []
  const found = new Set(result.stdout.split('\n').map((line) => line.trim()))
  return oids.filter((oid) => found.has(oid))
}

export interface PackInput {
  cwd: string
  moveId: string
  /** Commits the target has: the bundle leaves them and what they reach out. */
  haves: readonly string[]
  /** Where the bundle goes, and a folder for the indexes made aside. */
  bundle: string
  scratch: string
  facts: Pick<RepoFacts, 'head' | 'branch' | 'upstream' | 'changes'>
}

/**
 * Writes the bundle of what the target lacks: the head's commits and, with uncommitted changes,
 * the two commits that hold them. Reads the index through copies, so the source's own index,
 * working tree and branches stay as they are; the refs the bundle names are removed again.
 */
export async function packRepo(exec: Exec, input: PackInput): Promise<MoveGitPack> {
  const { cwd, facts } = input
  const head = facts.head
  let wip: MoveGitPack['wip'] = null
  if (facts.changes > 0) {
    const index = path.resolve(
      cwd,
      (await must(exec, cwd, ['rev-parse', '--git-path', 'index'], 'git rev-parse')).trim(),
    )
    const staged = path.join(input.scratch, 'index-staged')
    const tree = path.join(input.scratch, 'index-tree')
    const hasIndex = await exists(index)
    for (const copy of [staged, tree]) {
      if (hasIndex) await copyFile(index, copy)
      else {
        const read = await git(exec, cwd, ['read-tree', head], GIT_MS, { GIT_INDEX_FILE: copy })
        if (!ok(read)) throw gitError('git read-tree', read)
      }
    }
    const writeTree = async (file: string): Promise<string> => {
      const result = await git(exec, cwd, ['write-tree'], LONG_MS, { GIT_INDEX_FILE: file })
      if (!ok(result)) throw gitError('git write-tree', result)
      return result.stdout.trim()
    }
    const stagedTree = await writeTree(staged)
    const added = await git(exec, cwd, ['add', '-A'], LONG_MS, { GIT_INDEX_FILE: tree })
    if (!ok(added)) throw gitError('git add', added)
    const workTree = await writeTree(tree)
    // Signing these would ask for a passphrase in the middle of a move; they are no one's work.
    const commit = async (treeOid: string, parent: string, message: string): Promise<string> => {
      const result = await git(
        exec,
        cwd,
        ['commit-tree', '--no-gpg-sign', treeOid, '-p', parent, '-m', message],
        GIT_MS,
        AUTHOR,
      )
      if (!ok(result)) throw gitError('git commit-tree', result)
      return result.stdout.trim()
    }
    const indexCommit = await commit(stagedTree, head, 'Kite move: staged changes')
    const treeCommit = await commit(workTree, indexCommit, 'Kite move: working tree')
    wip = { index: indexCommit, tree: treeCommit }
  }
  const prefix = `refs/kite-move/${input.moveId}`
  const refs = [{ name: `${prefix}/head`, oid: head }]
  if (wip) refs.push({ name: `${prefix}/wip`, oid: wip.tree })
  const made: string[] = []
  let bundled = false
  try {
    for (const ref of refs) {
      await must(exec, cwd, ['update-ref', ref.name, ref.oid], 'git update-ref')
      made.push(ref.name)
    }
    const exclude = await present(exec, cwd, input.haves)
    const result = await git(
      exec,
      cwd,
      [
        'bundle',
        'create',
        input.bundle,
        ...refs.map((ref) => ref.name),
        ...(exclude.length > 0 ? ['--not', ...exclude] : []),
      ],
      LONG_MS,
    )
    if (ok(result)) bundled = true
    else if (!/empty bundle/i.test(result.stderr)) throw gitError('git bundle', result)
  } finally {
    for (const name of made) {
      await git(exec, cwd, ['update-ref', '-d', name]).catch(() => undefined)
    }
  }
  return {
    head,
    branch: facts.branch,
    upstream: facts.upstream?.branch ?? null,
    wip,
    bundled,
  }
}

/** Clones `url` into a folder that is not there yet; the target's own sign-in reaches the remote. */
export async function cloneRepo(exec: Exec, url: string, folder: string): Promise<void> {
  const parent = path.dirname(folder)
  const result = await git(
    exec,
    parent,
    ['clone', '--no-recurse-submodules', '--', url, folder],
    CLONE_MS,
  )
  if (!ok(result)) throw gitError('git clone', result)
}

/** What the target's apply did, step by step, for an undo to take back. */
export type GitStep =
  | { kind: 'branch'; project: string; name: string; oid: string }
  | { kind: 'worktree'; project: string; folder: string }

export interface ApplyInput {
  /** The target's project: a clone made for this move, or one of its own. */
  project: string
  platform: Platform
  /** The folder the session works in there: a new worktree under `root`, or the clone itself. */
  mode: { kind: 'worktree'; root: string } | { kind: 'checkout' }
  bundle: string | null
  pack: MoveGitPack
  /** The target's remote for the repository, for the branch's upstream. */
  remote: string | null
  /** Each step, as soon as it is taken. */
  took(step: GitStep): void
}

export interface Applied {
  cwd: string
  branch: string
}

function fold(name: string, platform: Platform): string {
  return platform === 'darwin' || platform === 'win32' ? name.toLowerCase() : name
}

/** The branch's name there: its own, or the first of `-2`, `-3`, ... no branch there has. */
export function freeBranch(wanted: string, taken: ReadonlySet<string>, platform: Platform): string {
  const folded = new Set([...taken].map((name) => fold(name, platform)))
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`
    checkWorktreeBranch(name)
    if (!folded.has(fold(name, platform))) return name
  }
  throw new HostError('conflict', `Every name from ${wanted} to ${wanted}-${MAX_SUFFIX} is taken`)
}

async function isAncestor(exec: Exec, cwd: string, a: string, b: string): Promise<boolean> {
  const result = await git(exec, cwd, ['merge-base', '--is-ancestor', a, b])
  return ok(result)
}

/**
 * Brings the pack into the target's project: the bundle's objects, the branch at the source's
 * head in a new worktree (or checked out in a clone made for the move), then the index and the
 * working tree as the source had them.
 */
export async function applyRepo(exec: Exec, input: ApplyInput): Promise<Applied> {
  const { project, platform, pack } = input
  const longPaths = platform === 'win32' ? ['-c', 'core.longpaths=true'] : []
  if (pack.bundled) {
    if (input.bundle === null) throw new HostError('invalid_params', 'The move has no bundle')
    const verify = await git(exec, project, ['bundle', 'verify', '--quiet', input.bundle], LONG_MS)
    if (!ok(verify)) throw gitError('git bundle verify', verify)
    await must(exec, project, ['bundle', 'unbundle', input.bundle], 'git bundle unbundle', LONG_MS)
  }
  for (const oid of [pack.head, ...(pack.wip ? [pack.wip.index, pack.wip.tree] : [])]) {
    await must(exec, project, ['cat-file', '-e', `${oid}^{commit}`], 'git cat-file')
  }
  const listed = await must(
    exec,
    project,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    'git for-each-ref',
  )
  const taken = new Set(
    listed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const wanted = checkWorktreeBranch(pack.branch ?? `kite-moved-${pack.head.slice(0, 8)}`)
  let cwd = project
  let branch: string
  if (input.mode.kind === 'worktree') {
    branch = freeBranch(wanted, taken, platform)
    const root = input.mode.root
    let folder: string | null = null
    const base = folderNameFor(branch, platform)
    for (let n = 1; n <= MAX_SUFFIX && folder === null; n++) {
      const candidate = path.join(root, n === 1 ? base : `${base}-${n}`)
      if (!insideRoot(root, candidate, platform)) {
        throw new HostError('invalid_params', 'Worktree folder outside its root')
      }
      if (!(await exists(candidate))) folder = candidate
    }
    if (folder === null) throw new HostError('conflict', 'No free folder for the worktree')
    const added = await git(
      exec,
      project,
      [...longPaths, 'worktree', 'add', '-b', branch, '--', folder, pack.head],
      LONG_MS,
    )
    if (!ok(added)) {
      // A failed add can leave the branch behind.
      const made = await git(exec, project, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ])
      if (ok(made)) input.took({ kind: 'branch', project, name: branch, oid: pack.head })
      throw gitError('git worktree add', added)
    }
    input.took({ kind: 'branch', project, name: branch, oid: pack.head })
    input.took({ kind: 'worktree', project, folder })
    cwd = folder
  } else {
    // A clone made for the move: its own default branch may give way to the source's.
    const current = await git(exec, project, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const checkedOut = ok(current) ? current.stdout.trim() : null
    const reuse =
      checkedOut !== null &&
      fold(checkedOut, platform) === fold(wanted, platform) &&
      (await isAncestor(exec, project, 'HEAD', pack.head))
    branch = reuse ? checkedOut : freeBranch(wanted, taken, platform)
    const args = reuse
      ? [...longPaths, 'checkout', '-B', branch, pack.head]
      : [...longPaths, 'checkout', '-b', branch, pack.head]
    await must(exec, project, args, 'git checkout', LONG_MS)
    if (!reuse) input.took({ kind: 'branch', project, name: branch, oid: pack.head })
  }
  if (pack.wip) {
    await must(
      exec,
      cwd,
      [...longPaths, 'read-tree', '-u', '--reset', `${pack.wip.tree}^{tree}`],
      'git read-tree',
      LONG_MS,
    )
    await must(exec, cwd, ['read-tree', `${pack.wip.index}^{tree}`], 'git read-tree', LONG_MS)
    // Only refreshes what the index knows of the files; 1 says some differ, as they should.
    await git(exec, cwd, ['update-index', '-q', '--refresh'], LONG_MS)
  }
  if (pack.upstream && input.remote) {
    const tracking = `refs/remotes/${input.remote}/${pack.upstream}`
    const there = await git(exec, project, ['rev-parse', '--verify', '--quiet', tracking])
    if (ok(there)) {
      await git(exec, project, [
        'branch',
        `--set-upstream-to=${input.remote}/${pack.upstream}`,
        '--',
        branch,
      ])
    }
  }
  return { cwd, branch }
}

/** Takes one step of an apply back; false when it could not, which the undo reports. */
export async function undoGitStep(exec: Exec, step: GitStep): Promise<boolean> {
  if (step.kind === 'worktree') {
    const removed = await git(
      exec,
      step.project,
      ['worktree', 'remove', '--force', '--force', '--', step.folder],
      LONG_MS,
    )
    if (ok(removed)) return true
    await rm(step.folder, { recursive: true, force: true }).catch(() => undefined)
    const pruned = await git(exec, step.project, ['worktree', 'prune'])
    return ok(pruned) && !(await exists(step.folder))
  }
  // Only while it still points where the move put it: anything since is someone's work.
  const deleted = await git(exec, step.project, [
    'update-ref',
    '-d',
    `refs/heads/${step.name}`,
    step.oid,
  ])
  return ok(deleted)
}

// Huli: a moved session's Git state between two clones of one repository, as on two computers:
// the target gets the branch, the staged changes, the working tree's changes and the untracked
// files exactly; the source and the remote stay as they were, with nothing pushed.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { remoteKey, withoutCredentials } from '@shared/session-move'
import { createExec } from '../git/exec'
import {
  applyRepo,
  chooseRemote,
  cloneRepo,
  freeBranch,
  inspectRepo,
  packRepo,
  tipsOf,
  undoGitStep,
  type GitStep,
  type RepoFacts,
} from './git'

const PLATFORM = process.platform as Platform
const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}
const exec = createExec(() => ({ ...process.env, ...ENV })).exec

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
}

async function write(cwd: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
  await writeFile(path.join(cwd, file), text)
}

async function there(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

/** `git status` as the user reads it, sorted, so two clones compare. */
function status(cwd: string): string[] {
  return git(cwd, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .sort()
}

function refs(cwd: string): string {
  return git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)')
}

describe(
  'moving a session’s Git state',
  { timeout: PLATFORM === 'win32' ? 120_000 : 40_000 },
  () => {
    let dir: string
    let origin: string
    let source: string
    let target: string

    beforeEach(async () => {
      dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kite-move-git-')))
      origin = path.join(dir, 'origin.git')
      source = path.join(dir, 'source')
      target = path.join(dir, 'target')
      git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
      git(dir, 'clone', '-q', origin, 'source')
      await write(source, 'a.txt', 'one\n')
      await write(source, 'b.txt', 'two\n')
      await write(source, 'gone.txt', 'soon gone\n')
      await write(source, '.gitignore', 'secret.env\n')
      git(source, 'add', '.')
      git(source, 'commit', '-q', '-m', 'first')
      git(source, 'push', '-q', '-u', 'origin', 'main')
      git(dir, 'clone', '-q', origin, 'target')
      // The session's branch: pushed once, then two commits only the source has.
      git(source, 'checkout', '-q', '-b', 'feat/move')
      await write(source, 'a.txt', 'one\nfeat\n')
      git(source, 'commit', '-q', '-am', 'feat one')
      git(source, 'push', '-q', '-u', 'origin', 'feat/move')
      await write(source, 'c.txt', 'three\n')
      git(source, 'add', 'c.txt')
      git(source, 'commit', '-q', '-m', 'feat two')
      // Uncommitted: staged, then changed again; changed only; deleted; untracked; ignored.
      await write(source, 'b.txt', 'two\nstaged\n')
      git(source, 'add', 'b.txt')
      await write(source, 'b.txt', 'two\nstaged\nand more\n')
      await write(source, 'a.txt', 'one\nfeat\nunstaged\n')
      await rm(path.join(source, 'gone.txt'))
      await write(source, 'new/file.txt', 'untracked\n')
      await write(source, 'secret.env', 'TOKEN=x\n')
      git(target, 'fetch', '-q', 'origin')
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })

    async function pack(haves: string[]) {
      const facts = (await inspectRepo(exec, source)) as RepoFacts
      const scratch = path.join(dir, 'scratch')
      await mkdir(scratch, { recursive: true })
      const bundle = path.join(scratch, 'bundle')
      const packed = await packRepo(exec, {
        cwd: source,
        moveId: 'a'.repeat(32),
        haves,
        bundle,
        scratch,
        facts,
      })
      return { facts, packed, bundle }
    }

    it('reads what the source has, without its remote’s password', async () => {
      git(source, 'remote', 'add', 'mirror', 'https://user:ghp_secret@example.com/x/repo.git')
      const facts = await inspectRepo(exec, source)
      expect(facts).toMatchObject({
        branch: 'feat/move',
        upstream: { remote: 'origin', branch: 'feat/move' },
        changes: 4,
        operation: false,
      })
      const remotes = (facts as RepoFacts).remotes
      expect(remotes.find((remote) => remote.name === 'mirror')?.url).toBe(
        'https://example.com/x/repo.git',
      )
      expect(JSON.stringify(remotes)).not.toContain('ghp_secret')
      expect(chooseRemote(remotes, 'origin')?.name).toBe('origin')
      expect(await inspectRepo(exec, dir)).toEqual({ problem: 'noGit' })
    })

    it('moves the branch and every uncommitted change into a worktree, pushing nothing', async () => {
      const sourceStatus = status(source)
      const sourceRefs = refs(source)
      const originRefs = refs(origin)
      const { packed, bundle } = await pack(await tipsOf(exec, target))
      expect(packed.bundled).toBe(true)
      expect(packed.wip).not.toBeNull()
      expect(packed.upstream).toBe('feat/move')
      // The source is as it was: no ref left behind, the same index and files.
      expect(status(source)).toEqual(sourceStatus)
      expect(refs(source)).toBe(sourceRefs)

      const root = path.join(dir, 'target-worktrees')
      await mkdir(root)
      const steps: GitStep[] = []
      const applied = await applyRepo(exec, {
        project: target,
        platform: PLATFORM,
        mode: { kind: 'worktree', root },
        bundle,
        pack: packed,
        remote: 'origin',
        took: (step) => steps.push(step),
      })
      expect(applied.branch).toBe('feat/move')
      expect(path.dirname(applied.cwd)).toBe(root)
      expect(status(applied.cwd)).toEqual(sourceStatus)
      expect(await readFile(path.join(applied.cwd, 'b.txt'), 'utf8')).toBe(
        'two\nstaged\nand more\n',
      )
      expect(git(applied.cwd, 'show', ':b.txt')).toBe('two\nstaged\n')
      expect(await there(path.join(applied.cwd, 'new', 'file.txt'))).toBe(true)
      // Ignored files stay behind.
      expect(await there(path.join(applied.cwd, 'secret.env'))).toBe(false)
      expect(git(applied.cwd, 'rev-parse', 'HEAD').trim()).toBe(packed.head)
      expect(git(target, 'rev-parse', '--abbrev-ref', 'feat/move@{upstream}').trim()).toBe(
        'origin/feat/move',
      )
      // Nothing reached the remote.
      expect(refs(origin)).toBe(originRefs)
      expect(steps.map((step) => step.kind)).toEqual(['branch', 'worktree'])

      // Undone, the target is as before.
      for (const step of steps.toReversed()) expect(await undoGitStep(exec, step)).toBe(true)
      expect(await there(applied.cwd)).toBe(false)
      expect(git(target, 'branch', '--list', 'feat/move').trim()).toBe('')
    })

    it('clones from the remote and checks the branch out there', async () => {
      const clone = path.join(dir, 'fresh')
      await cloneRepo(exec, origin, clone)
      const { packed, bundle } = await pack(await tipsOf(exec, clone))
      const applied = await applyRepo(exec, {
        project: clone,
        platform: PLATFORM,
        mode: { kind: 'checkout' },
        bundle,
        pack: packed,
        remote: 'origin',
        took: () => {},
      })
      expect(applied.cwd).toBe(clone)
      expect(status(clone)).toEqual(status(source))
    })

    it('needs no bundle when the target has every commit and nothing is uncommitted', async () => {
      git(source, 'stash', '-q', '--include-untracked')
      git(source, 'push', '-q', 'origin', 'feat/move')
      git(target, 'fetch', '-q', 'origin')
      const { packed } = await pack(await tipsOf(exec, target))
      expect(packed).toMatchObject({ bundled: false, wip: null })
      const root = path.join(dir, 'w')
      await mkdir(root)
      const applied = await applyRepo(exec, {
        project: target,
        platform: PLATFORM,
        mode: { kind: 'worktree', root },
        bundle: null,
        pack: packed,
        remote: 'origin',
        took: () => {},
      })
      expect(status(applied.cwd)).toEqual([])
    })

    it('gives the branch another name when the target has one by its name', async () => {
      git(target, 'branch', 'feat/move', 'origin/main')
      const { packed, bundle } = await pack(await tipsOf(exec, target))
      const root = path.join(dir, 'w')
      await mkdir(root)
      const applied = await applyRepo(exec, {
        project: target,
        platform: PLATFORM,
        mode: { kind: 'worktree', root },
        bundle,
        pack: packed,
        remote: 'origin',
        took: () => {},
      })
      expect(applied.branch).toBe('feat/move-2')
      expect(freeBranch('x', new Set(['X', 'x-2']), 'win32')).toBe('x-3')
      expect(freeBranch('x', new Set(['X']), 'linux')).toBe('x')
    })

    it('refuses a bundle whose commits the target cannot connect to', async () => {
      const lonely = path.join(dir, 'lonely')
      await mkdir(lonely)
      git(lonely, 'init', '-q', '-b', 'main')
      await write(lonely, 'z.txt', 'z\n')
      git(lonely, 'add', '.')
      git(lonely, 'commit', '-q', '-m', 'z')
      // Packed against the target's tips, then applied where those commits are missing.
      const { packed, bundle } = await pack(await tipsOf(exec, target))
      await expect(
        applyRepo(exec, {
          project: lonely,
          platform: PLATFORM,
          mode: { kind: 'checkout' },
          bundle,
          pack: packed,
          remote: null,
          took: () => {},
        }),
      ).rejects.toThrow(/bundle verify/)
    })
  },
)

describe('remote URLs', () => {
  it('names one repository alike in its HTTPS, SSH and scp-like forms', () => {
    const key = 'github.com/owner/repo'
    expect(remoteKey('https://github.com/Owner/Repo.git')).toBe(key)
    expect(remoteKey('git@github.com:owner/repo.git')).toBe(key)
    expect(remoteKey('ssh://git@github.com:22/owner/repo')).toBe(key)
    expect(remoteKey('https://token@github.com/owner/repo/')).toBe(key)
    expect(remoteKey('C:\\repos\\x')).toBeNull()
    expect(remoteKey('/srv/git/x.git')).toBe('file:/srv/git/x.git')
  })

  it('drops passwords and tokens but keeps an SSH user', () => {
    expect(withoutCredentials('https://u:p@host/x.git')).toBe('https://host/x.git')
    expect(withoutCredentials('https://ghp_abc@host/x.git')).toBe('https://host/x.git')
    expect(withoutCredentials('ssh://git@host/x.git')).toBe('ssh://git@host/x.git')
    expect(withoutCredentials('git@host:x.git')).toBe('git@host:x.git')
  })
})

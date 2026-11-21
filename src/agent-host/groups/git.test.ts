import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readChangesSince, readFileDiffSince } from '../git/details'
import { createExec } from '../git/exec'
import { createGroupGit } from './git'

const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
}

// Keeping a run must never leave the project's own checkout half merged.
describe('createGroupGit', { timeout: 30_000 }, () => {
  const exec = createExec(() => ({ ...process.env, ...ENV })).exec
  const groupGit = createGroupGit(exec)
  let dir: string
  let main: string
  let run: string
  let base: string

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-groups-')))
    main = path.join(dir, 'main')
    run = path.join(dir, 'run')
    git(dir, 'init', '-q', '-b', 'main', 'main')
    await writeFile(path.join(main, 'a.txt'), 'one\ntwo\n')
    git(main, 'add', 'a.txt')
    git(main, 'commit', '-q', '-m', 'first')
    base = git(main, 'rev-parse', 'HEAD').trim()
    git(main, 'worktree', 'add', '-q', '-b', 'kettu/run', run, base)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads a run's committed, uncommitted and untracked changes against its base", async () => {
    await writeFile(path.join(run, 'a.txt'), 'one\nTWO\n')
    git(run, 'commit', '-q', '-am', 'edit')
    await writeFile(path.join(run, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(path.join(run, 'new.txt'), 'x\ny\n')
    const read = await readChangesSince(exec, run, base)
    expect(read.commits).toBe(1)
    expect(read.files).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified', insertions: 2, deletions: 1 },
      { path: 'new.txt', oldPath: null, status: 'untracked', insertions: 2, deletions: 0 },
    ])
    const diff = await readFileDiffSince(exec, run, base, 'a.txt', null)
    expect(diff).toMatchObject({ oldText: 'one\ntwo\n', newText: 'one\nTWO\nthree\n' })
    await expect(readChangesSince(exec, run, '--all')).rejects.toThrow()
    await expect(readFileDiffSince(exec, run, base, '../main/a.txt', null)).rejects.toThrow()
  })

  it('commits everything a run left, untracked files too, to its branch', async () => {
    expect(await groupGit.anyChanges(run)).toBe(true)
    await groupGit.commitAll(run, 'Fix it\n\nBest of N: Fake')
    expect(await groupGit.anyChanges(run)).toBe(false)
    expect(await groupGit.commitsSince(main, base, 'kettu/run')).toBe(2)
    expect(await groupGit.branch(run)).toBe('kettu/run')
  })

  it('counts tracked changes in the checkout and leaves untracked files out', async () => {
    await writeFile(path.join(main, 'junk.log'), 'x')
    expect(await groupGit.trackedChanges(main)).toEqual([])
    await writeFile(path.join(main, 'a.txt'), 'changed\n')
    expect(await groupGit.trackedChanges(main)).toEqual(['a.txt'])
    git(main, 'checkout', '--', 'a.txt')
    await rm(path.join(main, 'junk.log'))
  })

  it('undoes a merge that conflicts, so the checkout stays as it was', async () => {
    await writeFile(path.join(main, 'a.txt'), 'one\nother\n')
    git(main, 'commit', '-q', '-am', 'meanwhile')
    const head = git(main, 'rev-parse', 'HEAD').trim()
    const merge = await groupGit.merge(main, 'kettu/run', 'Keep')
    expect(merge).toEqual({ merged: false, conflicts: ['a.txt'], error: null })
    expect(git(main, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(await groupGit.busy(main)).toBe(false)
    expect(await readFile(path.join(main, 'a.txt'), 'utf8')).toBe('one\nother\n')
    git(main, 'reset', '-q', '--hard', base)
  })

  it('merges a run as a commit of its own', async () => {
    const merge = await groupGit.merge(main, 'kettu/run', 'Keep the run')
    expect(merge.merged).toBe(true)
    expect(git(main, 'log', '-1', '--format=%s%n%P').trim().split('\n')[0]).toBe('Keep the run')
    expect(await readFile(path.join(main, 'new.txt'), 'utf8')).toBe('x\ny\n')
    await expect(groupGit.merge(main, '--abort', 'x')).rejects.toThrow()
  })
})

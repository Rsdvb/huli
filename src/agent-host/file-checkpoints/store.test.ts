// Huli: Kite's own file checkpoints on real folders: what a restore puts back, what it leaves, what
// it refuses, and what goes when checkpoints are trimmed or a session is deleted.

import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { createGitRunner } from './git'
import { LIMITS } from './snapshot'
import { ChangedSincePreview, FileCheckpoints, KEEP } from './store'

const PLATFORM = process.platform as Platform
const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}
const SESSION = 'session-1'

let root: string
const runners: { stop(): void }[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'kite-checkpoints-')))
})

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.stop()
  await rm(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: { ...process.env, ...ENV },
    encoding: 'utf8',
  })
}

async function write(folder: string, file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(folder, file)), { recursive: true })
  await writeFile(path.join(folder, file), data)
}

async function there(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/** Every file under `folder` but `.git`, with its bytes. */
async function files(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), key)
      else out[key] = (await readFile(path.join(dir, entry.name))).toString('base64')
    }
  }
  await walk(folder, '')
  return out
}

function checkpoints(
  options: {
    limits?: Partial<typeof LIMITS>
    keep?: Partial<typeof KEEP>
    now?: () => number
  } = {},
) {
  const runner = createGitRunner(() => ({ ...process.env, ...ENV }), PLATFORM)
  runners.push(runner)
  return new FileCheckpoints({
    root: path.join(root, 'store'),
    run: runner.run,
    platform: PLATFORM,
    log: () => {},
    limits: { ...LIMITS, ...options.limits },
    keep: { ...KEEP, ...options.keep },
    ...(options.now ? { now: options.now } : {}),
  })
}

async function take(store: FileCheckpoints, entryId: string, folders: string[]): Promise<void> {
  const taking = store.begin(SESSION, entryId, folders)
  await taking.listed
  // Settles once the copying is done.
  await store.has(SESSION, entryId, folders)
}

async function repo(): Promise<string> {
  const folder = path.join(root, 'repo')
  await mkdir(folder)
  git(folder, 'init', '-q', '-b', 'main')
  await write(folder, 'a.txt', 'one\ntwo\nthree\n')
  await write(folder, 'b.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  await write(folder, 'c.txt', 'to be deleted\n')
  await write(folder, 'd.txt', 'to be renamed\n')
  await write(folder, 'dirty.txt', 'committed\n')
  await write(folder, 'crlf.txt', 'line one\r\nline two\r\n')
  await write(folder, '.gitignore', '*.log\n')
  git(folder, 'add', '-A')
  git(folder, 'commit', '-q', '-m', 'first')
  // The user's own work, never committed.
  await write(folder, 'dirty.txt', 'committed\nuser edit\n')
  await write(folder, 'untracked.txt', 'untracked\n')
  return folder
}

/** What an agent's turn did. */
async function agentTurn(folder: string): Promise<void> {
  await write(folder, 'a.txt', 'one\nTWO\nthree\nfour\n')
  await write(folder, 'b.bin', Buffer.from([9, 9, 0, 9]))
  await rm(path.join(folder, 'c.txt'))
  await rename(path.join(folder, 'd.txt'), path.join(folder, 'e.txt'))
  await write(folder, 'dirty.txt', 'agent rewrote it\n')
  await rm(path.join(folder, 'untracked.txt'))
  await write(folder, 'new.txt', 'new\n')
  await write(folder, 'nested/deep/x.txt', 'x\n')
  await write(folder, 'crlf.txt', 'line one\r\nline 2\r\n')
}

describe('in a repository', () => {
  it('puts every kind of change back exactly, and the backup undoes it', async () => {
    const folder = await repo()
    const store = checkpoints()
    const before = await files(folder)
    const status = git(folder, 'status', '--porcelain', '--untracked-files=all')
    await take(store, 'e:1', [folder])
    await agentTurn(folder)
    const after = await files(folder)

    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    expect(preview).not.toBeNull()
    const changes = Object.fromEntries(
      preview!.folders[0]!.changes.map((change) => [change.key, change]),
    )
    expect(Object.keys(changes).sort()).toEqual([
      'a.txt',
      'b.bin',
      'c.txt',
      'crlf.txt',
      'd.txt',
      'dirty.txt',
      'e.txt',
      'nested/deep/x.txt',
      'new.txt',
      'untracked.txt',
    ])
    expect(changes['a.txt']).toMatchObject({ action: 'restore', insertions: 1, deletions: 2 })
    expect(changes['b.bin']).toMatchObject({ action: 'restore', binary: true, insertions: null })
    expect(changes['c.txt']).toMatchObject({ action: 'recreate', insertions: 1, deletions: 0 })
    expect(changes['d.txt']).toMatchObject({ action: 'recreate' })
    expect(changes['e.txt']).toMatchObject({ action: 'delete', insertions: 0, deletions: 1 })
    expect(changes['dirty.txt']).toMatchObject({ action: 'restore', insertions: 2, deletions: 1 })
    expect(changes['untracked.txt']).toMatchObject({ action: 'recreate' })
    expect(changes['new.txt']).toMatchObject({ action: 'delete' })

    const restored = await store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token)
    expect(restored.failed).toEqual([])
    expect(restored.restored).toBe(10)
    expect(await files(folder)).toEqual(before)
    expect(await there(path.join(folder, 'nested'))).toBe(false)
    expect(git(folder, 'status', '--porcelain', '--untracked-files=all')).toBe(status)

    const undo = await store.preview(SESSION, { backup: restored.backup }, [folder])
    await store.restore(SESSION, { backup: restored.backup }, [folder], undo!.token)
    expect(await files(folder)).toEqual(after)
  })

  it('counts lines as git does', async () => {
    const folder = await repo()
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    await write(folder, 'long.txt', `${lines.join('\n')}\n`)
    const store = checkpoints()
    await take(store, 'e:1', [folder])
    const changed = [...lines]
    changed.splice(10, 3, 'x', 'y')
    changed.splice(40, 0, 'inserted 1', 'inserted 2', 'inserted 3')
    changed.pop()
    await write(folder, 'long.txt', `${changed.join('\n')}\n`)
    await write(path.join(root, 'old'), 'long.txt', `${lines.join('\n')}\n`)
    // The restore turns the file as it is now back into the checkpoint's; `--no-index` exits 1
    // on a difference.
    let out = ''
    try {
      execFileSync(
        'git',
        [
          'diff',
          '--no-index',
          '--numstat',
          path.join(folder, 'long.txt'),
          path.join(root, 'old', 'long.txt'),
        ],
        { encoding: 'utf8' },
      )
    } catch (error) {
      out = (error as { stdout: string }).stdout
    }
    const [added, removed] = out.trim().split('\t').map(Number)
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    const change = preview!.folders[0]!.changes.find((item) => item.key === 'long.txt')!
    expect([change.insertions, change.deletions]).toEqual([added, removed])
  })

  it('refuses a restore when the files changed since the preview, and writes nothing', async () => {
    const folder = await repo()
    const store = checkpoints()
    await take(store, 'e:1', [folder])
    await agentTurn(folder)
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    await write(folder, 'later.txt', 'the user wrote this after the preview\n')
    const now = await files(folder)
    await expect(
      store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token),
    ).rejects.toBeInstanceOf(ChangedSincePreview)
    expect(await files(folder)).toEqual(now)
  })

  it('leaves alone what it did not keep: ignored, too large, and changed while copied', async () => {
    const folder = await repo()
    await write(folder, 'app.log', 'ignored before\n')
    await write(folder, 'big.dat', 'x'.repeat(100))
    const store = checkpoints({ limits: { fileBytes: 50 } })
    await take(store, 'e:1', [folder])
    await write(folder, 'app.log', 'ignored after\n')
    await write(folder, 'big.dat', 'y'.repeat(100))
    await write(folder, 'made.log', 'an ignored file the turn made\n')
    await write(folder, 'a.txt', 'changed\n')
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    const keys = preview!.folders[0]!.changes.map((change) => change.key)
    expect(keys).toEqual(['a.txt'])
    expect(preview!.folders[0]!.kept).toEqual(['big.dat'])
    await store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token)
    expect(await readFile(path.join(folder, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(await readFile(path.join(folder, 'app.log'), 'utf8')).toBe('ignored after\n')
    expect(await readFile(path.join(folder, 'big.dat'), 'utf8')).toBe('y'.repeat(100))
    expect(await there(path.join(folder, 'made.log'))).toBe(true)

    // A file changed after the listing is not kept as it was then.
    const late = checkpoints({ now: () => 0 })
    await take(late, 'e:2', [folder])
    await write(folder, 'dirty.txt', 'changed again\n')
    const second = await late.preview(SESSION, { entryId: 'e:2' }, [folder])
    expect(second!.folders[0]!.changes.map((change) => change.key)).not.toContain('dirty.txt')
    expect(second!.folders[0]!.kept).toContain('dirty.txt')
  })

  it('keeps a folder inside a repository to itself', async () => {
    const top = await repo()
    await write(top, 'sub/inner.txt', 'inner\n')
    git(top, 'add', '-A')
    git(top, 'commit', '-q', '-m', 'sub')
    const folder = path.join(top, 'sub')
    const store = checkpoints()
    await take(store, 'e:1', [folder])
    await write(folder, 'inner.txt', 'changed\n')
    await write(folder, 'added.txt', 'added\n')
    await write(top, 'a.txt', 'outside the folder\n')
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    expect(preview!.folders[0]!.changes.map((change) => [change.key, change.action])).toEqual([
      ['added.txt', 'delete'],
      ['inner.txt', 'restore'],
    ])
    await store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token)
    expect(await readFile(path.join(folder, 'inner.txt'), 'utf8')).toBe('inner\n')
    expect(await readFile(path.join(top, 'a.txt'), 'utf8')).toBe('outside the folder\n')
  })

  it('restores across a commit the turn made', async () => {
    const folder = await repo()
    const store = checkpoints()
    const before = await files(folder)
    await take(store, 'e:1', [folder])
    await write(folder, 'a.txt', 'committed by the agent\n')
    git(folder, 'add', '-A')
    git(folder, 'commit', '-q', '-m', 'agent')
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    await store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token)
    expect(await files(folder)).toEqual(before)
  })
})

describe('outside a repository', () => {
  it('copies the folder, leaves out what is generated, and puts it back', async () => {
    const folder = path.join(root, 'plain')
    await write(folder, 'notes.md', '# notes\n')
    await write(folder, 'src/app.js', 'console.log(1)\n')
    await write(folder, 'node_modules/dep/index.js', 'dependency\n')
    const store = checkpoints()
    const before = await files(folder)
    await take(store, 'e:1', [folder])
    await write(folder, 'notes.md', '# notes\nmore\n')
    await rm(path.join(folder, 'src/app.js'))
    await write(folder, 'src/new.js', 'new\n')
    await write(folder, 'node_modules/dep/index.js', 'updated dependency\n')
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    expect(preview!.folders[0]!.changes.map((change) => [change.key, change.action])).toEqual([
      ['notes.md', 'restore'],
      ['src/app.js', 'recreate'],
      ['src/new.js', 'delete'],
    ])
    await store.restore(SESSION, { entryId: 'e:1' }, [folder], preview!.token)
    expect(await files(folder)).toEqual({
      ...before,
      'node_modules/dep/index.js': Buffer.from('updated dependency\n').toString('base64'),
    })
  })

  it('covers every folder of a project', async () => {
    const first = path.join(root, 'one')
    const second = path.join(root, 'two')
    await write(first, 'a.txt', 'a\n')
    await write(second, 'b.txt', 'b\n')
    const store = checkpoints()
    await take(store, 'e:1', [first, second])
    await write(first, 'a.txt', 'a changed\n')
    await write(second, 'b.txt', 'b changed\n')
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [first, second])
    expect(preview!.folders.map((folder) => folder.changes.length)).toEqual([1, 1])
    await store.restore(SESSION, { entryId: 'e:1' }, [first, second], preview!.token)
    expect(await readFile(path.join(first, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(path.join(second, 'b.txt'), 'utf8')).toBe('b\n')
  })
})

describe('the store', () => {
  async function storeFiles(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else out.push(path.relative(path.join(root, 'store'), full).split(path.sep).join('/'))
      }
    }
    await walk(path.join(root, 'store'))
    return out
  }

  it('keeps the newest checkpoints of a session, and sweeps what none names', async () => {
    const folder = path.join(root, 'plain')
    const store = checkpoints({ keep: { perSession: 2, sweepEveryMs: 0 } })
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
      await write(folder, 'f.txt', `${text}\n`)
      await take(store, `e:${index + 1}`, [folder])
      // Trimming follows the checkpoint.
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await store.has(SESSION, 'e:1', [folder])).toBe(false)
    expect(await store.has(SESSION, 'e:3', [folder])).toBe(true)
    const objects = (await storeFiles()).filter((file) => file.includes('/objects/'))
    expect(objects).toHaveLength(2)
  })

  it('drops a deleted session and the store it alone used', async () => {
    const folder = path.join(root, 'plain')
    await write(folder, 'f.txt', 'text\n')
    const store = checkpoints()
    await take(store, 'e:1', [folder])
    expect((await storeFiles()).length).toBeGreaterThan(0)
    await store.forget(SESSION)
    expect(await storeFiles()).toEqual([])
    expect(await store.has(SESSION, 'e:1', [folder])).toBe(false)
  })

  it('keeps nothing of a checkpoint whose turn did not wait for it', async () => {
    const folder = path.join(root, 'plain')
    await write(folder, 'f.txt', 'text\n')
    const store = checkpoints()
    const taking = store.begin(SESSION, 'e:1', [folder])
    taking.cancel()
    await taking.listed
    expect(await store.has(SESSION, 'e:1', [folder])).toBe(false)
  })

  it('keeps the first checkpoint of a message that is sent again', async () => {
    const folder = path.join(root, 'plain')
    await write(folder, 'f.txt', 'before\n')
    const store = checkpoints()
    await take(store, 'e:1', [folder])
    await write(folder, 'f.txt', 'after a failed turn\n')
    await take(store, 'e:1', [folder])
    const preview = await store.preview(SESSION, { entryId: 'e:1' }, [folder])
    expect(preview!.folders[0]!.changes.map((change) => change.key)).toEqual(['f.txt'])
  })

  it('refuses names that would leave the store', async () => {
    const folder = path.join(root, 'plain')
    await write(folder, 'f.txt', 'text\n')
    const store = checkpoints()
    expect(() => store.begin('../escape', 'e:1', [folder])).not.toThrow()
    await expect(store.preview(SESSION, { backup: '../../x' }, [folder])).rejects.toThrow()
  })
})

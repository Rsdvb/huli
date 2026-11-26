// Huli: big folders Kite deletes are moved aside in one rename and deleted in the background,
// waiting out files a virus scan or a closing process holds on Windows.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deleteLater,
  deletesSettled,
  discard,
  heldOpen,
  moveAside,
  sweepTrash,
  TRASH_PREFIX,
} from './discard'
import { linkFolder } from './testing/links'
import { tempFolder } from './testing/temp'

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted`), { code })
}

/** A folder of a few levels and files, as a package install has. */
async function tree(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'node_modules', '@scope', 'pkg', 'lib'), { recursive: true })
  await writeFile(path.join(dir, 'installed.json'), '{}')
  await writeFile(path.join(dir, 'node_modules', '@scope', 'pkg', 'lib', 'index.js'), '')
  await writeFile(path.join(dir, 'node_modules', '@scope', 'pkg', 'package.json'), '{}')
}

const noWait = async (): Promise<void> => {}

describe('moving a folder aside', () => {
  it('renames it to a trash name in the root, whole, at once', async () => {
    const root = await tempFolder('kite-discard-')
    const dir = path.join(root, 'deepseek')
    await tree(dir)
    const trash = await moveAside(dir, { trashRoot: root })
    expect(trash).not.toBeNull()
    expect(path.dirname(trash!)).toBe(root)
    expect(path.basename(trash!).startsWith(TRASH_PREFIX)).toBe(true)
    expect(await readdir(root)).toEqual([path.basename(trash!)])
    expect(await readFile(path.join(trash!, 'installed.json'), 'utf8')).toBe('{}')
  })

  it('finds nothing to move when the folder is gone', async () => {
    const root = await tempFolder('kite-discard-')
    expect(await moveAside(path.join(root, 'missing'), { trashRoot: root })).toBeNull()
  })

  it('waits out a file Windows holds for a moment, then moves the folder', async () => {
    const root = await tempFolder('kite-discard-')
    const dir = path.join(root, 'deepseek')
    await tree(dir)
    const waits: number[] = []
    let refusals = 2
    const trash = await moveAside(dir, {
      platform: 'win32',
      trashRoot: root,
      deps: {
        rename: async (from, to) => {
          if (refusals-- > 0) throw failure('EPERM')
          await rename(from, to)
        },
        wait: async (ms) => void waits.push(ms),
      },
    })
    expect(trash).not.toBeNull()
    expect(waits).toEqual([100, 200])
  })

  it('gives up on a file still held, leaving the folder whole', async () => {
    const root = await tempFolder('kite-discard-')
    const dir = path.join(root, 'deepseek')
    await tree(dir)
    const held = { rename: async () => Promise.reject(failure('EBUSY')), wait: noWait }
    const error = await moveAside(dir, { platform: 'win32', trashRoot: root, deps: held }).catch(
      (e: unknown) => e,
    )
    expect(heldOpen(error)).toBe(true)
    expect(await readdir(root)).toEqual(['deepseek'])
    expect(await discard(dir, { platform: 'win32', trashRoot: root, deps: held })).toBe(false)
    expect(await readdir(root)).toEqual(['deepseek'])
  })

  it('takes a refusal on macOS and Linux as final', async () => {
    let tries = 0
    const rename = async (): Promise<void> => {
      tries++
      throw failure('EACCES')
    }
    await expect(
      moveAside('/kite/harnesses/x', { platform: 'linux', deps: { rename } }),
    ).rejects.toThrow(/EACCES/)
    expect(tries).toBe(1)
  })
})

describe('deleting in the background', () => {
  it('deletes what was moved aside after the rename answered', async () => {
    const root = await tempFolder('kite-discard-')
    const dir = path.join(root, 'deepseek')
    await tree(dir)
    expect(await discard(dir, { trashRoot: root })).toBe(true)
    await deletesSettled()
    expect(await readdir(root)).toEqual([])
  })

  it('tries again after EPERM and EBUSY, with growing waits', async () => {
    const root = await tempFolder('kite-discard-')
    const trash = path.join(root, `${TRASH_PREFIX}abc`)
    await tree(trash)
    const waits: number[] = []
    const errors = ['EPERM', 'EBUSY']
    const gone = await deleteLater(trash, {
      remove: async (dir) => {
        const code = errors.shift()
        if (code) throw failure(code)
        await rm(dir, { recursive: true, force: true })
      },
      wait: async (ms) => void waits.push(ms),
    })
    expect(gone).toBe(true)
    expect(waits).toEqual([1_000, 5_000])
    expect(await readdir(root)).toEqual([])
  })

  it('leaves for the next start a folder still held after its last try, and says so', async () => {
    const logged: string[] = []
    let tries = 0
    const gone = await deleteLater('/kite/harnesses/.trash-abc', {
      remove: async () => {
        tries++
        throw failure('EPERM')
      },
      wait: noWait,
      log: (_level, message) => void logged.push(message),
    })
    expect(gone).toBe(false)
    expect(tries).toBe(6)
    expect(logged).toEqual([expect.stringMatching(/goes at the next start: EPERM/)])
  })

  it('does not try again an error no wait helps', async () => {
    let tries = 0
    const gone = await deleteLater('/kite/harnesses/.trash-abc', {
      remove: async () => {
        tries++
        throw failure('EIO')
      },
      wait: noWait,
    })
    expect(gone).toBe(false)
    expect(tries).toBe(1)
  })

  it('removes a link inside as a link, never what it points to', async () => {
    const root = await tempFolder('kite-discard-')
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep.txt'), 'mine')
    const dir = path.join(root, 'deepseek')
    await tree(dir)
    await linkFolder(outside, path.join(dir, 'node_modules', 'linked'))
    await linkFolder(outside, path.join(root, 'linked-harness'))
    expect(await discard(dir, { trashRoot: root })).toBe(true)
    expect(await discard(path.join(root, 'linked-harness'), { trashRoot: root })).toBe(true)
    await deletesSettled()
    expect(await readdir(root)).toEqual(['outside'])
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine')
  })
})

describe('the trash an earlier run left', () => {
  it('goes at the next start, and nothing else in the folder does', async () => {
    const root = await tempFolder('kite-discard-')
    await tree(path.join(root, `${TRASH_PREFIX}aaa`))
    await tree(path.join(root, `${TRASH_PREFIX}bbb`))
    await tree(path.join(root, 'deepseek', '0.2.2'))
    await mkdir(path.join(root, 'extensions'))
    await sweepTrash(root)
    expect((await readdir(root)).sort()).toEqual(['deepseek', 'extensions'])
  })

  it('is nothing to do in a folder not there', async () => {
    const root = await tempFolder('kite-discard-')
    await expect(sweepTrash(path.join(root, 'missing'))).resolves.toBeUndefined()
  })
})

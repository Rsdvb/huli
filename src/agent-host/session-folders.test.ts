import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionFolder } from '@shared/session-folders'
import { HostError } from './errors'
import {
  folderValidators,
  parseSessionFoldersFile,
  SessionFolders,
  sessionFoldersFile,
} from './session-folders'
import { createValidators } from './validate'

const log = () => {}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'session-folders-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function store(sessions: Set<string>, events: SessionFolder[][] = []) {
  let next = 0
  const file = sessionFoldersFile(root, log)
  const folders = new SessionFolders({
    file,
    isSession: (id) => sessions.has(id),
    changed: (list) => events.push(list),
    now: () => 1_000,
    newId: () => `f${++next}`,
  })
  return { folders, file }
}

async function saved(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, 'state', 'session-folders.json'), 'utf8'))
}

describe('SessionFolders', () => {
  it('creates folders with sessions and keeps them across a restart', async () => {
    const sessions = new Set(['a', 'b', 'c'])
    const events: SessionFolder[][] = []
    const { folders } = store(sessions, events)
    await folders.load()
    const work = folders.create('  Work   stuff ', ['a', 'b', 'gone'])
    expect(work).toEqual({
      id: 'f1',
      name: 'Work stuff',
      pinned: false,
      collapsed: false,
      createdAt: 1_000,
      sessionIds: ['a', 'b'],
    })
    expect(events.at(-1)).toEqual([work])
    await folders.flush()

    const again = store(sessions).folders
    await again.load()
    expect(again.list()).toEqual([work])
  })

  it('moves a session out of its folder into another, or out of every folder', async () => {
    const sessions = new Set(['a', 'b', 'c'])
    const { folders } = store(sessions)
    await folders.load()
    const one = folders.create('One', ['a', 'b'])
    const two = folders.create('Two')
    folders.move(['b', 'c'], two.id)
    expect(folders.list().map((f) => f.sessionIds)).toEqual([['a'], ['b', 'c']])
    folders.move(['a'], two.id)
    expect(folders.list().map((f) => f.sessionIds)).toEqual([[], ['a', 'b', 'c']])
    folders.move(['b'], null)
    expect(folders.list().map((f) => f.sessionIds)).toEqual([[], ['a', 'c']])
    expect(folders.list()[0]!.id).toBe(one.id)
  })

  it('deletes a folder without touching its sessions', async () => {
    const sessions = new Set(['a', 'b'])
    const { folders } = store(sessions)
    await folders.load()
    const one = folders.create('One', ['a', 'b'])
    folders.delete(one.id)
    expect(folders.list()).toEqual([])
    expect(sessions).toEqual(new Set(['a', 'b']))
    await folders.flush()
    expect(await saved()).toEqual({ version: 1, folders: [] })
  })

  it('renames, pins, collapses and reorders', async () => {
    const { folders } = store(new Set())
    await folders.load()
    const a = folders.create('A')
    const b = folders.create('B')
    const c = folders.create('C')
    folders.rename(b.id, 'Bee')
    folders.update(c.id, { pinned: true, collapsed: true })
    folders.reorder([c.id, 'missing', a.id])
    expect(folders.list().map((f) => [f.id, f.name, f.pinned, f.collapsed])).toEqual([
      [c.id, 'C', true, true],
      [a.id, 'A', false, false],
      [b.id, 'Bee', false, false],
    ])
  })

  it('drops sessions that went away from what it lists', async () => {
    const sessions = new Set(['a', 'b'])
    const { folders } = store(sessions)
    await folders.load()
    folders.create('One', ['a', 'b'])
    sessions.delete('a')
    expect(folders.list()[0]!.sessionIds).toEqual(['b'])
  })

  it('refuses a folder it does not have', async () => {
    const { folders } = store(new Set(['a']))
    await folders.load()
    expect(() => folders.rename('nope', 'x')).toThrow(HostError)
    expect(() => folders.move(['a'], 'nope')).toThrow(/No folder/)
    expect(() => folders.delete('nope')).toThrow(/No folder/)
  })

  it('reads a damaged file leniently and recovers from one that is not JSON', async () => {
    await mkdir(path.join(root, 'state'), { recursive: true })
    const file = path.join(root, 'state', 'session-folders.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        folders: [
          { id: 'x', name: 'X', sessionIds: ['a', 'a', 7, 'b'], pinned: 'yes' },
          { id: 'x', name: 'Duplicate' },
          { id: 'y', name: '   ' },
          { id: 'z', name: 'Z', sessionIds: ['b', 'c'], collapsed: true },
          null,
        ],
      }),
    )
    const { folders } = store(new Set(['a', 'b', 'c']))
    await folders.load()
    expect(folders.list()).toEqual([
      { id: 'x', name: 'X', pinned: false, collapsed: false, createdAt: 0, sessionIds: ['a', 'b'] },
      { id: 'z', name: 'Z', pinned: false, collapsed: true, createdAt: 0, sessionIds: ['c'] },
    ])

    await writeFile(file, '{ not json')
    const broken = store(new Set())
    await broken.folders.load()
    expect(broken.folders.list()).toEqual([])
    expect(broken.file.status).toBe('corrupt')
  })

  it('refuses a file without a folder list', () => {
    expect(parseSessionFoldersFile({ version: 1 })).toBe('folders is not a list')
  })
})

describe('folder validators', () => {
  it('are the host validators of the folder methods', () => {
    const validators = createValidators(process.platform === 'win32' ? 'win32' : 'linux')
    for (const method of Object.keys(folderValidators)) {
      expect(validators[method as keyof typeof folderValidators]).toBe(
        folderValidators[method as keyof typeof folderValidators],
      )
    }
  })

  it('keep only the known fields', () => {
    expect(folderValidators['folders.create']({ name: ' A ', extra: 1 })).toEqual({ name: 'A' })
    expect(folderValidators['folders.create']({ name: 'A', sessionIds: ['s', 's', 't'] })).toEqual({
      name: 'A',
      sessionIds: ['s', 't'],
    })
    expect(folderValidators['folders.rename']({ folderId: 'f', name: 'B', x: 1 })).toEqual({
      folderId: 'f',
      name: 'B',
    })
    expect(folderValidators['folders.update']({ folderId: 'f', pinned: true })).toEqual({
      folderId: 'f',
      pinned: true,
    })
    expect(folderValidators['folders.update']({ folderId: 'f', collapsed: false })).toEqual({
      folderId: 'f',
      collapsed: false,
    })
    expect(folderValidators['folders.delete']({ folderId: 'f' })).toEqual({ folderId: 'f' })
    expect(folderValidators['folders.reorder']({ folderIds: ['b', 'a'] })).toEqual({
      folderIds: ['b', 'a'],
    })
    expect(folderValidators['folders.move']({ sessionIds: ['s'], folderId: null })).toEqual({
      sessionIds: ['s'],
      folderId: null,
    })
    expect(folderValidators['folders.list'](undefined)).toBeUndefined()
  })

  it('refuse what is malformed', () => {
    expect(() => folderValidators['folders.list']({ x: 1 })).toThrow()
    expect(() => folderValidators['folders.create']({})).toThrow(/name/)
    expect(() => folderValidators['folders.create']({ name: '   ' })).toThrow(/empty/)
    expect(() => folderValidators['folders.create']({ name: 'x'.repeat(101) })).toThrow(/longer/)
    expect(() => folderValidators['folders.create']({ name: 'A', sessionIds: 's' })).toThrow()
    expect(() => folderValidators['folders.create']({ name: 'A', sessionIds: [''] })).toThrow()
    expect(() => folderValidators['folders.rename']({ folderId: 1, name: 'A' })).toThrow()
    expect(() => folderValidators['folders.update']({ folderId: 'f', pinned: 'yes' })).toThrow()
    expect(() => folderValidators['folders.delete']({})).toThrow(/folderId/)
    expect(() => folderValidators['folders.reorder']({ folderIds: [null] })).toThrow()
    expect(() => folderValidators['folders.move']({ sessionIds: ['s'] })).toThrow(/folderId/)
    expect(() => folderValidators['folders.move']({ sessionIds: [1], folderId: null })).toThrow()
    expect(() => folderValidators['folders.move'](null)).toThrow(/object/)
  })
})

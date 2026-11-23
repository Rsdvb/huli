import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BIN_DAY_MS,
  binKey,
  parseBinKey,
  purgeAt,
  type BinKind,
  type RecycleBinSettings,
} from '@shared/recycle-bin'
import { RecycleBin, type BinSource, type SourceItem } from './recycle-bin'

const START = Date.UTC(2026, 10, 1)

/** A kind whose items live in a map, as a store's binned records do. */
function source(kind: BinKind, items: SourceItem[]) {
  const held = new Map(items.map((item) => [item.id, item]))
  const purged: string[] = []
  const restored: string[] = []
  const bin: BinSource = {
    kind,
    items: async () => [...held.values()],
    sizes: async (list) => Object.fromEntries(list.map((item) => [item.id, 100])),
    restore: async (ids) => {
      for (const id of ids) {
        held.delete(id)
        restored.push(id)
      }
      return { restored: ids.map((id) => binKey(kind, id)), held: [] }
    },
    purge: async (ids) => {
      for (const id of ids) {
        held.delete(id)
        purged.push(id)
      }
    },
  }
  return { bin, held, purged, restored }
}

function make(sources: BinSource[], settings: RecycleBinSettings = { keepDays: 30 }) {
  const changed = vi.fn()
  const swept = vi.fn(async () => {})
  const current = { settings }
  const recycleBin = new RecycleBin({
    sources,
    settings: () => current.settings,
    changed,
    swept,
    log: () => {},
    startupMs: 1000,
  })
  return { recycleBin, changed, swept, current }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Huli: the recycle bin', () => {
  it('names an item by its kind and id, a folder path with colons included', () => {
    expect(binKey('project', 'C:\\work\\repo')).toBe('project:C:\\work\\repo')
    expect(parseBinKey('project:C:\\work\\repo')).toEqual({ kind: 'project', id: 'C:\\work\\repo' })
    expect(parseBinKey('memory:global/a-b.1.deleted')).toEqual({
      kind: 'memory',
      id: 'global/a-b.1.deleted',
    })
    expect(parseBinKey('nothing:x')).toBeNull()
    expect(parseBinKey('session:')).toBeNull()
    expect(purgeAt(START, { keepDays: 7 })).toBe(START + 7 * BIN_DAY_MS)
    expect(purgeAt(START, { keepDays: null })).toBeNull()
  })

  it('lists every kind newest first, with when each goes and its size', async () => {
    const sessions = source('session', [{ id: 's1', title: 'Old', deletedAt: START - 5000 }])
    const folders = source('folder', [{ id: 'f1', title: 'New', deletedAt: START - 10 }])
    const { recycleBin } = make([sessions.bin, folders.bin], { keepDays: 7 })
    const list = await recycleBin.list()
    expect(list.keepDays).toBe(7)
    expect(list.items.map((item) => item.key)).toEqual(['folder:f1', 'session:s1'])
    expect(list.items[1]).toMatchObject({
      kind: 'session',
      id: 's1',
      purgeAt: START - 5000 + 7 * BIN_DAY_MS,
      size: 100,
    })
  })

  it('restores and purges each key through its own kind', async () => {
    const sessions = source('session', [{ id: 's1', title: null, deletedAt: START }])
    const tasks = source('task', [{ id: 't1', title: 'T', deletedAt: START }])
    const { recycleBin } = make([sessions.bin, tasks.bin])
    const result = await recycleBin.restore(['task:t1'])
    expect(result).toEqual({ restored: ['task:t1'], held: [] })
    expect(tasks.restored).toEqual(['t1'])
    await recycleBin.purge(['session:s1'])
    expect(sessions.purged).toEqual(['s1'])
    await expect(recycleBin.purge(['routine:r1'])).rejects.toThrow()
  })

  it('empties every kind', async () => {
    const sessions = source('session', [
      { id: 's1', title: null, deletedAt: START },
      { id: 's2', title: null, deletedAt: START },
    ])
    const memory = source('memory', [{ id: 'global/m.1.deleted', title: 'M', deletedAt: START }])
    const { recycleBin } = make([sessions.bin, memory.bin])
    await recycleBin.empty()
    expect(sessions.purged).toEqual(['s1', 's2'])
    expect(memory.purged).toEqual(['global/m.1.deleted'])
  })

  it('purges what stayed past its days once the host settled, then at the next one due', async () => {
    const sessions = source('session', [
      { id: 'old', title: null, deletedAt: START - 31 * BIN_DAY_MS },
      { id: 'new', title: null, deletedAt: START - 29 * BIN_DAY_MS },
    ])
    const { recycleBin, swept } = make([sessions.bin])
    recycleBin.start()
    expect(sessions.purged).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessions.purged).toEqual(['old'])
    expect(swept).toHaveBeenCalledTimes(1)
    // Nothing runs until the next item is due, a day from now.
    await vi.advanceTimersByTimeAsync(BIN_DAY_MS - 2000)
    expect(sessions.purged).toEqual(['old'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(sessions.purged).toEqual(['old', 'new'])
    // Empty, it sets no timer at all.
    expect(vi.getTimerCount()).toBe(0)
    recycleBin.stop()
  })

  it('sets its timer for an item that comes into an empty bin', async () => {
    const sessions = source('session', [])
    const { recycleBin } = make([sessions.bin], { keepDays: 7 })
    recycleBin.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
    sessions.held.set('s1', { id: 's1', title: null, deletedAt: Date.now() })
    recycleBin.added()
    await vi.advanceTimersByTimeAsync(7 * BIN_DAY_MS - 1)
    expect(sessions.purged).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sessions.purged).toEqual(['s1'])
    recycleBin.stop()
  })

  it('never purges by time while the settings keep everything', async () => {
    const sessions = source('session', [
      { id: 'old', title: null, deletedAt: START - 400 * BIN_DAY_MS },
    ])
    const { recycleBin, swept } = make([sessions.bin], { keepDays: null })
    recycleBin.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessions.purged).toEqual([])
    expect(swept).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    recycleBin.stop()
  })

  it('applies a shorter keep a minute after it is chosen', async () => {
    const sessions = source('session', [
      { id: 'week', title: null, deletedAt: START - 8 * BIN_DAY_MS },
    ])
    const { recycleBin, current } = make([sessions.bin], { keepDays: 30 })
    recycleBin.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessions.purged).toEqual([])
    current.settings = { keepDays: 7 }
    recycleBin.settingsChanged()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(sessions.purged).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessions.purged).toEqual(['week'])
    recycleBin.stop()
  })

  it('tells the pages once for a burst of changes', async () => {
    const sessions = source('session', [{ id: 's1', title: null, deletedAt: START }])
    const { recycleBin, changed } = make([sessions.bin])
    recycleBin.added()
    recycleBin.added()
    await recycleBin.restore(['session:s1'])
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toHaveBeenCalledTimes(1)
    recycleBin.stop()
  })
})

// Huli: the recycle bin's sessions: what a delete keeps in the index and leaves out of every
// lookup, a restore and a purge, and the bulk removals.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentManager } from './agents'
import type { Diagnostics } from './diagnostics'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile, type SessionRecord, type SessionsFile } from './storage'
import type { ThreadStore } from './threads/store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-bin-sessions-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const log = () => {}

const record = (id: string, parentId: string | null, extra: Partial<SessionRecord> = {}) =>
  ({
    id,
    agentId: 'claude-code',
    acpSessionId: `acp-${id}`,
    projectPath: '/repo',
    title: id,
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId,
    origin: 'user',
    description: null,
    branch: null,
    ...extra,
  }) satisfies SessionRecord

/** The tree the tests delete: a session, its subagent and sub-session, and another session. */
const tree = () => [
  record('p', null, { pinnedAt: 5 }),
  record('a', 'p', { origin: 'subagent' }),
  record('c', 'p'),
  record('x', null),
]

async function index(): Promise<SessionsFile> {
  return JSON.parse(await readFile(path.join(dir, 'state', 'sessions.json'), 'utf8'))
}

/** A manager over real index files, an agent that deletes its sessions, and a thread store. */
function manager(groupBinned: (group: string) => boolean = () => false) {
  const deleted: string[] = []
  const removed: string[][] = []
  const binChanged = vi.fn()
  const deps = {
    platform: 'darwin',
    agents: {
      has: () => true,
      assertEnabled: () => {},
      runningConfig: () => null,
      sessionsChanged: () => {},
      restoreConfig: (_agentId: string, config: unknown[]) => config,
      status: () => ({ capabilities: null }),
      configFolder: () => null,
      ids: () => [],
      name: () => 'Agent',
      ensureReady: async () => ({
        init: { capabilities: { deleteSession: true, listSessions: true } },
        connection: {
          deleteSession: async (acpSessionId: string) => {
            deleted.push(acpSessionId)
          },
          listSessions: async () => ({
            sessions: [{ sessionId: 'acp-p', title: null, updatedAt: null }],
            nextCursor: null,
          }),
        },
      }),
    } as unknown as AgentManager,
    projects: {
      list: () => [],
      sandbox: () => null,
      presentFolders: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false, adopt: vi.fn() } as unknown as ScratchFolders,
    file: sessionsFile(dir, log),
    returned: returnedFile(dir, log),
    portOpen: () => false,
    threads: {
      remove: async (ids: readonly string[]) => {
        removed.push([...ids].sort())
      },
      sizes: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 10])),
    } as unknown as ThreadStore,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: { log: () => {}, event: () => {} } as unknown as Diagnostics,
    git: () => null,
    events: new Proxy({}, { get: () => () => {} }) as SessionEvents,
    settings: () => ({}) as never,
    binChanged,
    groupBinned,
  } satisfies ConstructorParameters<typeof SessionManager>[0]
  return { sessions: new SessionManager(deps), deleted, removed, binChanged }
}

async function loaded(records: SessionRecord[], groupBinned?: (group: string) => boolean) {
  const store = sessionsFile(dir, log)
  store.save({ version: 1, sessions: records })
  await store.flush()
  const made = manager(groupBinned)
  await made.sessions.load()
  return made
}

const listed = (sessions: SessionManager) =>
  sessions
    .list()
    .map((summary) => summary.id)
    .sort()

describe('Huli: deleting a session into the recycle bin', () => {
  it('keeps it and its sub-sessions in the index, out of every list and lookup', async () => {
    const { sessions, deleted, removed, binChanged } = await loaded(tree())
    await sessions.delete('p')
    expect(listed(sessions)).toEqual(['x'])
    for (const id of ['p', 'a', 'c']) {
      expect(sessions.has(id)).toBe(false)
      expect(sessions.inBin(id)).toBe(true)
      expect(() => sessions.summary(id)).toThrow()
    }
    expect(binChanged).toHaveBeenCalled()
    // Nothing is deleted for good yet: not the agent's copy, nor the stored thread.
    expect(deleted).toEqual([])
    expect(removed).toEqual([])
    await sessions.flush()
    const stored = new Map((await index()).sessions.map((item) => [item.id, item]))
    expect(stored.get('p')).toMatchObject({ deletedAt: expect.any(Number), pinnedAt: 5 })
    expect(stored.get('p')?.deletedWith).toBeUndefined()
    expect(stored.get('c')).toMatchObject({ deletedWith: 'session:p' })
    expect(stored.get('a')).toMatchObject({ deletedWith: 'session:p' })
    expect(stored.get('x')?.deletedAt).toBeUndefined()
  })

  it('stays in the bin after a restart, as one item with what went with it', async () => {
    const first = await loaded(tree())
    await first.sessions.delete('p')
    await first.sessions.flush()
    const { sessions } = manager()
    await sessions.load()
    expect(listed(sessions)).toEqual(['x'])
    const items = sessions.binnedItems()
    expect(items.map((item) => item.record.id)).toEqual(['p'])
    expect(items[0]!.members.map((member) => member.id).sort()).toEqual(['a', 'c'])
    expect(sessions.binnedSince()).toEqual(expect.any(Number))
    expect(await sessions.binnedSizes(['p', 'c'])).toEqual({ p: 10, c: 10 })
  })

  it('restores exactly what went in', async () => {
    const { sessions } = await loaded(tree())
    const before = (await index()).sessions.find((item) => item.id === 'p')
    await sessions.delete('p')
    await sessions.unbin(sessions.binGroup('p'))
    expect(listed(sessions)).toEqual(['a', 'c', 'p', 'x'])
    expect(sessions.summary('c').parentId).toBe('p')
    expect(sessions.summary('p').pinnedAt).toBe(5)
    expect(sessions.inBin('p')).toBe(false)
    await sessions.flush()
    const after = (await index()).sessions.find((item) => item.id === 'p')
    expect(after).toEqual(before)
  })

  it('purges as a delete did before: the agent copy, the thread and the record', async () => {
    const { sessions, deleted, removed } = await loaded(tree())
    await sessions.delete('p')
    await sessions.purgeBinned(sessions.binGroup('p'))
    // A subagent's session is its parent's, so only the two the user had are deleted.
    expect(deleted.sort()).toEqual(['acp-c', 'acp-p'])
    expect(removed).toEqual([['a', 'c', 'p']])
    expect(sessions.inBin('p')).toBe(false)
    await sessions.flush()
    expect((await index()).sessions.map((item) => item.id)).toEqual(['x'])
  })

  it('deletes at once for good when asked to, as a routine does past its kept runs', async () => {
    const { sessions, deleted } = await loaded(tree())
    await sessions.deleteNow('x')
    expect(deleted).toEqual(['acp-x'])
    expect(sessions.inBin('x')).toBe(false)
    await sessions.flush()
    expect((await index()).sessions.some((item) => item.id === 'x')).toBe(false)
  })

  it('brings one back from the bin on an import of its agent session, not twice', async () => {
    const { sessions } = await loaded(tree())
    await sessions.delete('p')
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'acp-p',
    })
    expect(summary.id).toBe('p')
    expect(listed(sessions)).toEqual(['a', 'c', 'p', 'x'])
  })
})

describe('Huli: removals that leave the agents their copies', () => {
  it('moves every session to the bin, each top-level one an item', async () => {
    const { sessions, deleted, removed } = await loaded(tree())
    await sessions.removeAll()
    expect(sessions.list()).toEqual([])
    expect(
      sessions
        .binnedItems()
        .map((item) => item.record.id)
        .sort(),
    ).toEqual(['p', 'x'])
    for (const item of sessions.binnedItems())
      await sessions.purgeBinned(sessions.binGroup(item.record.id))
    // Clearing the list never deleted the agents' own copies, and its purge does not either.
    expect(deleted).toEqual([])
    expect(removed.flat().sort()).toEqual(['a', 'c', 'p', 'x'])
  })

  it("takes a project's sessions with it, listed under the project while it is binned", async () => {
    let binned = true
    const { sessions, deleted } = await loaded(tree(), () => binned)
    await sessions.removeProject('/repo', 'project:/repo')
    expect(sessions.list()).toEqual([])
    expect(
      sessions
        .binnedWith('project:/repo')
        .map((item) => item.id)
        .sort(),
    ).toEqual(['a', 'c', 'p', 'x'])
    expect(sessions.binnedItems()).toEqual([])
    // The project came back without them: each top-level one is its own item.
    binned = false
    expect(
      sessions
        .binnedItems()
        .map((item) => item.record.id)
        .sort(),
    ).toEqual(['p', 'x'])
    await sessions.purgeBinned(sessions.binnedWith('project:/repo'))
    expect(deleted).toEqual([])
  })

  it("takes a task's or a routine's sessions with it under its key", async () => {
    const { sessions } = await loaded(tree(), (group) => group === 'task:t1')
    await sessions.delete('p', 'task:t1')
    expect(
      sessions
        .binnedWith('task:t1')
        .map((item) => item.id)
        .sort(),
    ).toEqual(['a', 'c', 'p'])
    expect(sessions.binnedItems()).toEqual([])
    await sessions.unbin(sessions.binnedWith('task:t1'))
    expect(listed(sessions)).toEqual(['a', 'c', 'p', 'x'])
  })
})

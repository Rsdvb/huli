import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentManager } from './agents'
import type { Diagnostics } from './diagnostics'
import type { LastRequest, OutsideReader } from './outside-sessions'
import type { Projects } from './projects'
import { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile, type SessionRecord, type SessionsFile } from './storage'
import type { StoredThread } from './threads/model'
import type { ThreadStore } from './threads/store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-sessions-'))
})

afterEach(async () => {
  // A save the manager queued may still land as the folder goes, under a loaded machine.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const log = () => {}

/** A manager over real index files in `dir`, with no agent, git or thread store behind it. */
function manager(
  projects: Partial<Projects> = {},
  extra: {
    agents?: Record<string, unknown>
    outside?: OutsideReader
    threads?: Partial<ThreadStore>
    scratch?: ScratchFolders
    profiles?: ConstructorParameters<typeof SessionManager>[0]['profiles']
  } = {},
) {
  const added: string[] = []
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
      ...extra.agents,
    } as unknown as AgentManager,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async (folder: string) => {
        added.push(folder)
      },
      ...projects,
    } as unknown as Projects,
    scratch: extra.scratch ?? ({ contains: () => false } as unknown as ScratchFolders),
    file: sessionsFile(dir, log),
    returned: returnedFile(dir, log),
    portOpen: () => false,
    threads: (extra.threads ?? null) as ThreadStore | null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: { log: () => {}, event: () => {} } as unknown as Diagnostics,
    git: () => null,
    events: new Proxy({}, { get: () => () => {} }) as SessionEvents,
    settings: () => ({}) as never,
    ...(extra.outside ? { outside: extra.outside } : {}),
    ...(extra.profiles ? { profiles: extra.profiles } : {}),
  } satisfies ConstructorParameters<typeof SessionManager>[0]
  return { sessions: new SessionManager(deps), added }
}

async function index(): Promise<SessionsFile | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'state', 'sessions.json'), 'utf8'))
  } catch {
    return null
  }
}

describe('the session index', () => {
  it('writes a session that first enters it at once, before a crash can lose it', async () => {
    const { sessions } = manager()
    await sessions.load()
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
    })
    await vi.waitFor(async () =>
      expect((await index())?.sessions.map((record) => record.id)).toEqual([summary.id]),
    )
  })
})

describe('Huli: the agents that share a history', () => {
  const FOLDERS: Record<string, string> = {
    'claude-code': '/home/me/.claude',
    'claude-code~work': '/home/me/.claude/',
    'claude-code~other': '/home/me/.claude-other',
    codex: '/home/me/.claude',
  }
  const shared = () =>
    manager(
      {},
      {
        agents: {
          configFolder: (id: string) => FOLDERS[id] ?? null,
          ids: () => Object.keys(FOLDERS),
        },
      },
    )

  it('takes a Claude Code session as here for every Claude Code agent reading its folder', async () => {
    const { sessions } = shared()
    await sessions.load()
    const first = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(sessions.sharingHistory('claude-code~work')).toEqual(['claude-code~work', 'claude-code'])
    expect(sessions.agentSessionIds('claude-code~work').has('cli-1')).toBe(true)
    expect(sessions.agentSessionIds('claude-code~other').has('cli-1')).toBe(false)
    // Another harness's ids are its own, whatever its folder.
    expect(sessions.sharingHistory('codex')).toEqual(['codex'])
    expect(sessions.agentSessionIds('codex').has('cli-1')).toBe(false)
    const again = await sessions.importSession({
      agentId: 'claude-code~work',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(again.id).toBe(first.id)
    const elsewhere = await sessions.importSession({
      agentId: 'claude-code~other',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(elsewhere.id).not.toBe(first.id)
    expect(sessions.list('/repo')).toHaveLength(2)
  })
})

describe('importing a session from a terminal', () => {
  const last: LastRequest = {
    at: Date.parse('2026-11-16T10:00:00Z'),
    ttl: 60 * 60_000,
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    fast: false,
    mode: 'auto',
    context: 120_000,
  }
  const reader = (held: boolean, asked: string[] = []): OutsideReader => ({
    lastRequest: async (_agent, _cwd, id) => {
      asked.push(id)
      return last
    },
    holder: async () => (held ? { pid: 42, entrypoint: 'cli', busy: true } : null),
    tail: async () => null,
  })

  it('refuses one a terminal still has open, and keeps nothing of it', async () => {
    const { sessions } = manager({}, { outside: reader(true) })
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'cli-1',
      }),
    ).rejects.toMatchObject({ code: 'busy', data: { reason: 'held' } })
    expect(sessions.list('/repo')).toEqual([])
  })

  it('keeps how its last request ran and its cache, and sends the guide ahead', async () => {
    const { sessions } = manager({}, { outside: reader(false) })
    await sessions.load()
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(summary.cache).toEqual({ lastRequestAt: last.at, ttl: last.ttl })
    await vi.waitFor(async () =>
      expect((await index())?.sessions[0]).toMatchObject({
        acpSessionId: 'cli-1',
        cache: { lastRequestAt: last.at, ttl: last.ttl },
        outside: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: false, mode: 'auto' },
        instructionsAhead: true,
      }),
    )
  })

  it('copies one a terminal has open when asked to fork, with the settings of the original', async () => {
    const asked: string[] = []
    const copied: string[] = []
    const { sessions } = manager(
      {},
      {
        outside: reader(true, asked),
        agents: {
          ensureReady: async () => ({
            connection: {
              copySession: async (id: string) => {
                copied.push(id)
                return 'copy-1'
              },
            },
          }),
        },
      },
    )
    await sessions.load()
    await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
      fork: true,
    })
    expect(copied).toEqual(['cli-1'])
    expect(asked).toEqual(['cli-1'])
    await vi.waitFor(async () =>
      expect((await index())?.sessions[0]).toMatchObject({ acpSessionId: 'copy-1' }),
    )
  })
})

describe('the Claude desktop app’s scratch folders', () => {
  const support = '/Users/me/Library/Application Support/Claude/scratch-workspaces/a/o'
  const first = `${support}/scratch-2026-11-10-df326f`
  const second = `${support}/scratch-2026-11-11-11feb9`
  const scratch = () => new ScratchFolders(path.join(dir, 'scratch'), 'darwin')

  it('imports a session of one under No project, adding no project', async () => {
    const { sessions, added } = manager({}, { scratch: scratch() })
    await sessions.load()
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: first,
      acpSessionId: 'cli-1',
    })
    expect(summary.scratch).toBe(true)
    expect(added).toEqual([])
    const project = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-2',
    })
    expect(project.scratch).toBe(false)
    expect(added).toEqual(['/repo'])
  })

  it('keeps them No project after a restart, unless the folder is a project here', async () => {
    const before = manager({}, { scratch: scratch() })
    await before.sessions.load()
    for (const [projectPath, acpSessionId] of [
      [first, 'cli-1'],
      [second, 'cli-2'],
    ] as const) {
      await before.sessions.importSession({ agentId: 'claude-code', projectPath, acpSessionId })
    }
    await before.sessions.flush()
    const after = manager({ list: () => [{ path: second }] as never }, { scratch: scratch() })
    await after.sessions.load()
    after.sessions.adoptOutsideScratch()
    expect(
      after.sessions
        .list()
        .map((s) => [s.projectPath, s.scratch])
        .sort(),
    ).toEqual([
      [first, true],
      [second, false],
    ])
  })

  it('never removes one as an unused scratch folder of its own', async () => {
    const folder = path.join(dir, 'data', 'scratch-workspaces', 'a', 'o', 'scratch-2026-11-10-abc')
    await mkdir(folder, { recursive: true })
    const folders = new ScratchFolders(path.join(dir, 'scratch'), process.platform)
    await folders.ready()
    folders.adopt(folder)
    expect(folders.contains(path.join(folder, 'sub'))).toBe(true)
    await folders.removeIfEmpty(folder)
    expect((await stat(folder)).isDirectory()).toBe(true)
    const own = await folders.create()
    await folders.removeIfEmpty(own)
    await expect(stat(own)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('restoring an archived session', () => {
  const archived: SessionRecord = {
    id: 's1',
    agentId: 'claude-code',
    acpSessionId: 'acp-1',
    projectPath: '/repo',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
    archivedAt: 3,
  }

  it('puts its project back in the list, which the sidebar shows it under', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [archived] })
    await store.flush()
    const { sessions, added } = manager()
    await sessions.load()
    await sessions.unarchive('s1')
    expect(added).toEqual(['/repo'])
  })
})

describe('archiving a session without its sub-sessions', () => {
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

  async function loaded(records: SessionRecord[]) {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: records })
    await store.flush()
    const { sessions } = manager()
    await sessions.load()
    return sessions
  }

  const tree = () => [
    record('p', null, { pinnedAt: 1 }),
    // A subagent of the session, and a sub-session under it, which is the session's too.
    record('a', 'p', { origin: 'subagent' }),
    record('c1', 'p'),
    record('c2', 'a'),
    record('g', 'c1'),
    record('gone', 'p', { archivedAt: 1 }),
  ]

  it('leaves its sub-sessions in the list on their own, and its subagents with it', async () => {
    const sessions = await loaded(tree())
    await sessions.archive('p', false)
    expect(sessions.summary('p')).toMatchObject({ archivedAt: expect.any(Number), pinnedAt: null })
    expect(sessions.summary('a').parentId).toBe('p')
    expect(sessions.summary('c1')).toMatchObject({ parentId: null, archivedAt: null })
    expect(sessions.summary('c2')).toMatchObject({ parentId: null, archivedAt: null })
    expect(sessions.summary('g').parentId).toBe('c1')
    expect(sessions.summary('gone').parentId).toBe('p')
    await sessions.flush()
    const left = (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions
    expect(left?.toSorted()).toEqual(['c1', 'c2'])
  })

  it('puts them back under it when restored after a restart, unpinned, unless gone', async () => {
    const before = await loaded(tree())
    await before.archive('p', false)
    before.pin('c1', true)
    await before.delete('c2')
    await before.flush()
    const { sessions } = manager()
    await sessions.load()
    await sessions.unarchive('p')
    expect(sessions.summary('p').archivedAt).toBeNull()
    expect(sessions.summary('c1')).toMatchObject({ parentId: 'p', pinnedAt: null })
    expect(sessions.has('c2')).toBe(false)
    await sessions.flush()
    expect(
      (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions,
    ).toBeUndefined()
  })

  it('archives the whole tree by default', async () => {
    const sessions = await loaded(tree())
    await sessions.archive('p')
    expect(sessions.summary('c1').parentId).toBe('p')
    expect(sessions.summary('c2').parentId).toBe('a')
    await sessions.flush()
    expect(
      (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions,
    ).toBeUndefined()
  })
})

describe('answering a problem report', () => {
  const record: SessionRecord = {
    id: 's1',
    agentId: 'claude-code',
    acpSessionId: 'acp-1',
    projectPath: '/repo',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
  }
  const stored: StoredThread = {
    head: { agentId: 'claude-code', acpSessionId: 'acp-1' },
    session: {
      title: null,
      config: [],
      commands: [],
      usage: null,
      subagent: null,
      context: null,
      sideChat: null,
    },
    entries: [
      {
        pos: 0,
        entry: {
          kind: 'problem_report',
          id: 'e:1',
          title: 'Crash',
          details: 'It crashed',
          error: null,
          at: 1,
          outcome: null,
          after: null,
        },
      },
    ],
  }

  it('revives a session that was released, so its card still takes the answer', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [record] })
    await store.flush()
    const { sessions } = manager(
      {},
      { threads: { load: async () => stored, write: async () => undefined } },
    )
    await sessions.load()
    await sessions.answerReport('s1', 'e:1', { kind: 'skipped' })
    const snapshot = await sessions.snapshot('s1')
    expect(snapshot.entries.find((entry) => entry.id === 'e:1')).toMatchObject({
      outcome: { kind: 'skipped' },
    })
  })
})

// Huli: the API provider profile a session runs with.
describe('Huli: a session’s API profile', () => {
  const held = new Set(['p1', 'p2'])
  const profiles = {
    get: (agentId: string, id: string) =>
      agentId.startsWith('claude-code') && held.has(id) ? ({ id } as never) : null,
    defaultOf: () => 'p1',
  }

  it('changes between turns to one its agent has, or back to its own sign-in', async () => {
    const { sessions } = manager({}, { profiles })
    await sessions.load()
    const { id } = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
    })
    expect(sessions.summary(id).profileId).toBeNull()
    await sessions.setProfile(id, 'p2')
    expect(sessions.summary(id).profileId).toBe('p2')
    await expect(sessions.setProfile(id, 'gone')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(sessions.summary(id).profileId).toBe('p2')
    await vi.waitFor(
      async () =>
        expect((await index())?.sessions.find((record) => record.id === id)?.profileId).toBe('p2'),
      { timeout: 5_000 },
    )
    await sessions.setProfile(id, null)
    expect(sessions.summary(id).profileId).toBeNull()
  })

  it('refuses a profile for an agent whose sessions take none', async () => {
    const { sessions } = manager({}, { profiles })
    await sessions.load()
    const { id } = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/repo',
      acpSessionId: 'acp-2',
    })
    await expect(sessions.setProfile(id, 'p1')).rejects.toMatchObject({ code: 'invalid_params' })
    // Null is its own sign-in already.
    await sessions.setProfile(id, null)
  })
})

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
import { DEFAULT_WORKTREE_SETTINGS } from '@shared/git'
import type { SessionOptions } from './connection'
import { HostError } from './errors'
import type { WorktreeManager } from './worktrees/manager'
import { agentSandboxSupport } from '@shared/sandbox'

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
    worktrees?: WorktreeManager
    portFree?: (port: number) => Promise<boolean>
    settings?: Record<string, unknown>
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
      // An import checks its agent lists the session: these tests' sessions are listed.
      ...lists(['acp-1', 'acp-2', 'cli-1', 'cli-2']),
      ...extra.agents,
    } as unknown as AgentManager,
    projects: {
      list: () => [],
      sandbox: () => null,
      presentFolders: () => [],
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
    settings: () => (extra.settings ?? {}) as never,
    ...(extra.outside ? { outside: extra.outside } : {}),
    ...(extra.profiles ? { profiles: extra.profiles } : {}),
    ...(extra.worktrees ? { worktrees: extra.worktrees } : {}),
    ...(extra.portFree ? { portFree: extra.portFree } : {}),
  } satisfies ConstructorParameters<typeof SessionManager>[0]
  return { sessions: new SessionManager(deps), added, agents: deps.agents }
}

/** An agent that lists `pages` of session ids for any folder, one page per call. */
function lists(...pages: string[][]): Record<string, unknown> {
  return {
    name: () => 'Agent',
    ensureReady: async () => ({
      init: { capabilities: { listSessions: true } },
      connection: {
        listSessions: async (_cwd: string, cursor: string | null) => {
          const at = cursor === null ? 0 : Number(cursor)
          return {
            sessions: pages[at].map((sessionId) => ({ sessionId, title: null, updatedAt: null })),
            nextCursor: at + 1 < pages.length ? String(at + 1) : null,
          }
        },
      },
    }),
  }
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
    const { sessions } = manager({}, { agents: lists(['acp-1']) })
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
    const { sessions } = manager({}, { outside: reader(true), agents: lists(['cli-1']) })
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
    const { sessions } = manager({}, { outside: reader(false), agents: lists(['cli-1']) })
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

  it('refuses a session id its agent does not list for the folder, and keeps nothing of it', async () => {
    const { sessions, added } = manager({}, { outside: reader(false), agents: lists(['cli-1']) })
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'made-up',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(sessions.list('/repo')).toEqual([])
    expect(added).toEqual([])
    expect(await index()).toBeNull()
  })

  it('looks through every page its agent lists', async () => {
    const { sessions } = manager({}, { agents: lists(['a'], ['b'], ['cli-1']) })
    await sessions.load()
    await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(sessions.list('/repo')).toHaveLength(1)
    await vi.waitFor(async () => expect((await index())?.sessions).toHaveLength(1))
  })

  it('stops looking at a cursor its agent gives twice', async () => {
    const { sessions } = manager(
      {},
      {
        agents: {
          name: () => 'Agent',
          ensureReady: async () => ({
            init: { capabilities: { listSessions: true } },
            connection: {
              listSessions: async () => ({ sessions: [], nextCursor: 'same' }),
            },
          }),
        },
      },
    )
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'cli-1',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses an agent that cannot list its sessions, which it cannot check', async () => {
    const { sessions } = manager(
      {},
      {
        agents: {
          name: () => 'Agent',
          ensureReady: async () => ({ init: { capabilities: { listSessions: false } } }),
        },
      },
    )
    await sessions.load()
    await expect(
      sessions.importSession({ agentId: 'claude-code', projectPath: '/repo', acpSessionId: 'x' }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
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
    setAside: [],
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

// Huli: the sandbox a session runs in.
describe('Huli: a session’s sandbox', () => {
  const support = (agentId: string) =>
    agentSandboxSupport(agentId as never, agentId === 'gemini' ? 'acp-package' : 'other', 'darwin')
  const name = (agentId: string) => agentId

  it('changes between turns to one its agent can run in, never to another', async () => {
    const { sessions } = manager({}, { agents: { sandboxSupport: support, name } })
    await sessions.load()
    const { id } = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
    })
    expect(sessions.summary(id).sandbox).toBeNull()
    await sessions.setSandbox(id, { tier: 'native', network: 'none' })
    expect(sessions.summary(id).sandbox).toEqual({ tier: 'native', network: 'none' })
    // Claude Code runs in no container: the choice stays as it was.
    await expect(
      sessions.setSandbox(id, { tier: 'container', network: 'none' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    expect(sessions.summary(id).sandbox).toEqual({ tier: 'native', network: 'none' })
    await vi.waitFor(
      async () =>
        expect((await index())?.sessions.find((record) => record.id === id)?.sandbox).toEqual({
          tier: 'native',
          network: 'none',
        }),
      { timeout: 5_000 },
    )
    await sessions.setSandbox(id, { tier: 'off', network: 'open' })
    expect(sessions.summary(id).sandbox).toBeNull()
  })

  it('refuses a tier the agent has none of', async () => {
    const { sessions } = manager({}, { agents: { sandboxSupport: support, name } })
    await sessions.load()
    const { id } = await sessions.importSession({
      agentId: 'opencode',
      projectPath: '/repo',
      acpSessionId: 'acp-2',
    })
    for (const tier of ['native', 'container'] as const) {
      await expect(sessions.setSandbox(id, { tier, network: 'none' })).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
  })
})

describe('Huli: the task board', () => {
  const record = (id: string, extra: Partial<SessionRecord> = {}) =>
    ({
      id,
      agentId: 'claude-code',
      acpSessionId: `acp-${id}`,
      projectPath: '/repo',
      title: id,
      createdAt: 7,
      updatedAt: 8,
      lastViewedAt: null,
      parentId: null,
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

  it("puts the user's own sessions from before the board in progress, and no other", async () => {
    const sessions = await loaded([
      record('own'),
      record('child', { parentId: 'own' }),
      record('run', { origin: 'routine' }),
    ])
    expect(sessions.summary('own').board).toEqual({ status: 'in_progress', at: 7 })
    expect(sessions.summary('child').board).toBeNull()
    expect(sessions.summary('run').board).toBeNull()
  })

  it('keeps the column a session was moved to across a restart and an archive', async () => {
    const before = await loaded([record('s1')])
    before.setBoardStatus('s1', 'review')
    const moved = before.summary('s1').board
    expect(moved?.status).toBe('review')
    await before.archive('s1')
    await before.flush()
    const { sessions } = manager()
    await sessions.load()
    expect(sessions.summary('s1').board).toEqual(moved)
    await sessions.unarchive('s1')
    expect(sessions.summary('s1').board).toEqual(moved)
  })

  it("refuses a session that is not on the board, and leaves a column's time alone", async () => {
    const sessions = await loaded([record('own', { board: { status: 'todo', at: 9 } })])
    sessions.setBoardStatus('own', 'todo')
    expect(sessions.summary('own').board).toEqual({ status: 'todo', at: 9 })
    const child = await loaded([record('p'), record('c', { parentId: 'p' })])
    expect(() => child.setBoardStatus('c', 'done')).toThrow(HostError)
    expect(child.summary('c').board).toBeNull()
  })
})

describe('Huli: snoozed and settled sessions', () => {
  const NOW = Date.now()
  const record = (id: string, extra: Partial<SessionRecord> = {}) =>
    ({
      id,
      agentId: 'claude-code',
      acpSessionId: `acp-${id}`,
      projectPath: '/repo',
      title: id,
      createdAt: NOW - 1_000,
      updatedAt: NOW - 1_000,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
      ...extra,
    }) satisfies SessionRecord

  async function loaded(records: SessionRecord[], settings?: Record<string, unknown>) {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: records })
    await store.flush()
    const { sessions } = manager({}, settings ? { settings } : {})
    await sessions.load()
    return sessions
  }

  it('keeps a snooze and a settle across a restart, and brings a session back from either', async () => {
    const before = await loaded([record('a'), record('b')])
    const until = NOW + 3_600_000
    before.snooze('a', until)
    before.settle('b', true)
    expect(before.summary('a').snooze).toEqual({ until, reset: false })
    expect(before.summary('b').settled?.by).toBe('user')
    await before.flush()
    const after = await loaded((await index())!.sessions)
    expect(after.summary('a').snooze).toEqual({ until, reset: false })
    expect(after.summary('b').settled?.by).toBe('user')
    after.snooze('a', null)
    after.settle('b', false)
    expect(after.summary('a').snooze).toBeUndefined()
    expect(after.summary('b').settled).toBeUndefined()
    await after.flush()
    // Brought back by the user, it stays under no rule until their next message.
    expect((await index())!.sessions.find((s) => s.id === 'b')?.tidy?.keptAt).toBeGreaterThan(0)
    after.shutdown()
  })

  it("snoozes until the plan's reset only when it is known, and refuses a sub-session", async () => {
    const resetsAt = NOW + 7_200_000
    const pause = { since: NOW, resetsAt, resumeAt: resetsAt + 60_000, checks: 0 }
    const sessions = await loaded([
      record('paused', { limitPause: pause }),
      record('ended', {
        lastTurn: {
          reason: 'limit',
          endedAt: NOW,
          limit: { window: 'five_hour', label: '5-hour', account: 'me', resetsAt },
        },
      }),
      record('open'),
      record('child', { parentId: 'open' }),
    ])
    sessions.snooze('paused', 'reset')
    expect(sessions.summary('paused').snooze).toEqual({ until: resetsAt + 60_000, reset: true })
    // The window that ended its last turn says when too.
    sessions.snooze('ended', 'reset')
    expect(sessions.summary('ended').snooze).toEqual({ until: resetsAt + 60_000, reset: true })
    expect(() => sessions.snooze('open', 'reset')).toThrow(HostError)
    expect(() => sessions.snooze('open', NOW - 1)).toThrow(HostError)
    expect(() => sessions.snooze('child', NOW + 60_000)).toThrow(HostError)
    expect(() => sessions.settle('child', true)).toThrow(HostError)
    sessions.shutdown()
  })

  it('settles an idle session by the rules, never a pinned one or one kept from it', async () => {
    const old = NOW - 8 * 86_400_000
    const sessions = await loaded(
      [
        record('idle', { updatedAt: old }),
        record('pinned', { updatedAt: old, pinnedAt: old }),
        record('never', { updatedAt: old, tidy: { never: true } }),
        record('fresh'),
      ],
      { tidy: { autoSettle: true, idleDays: 7, merged: true } },
    )
    for (const id of ['idle', 'pinned', 'never', 'fresh']) sessions.rename(id, `${id}!`)
    expect(sessions.summary('idle').settled?.by).toBe('idle')
    expect(sessions.summary('pinned').settled).toBeUndefined()
    expect(sessions.summary('never').settled).toBeUndefined()
    expect(sessions.summary('never').neverSettle).toBe(true)
    expect(sessions.summary('fresh').settled).toBeUndefined()
    sessions.setNeverSettle('idle', true)
    expect(sessions.summary('idle').settled).toBeUndefined()
    sessions.shutdown()
  })

  it('shows nothing of it while the feature is off', async () => {
    const sessions = await loaded(
      [record('a', { tidy: { snooze: { until: NOW + 60_000 }, never: true } })],
      { features: { sessionTidy: false } },
    )
    expect(sessions.summary('a').snooze).toBeUndefined()
    expect(sessions.summary('a').neverSettle).toBeUndefined()
    sessions.shutdown()
  })
})

describe('Huli: the ports of worktree sessions', () => {
  const OID = 'a'.repeat(40)

  /** Worktrees in real folders of `dir`, each prepared at once, with the variables it got. */
  function worktrees() {
    const setupEnv: Record<string, string>[] = []
    let made = 0
    const manager = {
      settings: () => DEFAULT_WORKTREE_SETTINGS,
      create: async () => {
        made++
        const folder = path.join(dir, `wt-${made}`)
        await mkdir(folder, { recursive: true })
        return { path: folder, branch: `b${made}`, base: 'main', baseOid: OID }
      },
      prepare: async (
        _project: string,
        _record: unknown,
        onState: (state: { state: 'ready' }) => void,
        env: Record<string, string>,
      ) => {
        setupEnv.push(env)
        onState({ state: 'ready' })
        return { state: 'ready' }
      },
      stop: () => {},
      isPreparing: () => false,
    } as unknown as WorktreeManager
    return { manager, setupEnv }
  }

  /** An agent that is signed out, so a new session stays as it is, with what it was given. */
  function signedOut() {
    const given: SessionOptions[] = []
    return {
      given,
      agents: {
        ensureReady: async () => ({
          init: { capabilities: {} },
          connection: {
            newSession: async (_cwd: string, attach: SessionOptions) => {
              given.push(attach)
              throw new HostError('auth_required', 'Sign in first')
            },
          },
        }),
        authRequired: () => {},
        isDisabled: () => false,
        runtime: () => null,
      },
    }
  }

  async function started(busy: ReadonlySet<number> = new Set()) {
    const agent = signedOut()
    const trees = worktrees()
    const made = manager(
      {},
      {
        agents: agent.agents,
        worktrees: trees.manager,
        portFree: async (port) => !busy.has(port),
      },
    )
    await made.sessions.load()
    const create = (branch: string) =>
      made.sessions.create({
        agentId: 'claude-code',
        projectPath: dir,
        worktree: { base: 'main', branch },
      })
    return { ...made, ...agent, ...trees, create }
  }

  it('gives sessions started together blocks that never overlap', async () => {
    const { create } = await started()
    const made = await Promise.all([create('a'), create('b'), create('c')])
    expect(made.map((summary) => summary.worktree?.ports?.first).toSorted()).toEqual([
      20_000, 20_010, 20_020,
    ])
  })

  it('hands the block to the setup command and the agent, past ports in use', async () => {
    const { create, given, setupEnv } = await started(new Set([20_004]))
    const summary = await create('a')
    expect(summary.worktree?.ports).toEqual({ first: 20_010, count: 10 })
    expect(given[0]?.env).toEqual({ KITE_PORT: '20010', KITE_PORT_COUNT: '10' })
    expect(setupEnv[0]).toEqual({ KITE_PORT: '20010', KITE_PORT_COUNT: '10' })
  })

  /** A stored worktree session that holds `first` and the nine ports after it. */
  const holding = (id: string, first: number, extra: Partial<SessionRecord> = {}) =>
    ({
      id,
      agentId: 'claude-code',
      acpSessionId: `acp-${id}`,
      projectPath: dir,
      title: id,
      createdAt: 1,
      updatedAt: 2,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
      worktree: { path: path.join(dir, `stored-${id}`), branch: id, base: 'main', baseOid: OID },
      ports: { first, count: 10 },
      ...extra,
    }) satisfies SessionRecord

  it('keeps the blocks stored sessions hold across a restart, and lets one go with its archive', async () => {
    const store = sessionsFile(dir, log)
    store.save({
      version: 1,
      sessions: [
        holding('a', 20_000),
        holding('b', 20_010),
        // Archived: its block is free, kept only for a restore.
        holding('old', 20_020, { archivedAt: 3 }),
        // Its worktree was removed, so it holds nothing.
        holding('gone', 20_030, {
          worktree: { path: '/x', branch: 'g', base: 'main', baseOid: OID, removed: 'worktree' },
        }),
      ],
    })
    await store.flush()
    const { sessions, create } = await started()
    expect(sessions.summary('a').worktree?.ports).toEqual({ first: 20_000, count: 10 })
    expect(sessions.summary('old').worktree?.ports).toBeUndefined()
    expect(sessions.summary('gone').worktree?.ports).toBeUndefined()
    expect((await create('c')).worktree?.ports).toEqual({ first: 20_020, count: 10 })
    expect((await create('d')).worktree?.ports).toEqual({ first: 20_030, count: 10 })
    await sessions.archive('a')
    expect(sessions.summary('a').worktree?.ports).toBeUndefined()
    // The archived session's block goes to the next one.
    expect((await create('e')).worktree?.ports).toEqual({ first: 20_000, count: 10 })
  })

  it('gives a restored session its block back, or a new one when another took it', async () => {
    const store = sessionsFile(dir, log)
    store.save({
      version: 1,
      sessions: [
        holding('kept', 20_000, { archivedAt: 3 }),
        holding('taken', 20_010, { archivedAt: 3 }),
        holding('child', 20_010, {
          parentId: 'taken',
          worktree: {
            path: path.join(dir, 'stored-taken'),
            branch: 'taken',
            base: 'main',
            baseOid: OID,
          },
        }),
        holding('other', 20_010),
      ],
    })
    await store.flush()
    const { sessions } = await started()
    await sessions.unarchive('kept')
    expect(sessions.summary('kept').worktree?.ports).toEqual({ first: 20_000, count: 10 })
    await sessions.unarchive('taken')
    expect(sessions.summary('taken').worktree?.ports).toEqual({ first: 20_020, count: 10 })
    // Its sub-session, in the same worktree, shares the new block.
    expect(sessions.summary('child').worktree?.ports).toEqual({ first: 20_020, count: 10 })
    await sessions.flush()
    expect((await index())?.sessions.find((item) => item.id === 'taken')?.ports).toEqual({
      first: 20_020,
      count: 10,
    })
  })
})

describe('signing in', () => {
  // Huli: the notice leaves once the session no longer waits for the sign-in, rather than turning
  // into one that says it is signed in.
  it('takes the notice that asked for it out once the agent reports it is signed in', async () => {
    let starts = 0
    const agents: Record<string, unknown> = {
      name: () => 'Agent',
      authRequired: () => {},
      ensureReady: async () => ({
        init: { capabilities: {} },
        connection: {
          newSession: () => {
            starts++
            // The retry after the sign-in is left starting.
            if (starts > 1) return new Promise(() => {})
            return Promise.reject(new HostError('auth_required', 'Run the login command'))
          },
        },
      }),
    }
    const { sessions, agents: hooked } = manager({}, { agents })
    await sessions.load()
    const summary = await sessions.create({
      agentId: 'cline',
      projectPath: '/repo',
      prompt: [{ type: 'text', text: 'Hello' }],
    })
    const notices = async () =>
      (await sessions.open(summary.id)).entries.filter((entry) => entry.kind === 'notice')
    expect(await notices()).toMatchObject([{ cause: 'sign_in' }])
    hooked.hooks.signedIn('cline')

    await vi.waitFor(() => expect(starts).toBe(2))
    expect(await notices()).toEqual([])
  })
})

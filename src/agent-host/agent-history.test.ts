import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import {
  AgentHistory,
  claudeFolderName,
  HEAD_BYTES,
  historyPage,
  plainPath,
  scanClaudeHistory,
  TAIL_BYTES,
} from './agent-history'
import { listedEverywhere } from './codex/connection'
import type { Thread } from './codex/protocol'
import type { AgentConnection, ListedEverywhere } from './connection'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let dir: string
let claudeDir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-agent-history-'))
  claudeDir = path.join(dir, 'claude')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const line = (record: Record<string, unknown>) => JSON.stringify(record)

function user(cwd: string, content: unknown, extra: Record<string, unknown> = {}) {
  return line({
    type: 'user',
    isSidechain: false,
    cwd,
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  })
}

async function transcript(folder: string, id: string, lines: string[]): Promise<string> {
  const file = path.join(claudeDir, 'projects', folder, `${id}.jsonl`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${lines.join('\n')}\n`)
  return file
}

async function scan() {
  return scanClaudeHistory(claudeDir, 'linux', new Map(), () => {})
}

describe('Claude Code history', () => {
  it('names a folder as Claude Code does', () => {
    expect(claudeFolderName('/Users/me/My Repo.x')).toBe('-Users-me-My-Repo-x')
    expect(claudeFolderName('E:\\dvb\\desktop\\1')).toBe('E--dvb-desktop-1')
    expect(plainPath('\\\\?\\C:\\long\\path')).toBe('C:\\long\\path')
  })

  it('takes the folder from the recorded cwd, not from the lossy folder name', async () => {
    await transcript('-work-my-app', ID(1), [
      line({ type: 'queue-operation', operation: 'enqueue', content: 'hi' }),
      user('/work/my_app', 'Fix the <b>login</b> bug'),
    ])
    const { items } = await scan()
    expect(items).toEqual([
      {
        sessionId: ID(1),
        title: 'Fix the login bug',
        cwd: '/work/my_app',
        createdAt: Date.parse('2026-11-01T10:00:00.000Z'),
        updatedAt: Date.parse('2026-11-01T10:00:00.000Z'),
        subagent: false,
        prompted: true,
      },
    ])
  })

  it('titles a session by its custom title, then its AI title, then its first prompt', async () => {
    await transcript('-a', ID(1), [
      user('/a', [
        { type: 'text', text: '<system-reminder>\nscratch\n</system-reminder>\nWrite   tests' },
      ]),
      line({ type: 'ai-title', aiTitle: 'AI named' }),
      line({ type: 'custom-title', customTitle: 'Old name' }),
      line({ type: 'custom-title', customTitle: 'Chosen name' }),
    ])
    await transcript('-a', ID(2), [
      user('/a', 'p'),
      line({ type: 'ai-title', aiTitle: 'AI named' }),
    ])
    await transcript('-a', ID(3), [
      user('/a', [{ type: 'text', text: '<system-reminder>x</system-reminder>\nWrite   tests' }]),
    ])
    const titles = Object.fromEntries((await scan()).items.map((i) => [i.sessionId, i.title]))
    expect(titles).toEqual({ [ID(1)]: 'Chosen name', [ID(2)]: 'AI named', [ID(3)]: 'Write tests' })
  })

  it('marks sidechains and sessions without a prompt, and never enters subagents folders', async () => {
    await transcript('-a', ID(1), [user('/a', 'side', { isSidechain: true })])
    await transcript('-a', ID(2), [
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'summary', summary: 'Nothing said', cwd: '/a' }),
    ])
    await transcript(path.join('-a', ID(3), 'subagents'), ID(4), [user('/a', 'a subagent')])
    await writeFile(path.join(claudeDir, 'projects', '-a', 'agent-1234abcd.jsonl'), user('/a', 'x'))
    await writeFile(path.join(claudeDir, 'projects', '-a', 'notes.jsonl'), user('/a', 'x'))
    const result = await scan()
    expect(result.oldSubagents).toBe(1)
    expect(result.items.map((i) => [i.sessionId, i.subagent, i.prompted])).toEqual(
      expect.arrayContaining([
        [ID(1), true, true],
        [ID(2), false, false],
      ]),
    )
    expect(result.items).toHaveLength(2)
    const page = historyPage(result.items, new Set(), new Set(), null)
    expect(page.sessions).toEqual([])
    expect(page.hidden).toEqual({ subagents: 1, empty: 1 })
  })

  it('lists a moved session once, in the folder it moved to', async () => {
    const lines = [
      user('/work/old', 'start'),
      line({ type: 'relocated', relocatedCwd: '/work/new' }),
      user('/work/new', 'go on', { timestamp: '2026-11-02T10:00:00.000Z' }),
    ]
    await transcript('-work-old', ID(1), lines)
    await transcript('-work-new', ID(1), lines)
    // A copy left in a third folder that names neither: still listed once.
    await transcript('-elsewhere', ID(1), lines)
    const { items } = await scan()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: ID(1), cwd: '/work/new' })
    expect(items[0]!.updatedAt).toBe(Date.parse('2026-11-02T10:00:00.000Z'))
  })

  it('reads only the head and tail of a long transcript', async () => {
    const filler = line({ type: 'assistant', message: { content: 'x'.repeat(4000) } })
    const middle = Array.from({ length: Math.ceil((HEAD_BYTES + TAIL_BYTES) / 4000) * 2 }, () =>
      // A prompt in the middle is never read: the title comes from the tail.
      filler.replace('assistant', 'assistant'),
    )
    await transcript('-big', ID(1), [
      user('/big', `huge first prompt ${'y'.repeat(HEAD_BYTES)}`),
      ...middle,
      line({ type: 'custom-title', customTitle: 'Big one' }),
      line({ type: 'assistant', timestamp: '2026-11-05T00:00:00.000Z', cwd: '/big' }),
    ])
    const { items } = await scan()
    expect(items).toEqual([
      expect.objectContaining({
        sessionId: ID(1),
        title: 'Big one',
        cwd: '/big',
        prompted: true,
        updatedAt: Date.parse('2026-11-05T00:00:00.000Z'),
      }),
    ])
  })

  it('reads a changed transcript again and an unchanged one from the cache', async () => {
    const file = await transcript('-a', ID(1), [user('/a', 'first')])
    const cache = new Map()
    expect((await scanClaudeHistory(claudeDir, 'linux', cache, () => {})).items[0]!.title).toBe(
      'first',
    )
    const cached = cache.get(file)!
    expect(cached.size).toBe((await stat(file)).size)
    cached.item!.title = 'from the cache'
    expect((await scanClaudeHistory(claudeDir, 'linux', cache, () => {})).items[0]!.title).toBe(
      'from the cache',
    )
    await writeFile(file, `${user('/a', 'first')}\n${line({ type: 'ai-title', aiTitle: 'New' })}\n`)
    expect((await scanClaudeHistory(claudeDir, 'linux', cache, () => {})).items[0]!.title).toBe(
      'New',
    )
  })

  it('leaves the agent’s files as they were', async () => {
    const file = await transcript('-a', ID(1), [user('/a', 'p')])
    const before = await readFile(file, 'utf8')
    await scan()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(path.join(claudeDir, 'projects', '-a'))).toEqual([`${ID(1)}.jsonl`])
  })
})

describe('Codex threads across folders', () => {
  const thread = (over: Partial<Thread>): Thread => ({
    id: 't1',
    parentThreadId: null,
    preview: 'Fix it',
    ephemeral: false,
    model: null,
    reasoningEffort: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    status: { type: 'notLoaded' } as Thread['status'],
    cwd: '/repo',
    agentNickname: null,
    agentRole: null,
    name: null,
    turns: [],
    ...over,
  })

  it('marks a subagent’s thread and an empty one, and keeps the thread’s own cwd and times', () => {
    expect(listedEverywhere(thread({ name: 'Named' }))).toEqual({
      sessionId: 't1',
      title: 'Named',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_100_000).toISOString(),
      cwd: '/repo',
      subagent: false,
      prompted: true,
    })
    expect(listedEverywhere(thread({ parentThreadId: 'p' })).subagent).toBe(true)
    expect(listedEverywhere(thread({ ephemeral: true })).subagent).toBe(true)
    expect(listedEverywhere(thread({ preview: '  ' })).prompted).toBe(false)
  })
})

describe('AgentHistory', () => {
  const CLAUDE = 'claude-code' as AgentId
  const CODEX = 'codex' as AgentId
  const ACP = 'opencode' as AgentId

  function history(options: {
    imported?: string[]
    listAll?: (cursor: string | null) => Promise<{
      sessions: ListedEverywhere[]
      nextCursor: string | null
    }>
    gone?: string[]
  }) {
    const connection = {
      ...(options.listAll ? { listAllSessions: options.listAll } : {}),
    } as unknown as AgentConnection
    return new AgentHistory({
      platform: 'linux',
      agents: {
        has: (id) => [CLAUDE, CODEX, ACP].includes(id),
        assertEnabled: () => {},
        name: (id) => id,
        configFolder: (id) => (id === CLAUDE ? claudeDir : null),
        ensureReady: async () => ({
          connection,
          init: { capabilities: { listSessions: true } } as never,
        }),
      },
      sessions: { agentSessionIds: () => new Set(options.imported ?? []) },
      isDirectory: async (folder) => !(options.gone ?? []).includes(folder),
      log: () => {},
    })
  }

  it('lists Claude Code’s sessions with those already here marked, and keeps titles and times', async () => {
    await transcript('-a', ID(1), [user('/a', 'one'), line({ type: 'ai-title', aiTitle: 'One' })])
    await transcript('-b', ID(2), [user('/b', 'two', { timestamp: '2026-11-03T00:00:00.000Z' })])
    await transcript('-c', ID(3), [user('/c', 'gone')])
    const list = history({ imported: [ID(2)], gone: ['/c'] })
    const page = await list.list(CLAUDE, null)
    expect(page.nextCursor).toBeNull()
    expect(page.sessions.map((s) => [s.acpSessionId, s.cwd, s.imported, s.missing]).sort()).toEqual(
      [
        [ID(1), '/a', false, false],
        [ID(2), '/b', true, false],
        [ID(3), '/c', false, true],
      ],
    )
    expect(list.keptFor(CLAUDE, ID(1))).toEqual({
      title: 'One',
      titleSource: 'agent',
      createdAt: Date.parse('2026-11-01T10:00:00.000Z'),
      updatedAt: Date.parse('2026-11-01T10:00:00.000Z'),
    })
    expect(list.keptFor(CLAUDE, ID(9))).toEqual({})
    expect(list.keptFor(CODEX, ID(1))).toEqual({})
  })

  it('asks Codex for every folder’s threads, page by page, without subagents or empty ones', async () => {
    const asked: (string | null)[] = []
    const list = history({
      imported: ['t2'],
      listAll: async (cursor) => {
        asked.push(cursor)
        const all = [
          { id: 't1', cwd: '\\\\?\\C:\\repo' },
          { id: 't2', cwd: '/b' },
          { id: 't3', cwd: '/b', parentThreadId: 't1' },
          { id: 't4', cwd: '/b', preview: '' },
        ]
        return {
          sessions: all.map((t) =>
            listedEverywhere({
              id: t.id,
              parentThreadId: t.parentThreadId ?? null,
              preview: t.preview ?? 'Prompt',
              ephemeral: false,
              model: null,
              reasoningEffort: null,
              createdAt: 1,
              updatedAt: 2,
              status: { type: 'notLoaded' } as Thread['status'],
              cwd: t.cwd,
              agentNickname: null,
              agentRole: null,
              name: null,
              turns: [],
            }),
          ),
          nextCursor: cursor === null ? 'next' : null,
        }
      },
    })
    const first = await list.list(CODEX, null)
    expect(first.nextCursor).toBe('next')
    expect(first.hidden).toEqual({ subagents: 1, empty: 1 })
    expect(first.sessions.map((s) => [s.acpSessionId, s.cwd, s.imported])).toEqual([
      ['t1', 'C:\\repo', false],
      ['t2', '/b', true],
    ])
    await list.list(CODEX, 'next')
    expect(asked).toEqual([null, 'next'])
  })

  it('refuses an unknown agent and one that cannot list without a folder', async () => {
    await expect(history({}).list('nope' as AgentId, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(history({}).list(ACP, null)).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
  })
})

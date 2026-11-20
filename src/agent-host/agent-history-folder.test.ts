import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import { AgentHistory } from './agent-history'
import {
  compareBytes,
  folderSource,
  planCopy,
  runCopy,
  scanCodexRollouts,
  type PlanInput,
} from './agent-history-folder'
import { claudeProjectFolder } from './prompt-cache'
import { bufferSource } from './usage/lines'

const SESSION = '1b3e33b5-0398-45a8-95d7-eb6d1548192c'
const OTHER = '2c4f44c6-1409-46b9-86e8-fc7e2659203d'
const THREAD = '01a17d72-43a7-7b00-81ae-b6f1300415f5'
const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const CLAUDE = 'claude-code' as AgentId
const CODEX = 'codex' as AgentId

let base: string
let cwd: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-history-folder-')))
  cwd = path.join(base, 'work')
  await mkdir(cwd)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const message = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null) =>
  JSON.stringify({
    type,
    uuid,
    parentUuid,
    isSidechain: false,
    cwd,
    timestamp: new Date(NOW).toISOString(),
    message: { role: type, content: type === 'user' ? `prompt ${uuid}` : 'reply' },
  })

const start = () => [message('user', 'u1', null), message('assistant', 'a1', 'u1')]
const further = () => [...start(), message('user', 'u2', 'a1'), message('assistant', 'a2', 'u2')]

async function write(file: string, lines: string[] | Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines)
  return file
}

/** Every file under a folder with its bytes and time, to see it was only read. */
async function snapshot(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(folder, { recursive: true })) {
    const file = path.join(folder, name)
    const info = await stat(file)
    if (info.isFile()) out[name] = `${info.mtimeMs}:${await readFile(file, 'utf8')}`
  }
  return out
}

function claudeInput(target: string, file: string, extra: Partial<PlanInput> = {}): PlanInput {
  return {
    harness: 'claude-code',
    target,
    session: { sessionId: SESSION, title: 't', cwd, createdAt: NOW },
    file,
    missing: false,
    now: NOW,
    ...extra,
  }
}

describe('a chosen folder of an agent’s', () => {
  it('finds Claude Code’s sessions in its configuration, projects or one project folder', async () => {
    const config = path.join(base, 'backup', '.claude')
    await write(path.join(config, 'projects', '-x', `${SESSION}.jsonl`), start())
    const projects = path.join(config, 'projects')
    await expect(folderSource(config, 'claude-code')).resolves.toEqual({
      harness: 'claude-code',
      root: projects,
      only: null,
    })
    await expect(folderSource(projects, 'claude-code')).resolves.toEqual({
      harness: 'claude-code',
      root: projects,
      only: null,
    })
    await expect(folderSource(path.join(projects, '-x'), 'claude-code')).resolves.toEqual({
      harness: 'claude-code',
      root: projects,
      only: '-x',
    })
    await expect(folderSource(cwd, 'claude-code')).resolves.toBeNull()
    await expect(folderSource(config, 'codex')).resolves.toBeNull()
  })

  it('finds Codex’s rollouts in its home, its sessions folder or a day folder of it', async () => {
    const home = path.join(base, 'old', '.codex')
    const day = path.join(home, 'sessions', '2026', '10', '27')
    await write(path.join(day, `rollout-2026-10-27T21-00-02-${THREAD}.jsonl`), ['{}'])
    await expect(folderSource(home, 'codex')).resolves.toEqual({
      harness: 'codex',
      root: path.join(home, 'sessions'),
      home,
    })
    await expect(folderSource(path.join(home, 'sessions'), 'codex')).resolves.toEqual({
      harness: 'codex',
      root: path.join(home, 'sessions'),
      home,
    })
    await expect(folderSource(day, 'codex')).resolves.toEqual({
      harness: 'codex',
      root: day,
      home: null,
    })
    await expect(folderSource(cwd, 'codex')).resolves.toBeNull()
  })

  it('lists Codex’s threads from whole and compressed rollouts, by the names Codex gave them', async () => {
    const home = path.join(base, 'codex-home')
    const sessions = path.join(home, 'sessions')
    const meta = (id: string, source: unknown) =>
      JSON.stringify({
        timestamp: '2026-10-27T13:00:02.000Z',
        type: 'session_meta',
        payload: { id, cwd, timestamp: '2026-10-27T13:00:02.000Z', source },
      })
    const prompt = (text: string) =>
      JSON.stringify({
        timestamp: '2026-10-27T13:05:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text }] },
        },
      })
    await write(
      path.join(sessions, '2026', '10', '27', `rollout-2026-10-27T21-00-02-${THREAD}.jsonl`),
      [meta(THREAD, 'cli'), prompt('Fix the build')],
    )
    const child = '01a17d72-0000-7000-8000-000000000001'
    await write(
      path.join(sessions, '2026', '10', '28', `rollout-2026-10-28T08-00-00-${child}.jsonl.zst`),
      zstdCompressSync(
        Buffer.from(
          `${meta(child, { subagent: { other: 'guardian' } })}\n${JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'check it' },
          })}\n`,
        ),
      ),
    )
    await write(path.join(home, 'session_index.jsonl'), [
      JSON.stringify({ id: THREAD, thread_name: 'Build fix', updated_at: '2026-10-27T14:00:00Z' }),
    ])
    const source = await folderSource(home, 'codex')
    const scan = await scanCodexRollouts(source!, () => {})
    expect(
      scan.items.map((item) => [item.sessionId, item.title, item.subagent, item.prompted]),
    ).toEqual(
      expect.arrayContaining([
        [THREAD, 'Build fix', false, true],
        [child, 'check it', true, true],
      ]),
    )
    expect(scan.items.find((item) => item.sessionId === THREAD)?.cwd).toBe(cwd)
    expect(scan.files.get(child)?.endsWith('.zst')).toBe(true)
  })

  it('tells how two byte streams stand, whatever their chunks', async () => {
    const of = (text: string) => bufferSource(Buffer.from(text))
    await expect(compareBytes(of('abc'), of('abc'))).resolves.toBe('same')
    await expect(compareBytes(of('abcd'), of('abc'))).resolves.toBe('ahead')
    await expect(compareBytes(of('ab'), of('abc'))).resolves.toBe('behind')
    await expect(compareBytes(of('abd'), of('abc'))).resolves.toBe('fork')
    await expect(compareBytes(of(''), of(''))).resolves.toBe('same')
  })
})

describe('copying a chosen folder’s Claude Code session into the agent’s own', () => {
  let target: string
  let source: string
  let home: string

  beforeEach(async () => {
    target = path.join(base, 'own', '.claude')
    source = path.join(base, 'backup', 'projects', 'anything')
    home = path.join(target, 'projects', claudeProjectFolder(cwd))
  })

  it('writes a new transcript where Claude Code resumes it, with its subagents, reading only', async () => {
    const file = await write(path.join(source, `${SESSION}.jsonl`), further())
    await write(path.join(source, SESSION, 'subagents', 'agent-a.jsonl'), ['{"x":1}'])
    await write(path.join(source, SESSION, 'tool-results', 'r.txt'), ['out'])
    await utimes(file, new Date(NOW - 60_000), new Date(NOW - 60_000))
    const before = await snapshot(path.dirname(source))
    const plan = await planCopy(claudeInput(target, file))
    expect(plan.action).toBe('new')
    expect(plan.transcript).toEqual({ from: file, to: path.join(home, `${SESSION}.jsonl`) })
    expect(plan.extra.map((f) => path.relative(home, f.to)).sort()).toEqual([
      path.join(SESSION, 'subagents', 'agent-a.jsonl'),
      path.join(SESSION, 'tool-results', 'r.txt'),
    ])
    await expect(runCopy(plan)).resolves.toEqual({
      acpSessionId: SESSION,
      status: 'copied',
      written: 3,
    })
    expect(await readFile(path.join(home, `${SESSION}.jsonl`), 'utf8')).toBe(
      `${further().join('\n')}\n`,
    )
    expect((await stat(path.join(home, `${SESSION}.jsonl`))).mtimeMs).toBe(NOW - 60_000)
    expect(await snapshot(path.dirname(source))).toEqual(before)
  })

  it('leaves the agent’s copy as it is when it holds as much or more, adding what it lacks', async () => {
    const file = await write(path.join(source, `${SESSION}.jsonl`), start())
    await write(path.join(source, SESSION, 'subagents', 'agent-a.jsonl'), ['{"new":1}'])
    await write(path.join(source, SESSION, 'subagents', 'agent-b.jsonl'), ['{"new":2}'])
    await write(path.join(home, `${SESSION}.jsonl`), start())
    await write(path.join(home, SESSION, 'subagents', 'agent-a.jsonl'), ['{"own":1}'])
    const same = await planCopy(claudeInput(target, file))
    expect(same.action).toBe('same')
    expect(same.transcript).toBeNull()
    expect(same.extra.map((f) => path.basename(f.to))).toEqual(['agent-b.jsonl'])
    await expect(runCopy(same)).resolves.toMatchObject({ status: 'present', written: 1 })
    expect(await readFile(path.join(home, SESSION, 'subagents', 'agent-a.jsonl'), 'utf8')).toBe(
      '{"own":1}\n',
    )

    await write(path.join(home, `${SESSION}.jsonl`), further())
    await expect(planCopy(claudeInput(target, file))).resolves.toMatchObject({
      action: 'older',
      transcript: null,
      extra: [],
    })
  })

  it('replaces a copy that holds less, keeping it beside first, and never one that went another way', async () => {
    const file = await write(path.join(source, `${SESSION}.jsonl`), further())
    const own = await write(path.join(home, `${SESSION}.jsonl`), start())
    const plan = await planCopy(claudeInput(target, file))
    expect(plan.action).toBe('newer')
    const backup = `${own}.kite-bak-2026-11-19T12-00-00-000Z`
    expect(plan.replaced).toMatchObject({ file: own, backup })
    await expect(runCopy(plan)).resolves.toMatchObject({ status: 'copied', written: 1 })
    expect(await readFile(own, 'utf8')).toBe(`${further().join('\n')}\n`)
    expect(await readFile(backup, 'utf8')).toBe(`${start().join('\n')}\n`)

    await write(own, [...start(), message('user', 'x2', 'a1')])
    await expect(planCopy(claudeInput(target, file))).resolves.toMatchObject({
      action: 'conflict',
      transcript: null,
    })
    await expect(planCopy(claudeInput(target, file, { missing: true }))).resolves.toMatchObject({
      action: 'missing',
    })
  })

  it('writes nothing over a file that appeared or changed since the plan', async () => {
    const file = await write(path.join(source, `${SESSION}.jsonl`), further())
    const plan = await planCopy(claudeInput(target, file))
    const late = await write(path.join(home, `${SESSION}.jsonl`), ['{"late":1}'])
    await expect(runCopy(plan)).resolves.toMatchObject({ status: 'skipped', written: 0 })
    expect(await readFile(late, 'utf8')).toBe('{"late":1}\n')

    await write(late, start())
    const newer = await planCopy(claudeInput(target, file))
    expect(newer.action).toBe('newer')
    await write(late, [...start(), ''])
    await expect(runCopy(newer)).resolves.toMatchObject({ status: 'skipped', message: 'changed' })
    expect(await readdir(home)).toEqual([`${SESSION}.jsonl`])
  })
})

describe('copying a chosen folder’s Codex thread into the agent’s own', () => {
  const name = `rollout-2026-10-27T21-00-02-${THREAD}.jsonl`
  let target: string
  let from: string

  beforeEach(() => {
    target = path.join(base, 'own', '.codex')
    from = path.join(base, 'other', '.codex', 'sessions', '2026', '10', '27')
  })

  const input = (file: string): PlanInput => ({
    harness: 'codex',
    target,
    session: { sessionId: THREAD, title: null, cwd, createdAt: NOW },
    file,
    missing: false,
    now: NOW,
  })

  it('puts a new rollout in the day folder Codex looks in, compressed or not', async () => {
    const file = await write(path.join(from, `${name}.zst`), zstdCompressSync(Buffer.from('a\n')))
    const plan = await planCopy(input(file))
    expect(plan).toMatchObject({
      action: 'new',
      transcript: {
        from: file,
        to: path.join(target, 'sessions', '2026', '10', '27', `${name}.zst`),
      },
    })
    await expect(runCopy(plan)).resolves.toMatchObject({ status: 'copied', written: 1 })
  })

  it('replaces an older rollout of the same kind and leaves the rest alone', async () => {
    const file = await write(path.join(from, name), ['a', 'b'])
    const own = await write(path.join(target, 'sessions', '2026', '10', '27', name), ['a'])
    const plan = await planCopy(input(file))
    expect(plan).toMatchObject({ action: 'newer', transcript: { to: own } })
    await runCopy(plan)
    expect(await readFile(own, 'utf8')).toBe('a\nb\n')
    expect(await readFile(`${own}.kite-bak-2026-11-19T12-00-00-000Z`, 'utf8')).toBe('a\n')

    await expect(planCopy(input(file))).resolves.toMatchObject({ action: 'same' })
    await write(own, ['a', 'b', 'c'])
    await expect(planCopy(input(file))).resolves.toMatchObject({ action: 'older' })
    await write(own, ['a', 'x'])
    await expect(planCopy(input(file))).resolves.toMatchObject({ action: 'conflict' })

    await rm(own)
    const packed = await write(`${own}.zst`, zstdCompressSync(Buffer.from('a\n')))
    const mixed = await planCopy(input(file))
    expect(mixed.action).toBe('conflict')
    expect(await readFile(packed)).toEqual(zstdCompressSync(Buffer.from('a\n')))
  })
})

describe('the import from another folder', () => {
  let ownClaude: string
  let ownCodex: string
  let backup: string

  beforeEach(async () => {
    ownClaude = path.join(base, 'own', '.claude')
    ownCodex = path.join(base, 'own', '.codex')
    backup = path.join(base, 'backup', '.claude')
    await write(
      path.join(backup, 'projects', claudeProjectFolder(cwd), `${SESSION}.jsonl`),
      further(),
    )
    await write(path.join(backup, 'projects', '-gone', `${OTHER}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: path.join(base, 'gone'), message: { content: 'hi' } }),
    ])
  })

  function history() {
    return new AgentHistory({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      agents: {
        has: (id) => id === CLAUDE || id === CODEX || id === ('opencode' as AgentId),
        assertEnabled: () => {},
        name: (id) => id,
        configFolder: (id) => (id === CLAUDE ? ownClaude : id === CODEX ? ownCodex : null),
        ensureReady: async () => {
          throw new Error('not asked')
        },
      },
      sessions: { agentSessionIds: () => new Set() },
      log: () => {},
      now: () => NOW,
    })
  }

  it('lists a folder’s sessions, plans the files it writes and copies them once', async () => {
    const list = history()
    const page = await list.list(CLAUDE, null, backup)
    expect(page.source).toBe(path.join(backup, 'projects'))
    expect(page.sessions.map((s) => [s.acpSessionId, s.missing]).sort()).toEqual([
      [SESSION, false],
      [OTHER, true],
    ])
    const plan = await list.planCopy(CLAUDE, backup, [SESSION, OTHER, 'unknown'])
    expect(plan.target).toBe(ownClaude)
    expect(plan.items.map((item) => [item.acpSessionId, item.action, item.files])).toEqual([
      [
        SESSION,
        'new',
        [path.join(ownClaude, 'projects', claudeProjectFolder(cwd), `${SESSION}.jsonl`)],
      ],
      [OTHER, 'missing', []],
    ])
    await expect(list.copy(plan.token)).resolves.toEqual({
      items: [
        { acpSessionId: SESSION, status: 'copied', written: 1 },
        { acpSessionId: OTHER, status: 'skipped', written: 0 },
      ],
    })
    await expect(list.copy(plan.token)).rejects.toMatchObject({ code: 'not_found' })
    expect(list.keptFor(CLAUDE, SESSION)).toMatchObject({ title: 'prompt u1' })
  })

  it('refuses a folder that is not there, holds none of the agent’s, or is its own', async () => {
    const list = history()
    await expect(list.list(CLAUDE, null, path.join(base, 'nowhere'))).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(list.list(CODEX, null, backup)).rejects.toMatchObject({ code: 'not_found' })
    await write(path.join(ownClaude, 'projects', '-x', `${SESSION}.jsonl`), start())
    await expect(list.list(CLAUDE, null, ownClaude)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(list.list(CLAUDE, null, path.join(ownClaude, 'projects'))).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(list.list('opencode' as AgentId, null, backup)).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
  })

  it('plans only from a folder it listed', async () => {
    const list = history()
    await expect(list.planCopy(CLAUDE, backup, [SESSION])).rejects.toMatchObject({
      code: 'not_found',
    })
    await list.list(CLAUDE, null, backup)
    await expect(list.planCopy(CLAUDE, backup, ['unknown'])).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(list.copy('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

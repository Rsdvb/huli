// Huli: the hosts' side of a move with the agents' own histories: Claude Code's transcript lands
// under the project folder Claude Code names for the target's worktree, with every cwd in it and
// its subagents' rewritten; Codex's rollout in its day folder; an id the target already has gets
// a new one; and what a crashed apply left is taken back at the next move.

import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import type { MoveHost, MoveProgress } from '@shared/session-move'
import { SessionMover } from '../../main/session-move'
import { createExec } from '../git/exec'
import { claudeProjectFolder } from '../prompt-cache'
import type { MoveAdoption, MoveFacts } from '../sessions'
import { tempFolder } from '../testing/temp'
import { SessionMoves } from './service'
import { moveValidators } from './validate'

const PLATFORM = process.platform as Platform
const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const exec = createExec(() => ({ ...process.env, ...ENV })).exec
const ID = '0c1f2e3d-4b5a-4697-8a8b-9c0d1e2f3a4b'
const TARGET = 'f'.repeat(32)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
}

async function there(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

function status(agentId: AgentId): AgentStatus {
  return {
    id: agentId,
    harnessId: agentId,
    name: agentId,
    isDefault: true,
    registered: true,
    state: 'ready',
    signIn: 'signed-in',
  } as unknown as AgentStatus
}

interface Side {
  home: string
  project: string
  moves: SessionMoves
  adopted: MoveAdoption[]
  marked: unknown[]
  /** Agent session ids the side's Kite holds already. */
  held: Set<string>
}

async function side(
  dir: string,
  name: string,
  origin: string,
  facts: (project: string) => Partial<MoveFacts>,
  adopt?: () => Promise<void>,
): Promise<Side> {
  const home = path.join(dir, name)
  await mkdir(home, { recursive: true })
  git(home, 'clone', '-q', origin, 'kite')
  const project = await realpath(path.join(home, 'kite'))
  const adopted: MoveAdoption[] = []
  const marked: unknown[] = []
  const held = new Set<string>()
  const moves = new SessionMoves({
    platform: PLATFORM,
    homeDir: home,
    folder: path.join(home, 'moves'),
    exec,
    ready: async () => {},
    sessions: {
      moveFacts: () => ({
        agentId: 'claude-code',
        acpSessionId: ID,
        projectPath: project,
        cwd: project,
        worktree: null,
        title: 'Moving day',
        createdAt: 1,
        configDir: null,
        carry: false,
        problems: [],
        ...facts(project),
      }),
      moveThread: async () => ({ entries: [], blobs: [] }),
      adoptMoved: async (input) => {
        await adopt?.()
        adopted.push(input)
        return { id: `moved-${adopted.length}` } as SessionSummary
      },
      removeAdopted: async () => {},
      setMovedTo: (_id, to) => void marked.push(to),
      agentSessionIds: () => held,
    },
    agents: {
      statuses: () => [status('claude-code'), status('codex')],
      name: (agentId) => agentId,
      configFolder: (agentId) => path.join(home, agentId === 'codex' ? '.codex' : '.claude'),
    },
    projects: { paths: () => [project], add: async () => {}, remove: () => {} },
    worktreeRoot: async (folder) => {
      const root = `${folder}-worktrees`
      await mkdir(root, { recursive: true })
      return realpath(root)
    },
    log: () => {},
  })
  return { home, project, moves, adopted, marked, held }
}

/** Calls a side's service as its host would: through the method's validator first. */
async function dispatch(moves: SessionMoves, method: string, raw: unknown): Promise<unknown> {
  const validators = moveValidators(PLATFORM) as Record<string, (params: unknown) => never>
  const params = validators[method]!(structuredClone(raw)) as Record<string, never>
  switch (method) {
    case 'moves.inspect':
      return moves.inspect(params.sessionId)
    case 'moves.pack':
      return moves.pack(params.sessionId, params.moveId, params.haves)
    case 'moves.part':
      return moves.part(params.moveId, params.name, params.offset)
    case 'moves.finish':
      return moves.finish(params.moveId, params.sessionId, params.to)
    case 'moves.abort':
      return moves.abort(params.moveId)
    case 'moves.check':
      return moves.check(params)
    case 'moves.prepare':
      return moves.prepare(params.moveId, params.project, params.url)
    case 'moves.receive':
      return moves.receive(params.moveId, params.name, params.offset, params.size, params.bytes)
    case 'moves.apply':
      return moves.apply(params as never)
    case 'moves.undo':
      return moves.undo(params.moveId)
    case 'moves.commit':
      return moves.commit(params.moveId)
  }
  throw new Error(`No ${method}`)
}

function run(source: Side, target: Side): Promise<MoveProgress> {
  return new Promise((resolve) => {
    const mover = new SessionMover({
      call: (host: MoveHost, method, params) =>
        dispatch(host === null ? source.moves : target.moves, method, params),
      hostName: (host) => (host === null ? 'Laptop' : 'Box'),
      online: () => true,
      changed: (progress) => {
        if (progress.state !== 'running') resolve(progress)
      },
      log: () => {},
    })
    mover.start(null, 'session-1', TARGET)
  })
}

async function repo(dir: string): Promise<string> {
  const origin = path.join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  const seed = path.join(dir, 'seed')
  git(dir, 'clone', '-q', origin, 'seed')
  await writeFile(path.join(seed, 'a.txt'), 'one\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'first')
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  return origin
}

const lines = (cwd: string, sep: string): string =>
  [
    { type: 'user', cwd, sessionId: ID, message: { content: 'hello' } },
    {
      type: 'assistant',
      cwd,
      sessionId: ID,
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${cwd}${sep}a.txt` } }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n'

describe('the hosts’ side of a move', { timeout: PLATFORM === 'win32' ? 120_000 : 40_000 }, () => {
  it('lands Claude Code’s transcript under the worktree’s own project folder, rewritten', async () => {
    const dir = await realpath(await tempFolder('kite-move-service-'))
    const origin = await repo(dir)
    const source = await side(dir, 'laptop', origin, () => ({}))
    const target = await side(dir, 'box', origin, () => ({}))
    git(source.project, 'checkout', '-q', '-b', 'feat/claude')
    await writeFile(path.join(source.project, 'b.txt'), 'new\n')
    const own = path.join(source.home, '.claude', 'projects', claudeProjectFolder(source.project))
    await mkdir(path.join(own, ID, 'subagents'), { recursive: true })
    await writeFile(path.join(own, `${ID}.jsonl`), lines(source.project, path.sep))
    await writeFile(
      path.join(own, ID, 'subagents', 'agent-1.jsonl'),
      lines(source.project, path.sep),
    )

    const progress = await run(source, target)
    expect(progress.error).toBeNull()
    const adoption = target.adopted[0]!
    expect(adoption.resume).toEqual({ acpSessionId: ID })
    const cwd = adoption.worktree!.path
    expect(path.dirname(cwd)).toBe(await realpath(`${target.project}-worktrees`))
    const folder = path.join(target.home, '.claude', 'projects', claudeProjectFolder(cwd))
    const written = (await readFile(path.join(folder, `${ID}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(written.map((line) => line.cwd)).toEqual([cwd, cwd])
    expect(written[1].message.content[0].input.file_path).toBe(path.join(cwd, 'a.txt'))
    const sub = await readFile(path.join(folder, ID, 'subagents', 'agent-1.jsonl'), 'utf8')
    expect(JSON.parse(sub.split('\n')[0]!).cwd).toBe(cwd)
    expect(await there(path.join(cwd, 'b.txt'))).toBe(true)
    expect(source.marked).toEqual([
      expect.objectContaining({ hostId: TARGET, name: 'Box', sessionId: 'moved-1' }),
    ])
  })

  it('gives the session a new id when the target’s Kite has its id already', async () => {
    const dir = await realpath(await tempFolder('kite-move-service-'))
    const origin = await repo(dir)
    const source = await side(dir, 'laptop', origin, () => ({}))
    const target = await side(dir, 'box', origin, () => ({}))
    target.held.add(ID)
    const own = path.join(source.home, '.claude', 'projects', claudeProjectFolder(source.project))
    await mkdir(own, { recursive: true })
    await writeFile(path.join(own, `${ID}.jsonl`), lines(source.project, path.sep))

    const progress = await run(source, target)
    expect(progress.error).toBeNull()
    const resume = target.adopted[0]!.resume as { acpSessionId: string }
    expect(resume.acpSessionId).not.toBe(ID)
    const folder = path.join(
      target.home,
      '.claude',
      'projects',
      claudeProjectFolder(target.adopted[0]!.worktree!.path),
    )
    const written = await readFile(path.join(folder, `${resume.acpSessionId}.jsonl`), 'utf8')
    expect(written).not.toContain(ID)
    expect(JSON.parse(written.split('\n')[0]!).sessionId).toBe(resume.acpSessionId)
  })

  it('puts Codex’s rollout in its day folder under its own name', async () => {
    const dir = await realpath(await tempFolder('kite-move-service-'))
    const origin = await repo(dir)
    const facts = () => ({ agentId: 'codex' as const })
    const source = await side(dir, 'laptop', origin, facts)
    const target = await side(dir, 'box', origin, facts)
    const name = `rollout-2026-11-20T10-00-00-${ID}.jsonl`
    const day = path.join(source.home, '.codex', 'sessions', '2026', '11', '20')
    await mkdir(day, { recursive: true })
    const meta = { type: 'session_meta', payload: { id: ID, cwd: source.project } }
    await writeFile(path.join(day, name), `${JSON.stringify(meta)}\n`)

    const progress = await run(source, target)
    expect(progress.error).toBeNull()
    const placed = path.join(target.home, '.codex', 'sessions', '2026', '11', '20', name)
    const written = JSON.parse((await readFile(placed, 'utf8')).trim())
    expect(written.payload).toEqual({ id: ID, cwd: target.adopted[0]!.worktree!.path })
  })

  it('takes back at the next move what an apply that never finished left', async () => {
    const dir = await realpath(await tempFolder('kite-move-service-'))
    const origin = await repo(dir)
    const source = await side(dir, 'laptop', origin, () => ({}))
    // The target's host goes down while it adds the session: its adoption never answers.
    const target = await side(
      dir,
      'box',
      origin,
      () => ({}),
      () => new Promise(() => {}),
    )
    const own = path.join(source.home, '.claude', 'projects', claudeProjectFolder(source.project))
    await mkdir(own, { recursive: true })
    await writeFile(path.join(own, `${ID}.jsonl`), lines(source.project, path.sep))
    void run(source, target)
    const worktrees = `${target.project}-worktrees`
    const projects = path.join(target.home, '.claude', 'projects')
    for (let i = 0; i < 400 && (await readdir(projects).catch(() => [])).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await readdir(worktrees)).length).toBe(1)
    expect(git(target.project, 'branch', '--list', 'main').trim()).not.toBe('')

    // The host runs again: its first move call finds the journal and undoes it.
    const again = await side(dir, 'box-again', origin, () => ({}))
    const restarted = new SessionMoves({
      ...(again.moves as unknown as { deps: ConstructorParameters<typeof SessionMoves>[0] }).deps,
      homeDir: target.home,
      folder: path.join(target.home, 'moves'),
    })
    await restarted.check({ agentId: 'claude-code', remotes: [], remote: null })
    expect(await readdir(worktrees)).toEqual([])
    // The folders the move made for the transcript go too, as they hold nothing else.
    expect(await there(projects)).toBe(false)
    expect(git(target.project, 'branch', '--format=%(refname:short)').trim()).toBe('main')
    expect(await readdir(path.join(target.home, 'moves'))).toEqual([])
  })
})

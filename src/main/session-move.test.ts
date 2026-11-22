// Huli: a session moved between two whole agent hosts on temp folders, as two computers, the way
// main runs it: each host reached through a desktop device's port, each step checked by the hosts'
// validators. A move that fails after the target applied it, or whose part arrived changed, leaves
// the target as it was and the source working, unmarked.

import { execFileSync } from 'node:child_process'
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostMethod } from '@shared/agent-host'
import { PortRequestError } from '@shared/port-rpc'
import type { MoveHost, MoveProgress } from '@shared/session-move'
import { startTestHost, type TestHost, type TestPort } from '../agent-host/testing/harness'
import { tempFolder } from '../agent-host/testing/temp'
import { SessionMover } from './session-move'

const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const BOX = 'b'.repeat(32)
const LAPTOP = { id: 'c'.repeat(32), name: 'Laptop', browser: true as const }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
}

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

interface World {
  source: TestHost
  target: TestHost
  /** Each host as main reaches it: this computer's, and the box's as its desktop device. */
  ports: { source: TestPort; target: TestPort }
  sourceProject: string
  targetProject: string
  sessionId: string
}

async function world(): Promise<World> {
  const dir = await realpath(await tempFolder('kite-move-'))
  const origin = path.join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  const sourceProject = path.join(dir, 'laptop', 'kite')
  const targetProject = path.join(dir, 'box', 'kite')
  await mkdir(path.dirname(sourceProject), { recursive: true })
  await mkdir(path.dirname(targetProject), { recursive: true })
  git(path.dirname(sourceProject), 'clone', '-q', origin, 'kite')
  await writeFile(path.join(sourceProject, 'a.txt'), 'one\n')
  git(sourceProject, 'add', '.')
  git(sourceProject, 'commit', '-q', '-m', 'first')
  git(sourceProject, 'push', '-q', '-u', 'origin', 'main')
  git(path.dirname(targetProject), 'clone', '-q', origin, 'kite')
  git(sourceProject, 'checkout', '-q', '-b', 'feat/move')
  await writeFile(path.join(sourceProject, 'a.txt'), 'one\nlocal\n')
  git(sourceProject, 'commit', '-q', '-am', 'local only')
  await writeFile(path.join(sourceProject, 'b.txt'), 'uncommitted\n')

  const source = await startTestHost({ projectDir: sourceProject, agentEnv: ENV })
  const target = await startTestHost({ projectDir: targetProject, agentEnv: ENV })
  hosts.push(source, target)
  const window = source.connect()
  const ports = { source: window, target: target.connect(LAPTOP) }
  await ports.target.request('projects.add', { path: target.project })
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: source.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'remember the word pineapple' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'agent')
  await window.untilStatus(id, 'ready')
  return {
    source,
    target,
    ports,
    sourceProject: source.project,
    targetProject: target.project,
    sessionId: id,
  }
}

type Hook = (host: MoveHost, method: string, params: unknown) => unknown

let nextCall = 1

/** A request as main makes it of this computer's host: by its own messages, as no window. */
async function asMain(host: TestHost, method: string, params: unknown): Promise<unknown> {
  const callId = nextCall++
  host.host.mainCall(callId, method, structuredClone(params))
  for (;;) {
    const answer = host.sent.find(
      (message) => message.type === 'host:main-answer' && message.callId === callId,
    )
    if (answer?.type === 'host:main-answer') {
      if ('error' in answer) throw new PortRequestError(answer.error)
      return answer.result
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function mover(w: World, hook?: Hook) {
  const seen: MoveProgress[] = []
  const done = new Promise<MoveProgress>((resolve) => {
    const instance = new SessionMover({
      call: async (host, method, params) => {
        const changed = hook?.(host, method, params) ?? params
        if (host === null) return asMain(w.source, method, changed)
        return w.ports.target.request(method as HostMethod, changed as never)
      },
      hostName: (host) => (host === null ? 'Laptop' : 'Box'),
      online: () => true,
      changed: (progress) => {
        seen.push(progress)
        if (progress.state !== 'running') resolve(progress)
      },
      log: () => {},
    })
    queueMicrotask(() => instance.start(null, w.sessionId, BOX))
  })
  return { done, seen }
}

function branches(cwd: string): string[] {
  return git(cwd, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
}

describe('moving a session between two hosts', { timeout: 120_000 }, () => {
  it('brings the branch, the changes and the conversation over, and marks the source', async () => {
    const w = await world()
    const before = git(w.sourceProject, 'status', '--porcelain=v1')
    const { done, seen } = mover(w)
    const progress = await done
    expect(progress.error).toBeNull()
    expect(progress.state).toBe('done')
    expect(seen.some((p) => p.transfer !== null && p.transfer.sent > 0)).toBe(true)
    const moved = progress.result!
    expect(moved.projectPath).toBe(w.targetProject)

    // The target: a worktree of its own project on the branch, with the uncommitted file.
    const listed = await w.ports.target.request('sessions.list', {})
    const session = listed.find((item) => item.id === moved.sessionId)!
    expect(session.worktree?.branch).toBe('feat/move')
    const cwd = session.worktree!.path
    expect(git(cwd, 'status', '--porcelain=v1')).toBe(before)
    expect(git(cwd, 'log', '-1', '--format=%s').trim()).toBe('local only')
    // The conversation goes on from Kite's copy, carried to the fake agent.
    await w.ports.target.open(moved.sessionId)
    const entries = w.ports.target.entries(moved.sessionId)
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'user' &&
          entry.content.some((b) => b.type === 'text' && b.text.includes('pineapple')),
      ),
    ).toBe(true)
    expect(entries.at(-1)?.kind).toBe('takeover')

    // The source: as it was, marked with where it went.
    expect(git(w.sourceProject, 'status', '--porcelain=v1')).toBe(before)
    const own = (await w.ports.source.request('sessions.list', {})).find(
      (item) => item.id === w.sessionId,
    )!
    expect(own.movedTo).toMatchObject({ hostId: BOX, name: 'Box', sessionId: moved.sessionId })
    await w.ports.source.request('sessions.clearMoved', { sessionId: w.sessionId })
    const cleared = (await w.ports.source.request('sessions.list', {})).find(
      (item) => item.id === w.sessionId,
    )!
    expect(cleared.movedTo).toBeUndefined()
    // Nothing of the move is left staged on either host.
    expect(await readdir(path.join(w.source.dir, 'moves')).catch(() => [])).toEqual([])
    expect(await readdir(path.join(w.target.dir, 'moves')).catch(() => [])).toEqual([])
  })

  it('undoes everything on the target when the source cannot finish', async () => {
    const w = await world()
    const targetBranches = branches(w.targetProject)
    const { done } = mover(w, (_host, method) => {
      if (method === 'moves.finish') {
        throw new PortRequestError({ code: 'host_offline', message: 'The host is not connected' })
      }
    })
    const progress = await done
    expect(progress.state).toBe('failed')
    expect(progress.reason).toBe('offline')
    expect(progress.undone).toBe(true)
    expect(progress.steps.find((s) => s.step === 'finish')?.state).toBe('failed')
    expect(await w.ports.target.request('sessions.list', {})).toEqual([])
    expect(branches(w.targetProject)).toEqual(targetBranches)
    const worktrees = path.join(path.dirname(w.targetProject), 'kite-worktrees')
    expect(await readdir(worktrees).catch(() => [])).toEqual([])
    const own = (await w.ports.source.request('sessions.list', {})).find(
      (item) => item.id === w.sessionId,
    )!
    expect(own.movedTo).toBeUndefined()
    expect(await readdir(path.join(w.source.dir, 'moves')).catch(() => [])).toEqual([])
    expect(await readdir(path.join(w.target.dir, 'moves')).catch(() => [])).toEqual([])
  })

  it('refuses a part that arrived changed, and leaves the target as it was', async () => {
    const w = await world()
    const { done } = mover(w, (_host, method, params) => {
      if (method !== 'moves.receive') return undefined
      const part = params as { bytes: Uint8Array }
      const bytes = new Uint8Array(part.bytes)
      bytes[0] = bytes[0]! ^ 0xff
      return { ...part, bytes }
    })
    const progress = await done
    expect(progress.state).toBe('failed')
    expect(progress.steps.find((s) => s.step === 'apply')?.state).toBe('failed')
    expect(progress.error).toMatch(/arrived changed/)
    expect(await w.ports.target.request('sessions.list', {})).toEqual([])
    expect(branches(w.targetProject)).toEqual(['main'])
  })

  it('lets only a desktop app run a move', async () => {
    const w = await world()
    const phone = w.target.connect({ id: 'd'.repeat(32), name: 'Phone' })
    await expect(
      phone.request('moves.check', { agentId: 'fake-agent', remotes: [], remote: null }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    const window = w.target.connect()
    await expect(
      window.request('moves.check', { agentId: 'fake-agent', remotes: [], remote: null }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

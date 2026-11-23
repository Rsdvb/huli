import { describe, expect, it, vi } from 'vitest'
import type { RunningWork } from '@shared/agent-host'
import type { Caller } from './artifacts/tools'
import {
  SessionTools,
  type SessionToolsDeps,
  type ToolDelivery,
  type ToolSession,
} from './session-tools'

const caller: Caller = { sessionId: 'starter', project: '/repo' }

function session(id: string, startedBy: string | null): ToolSession {
  return {
    id,
    title: id,
    agentId: 'codex',
    status: 'running',
    updatedAt: 0,
    createdAt: 0,
    parentId: startedBy,
    startedBy,
    archived: false,
    projectPath: '/repo',
    board: startedBy === null ? 'in_progress' : null,
    ports: null,
  }
}

function tools(delivery: ToolDelivery = { delivered: 'queued' }) {
  const sessions = [session('starter', null), session('started', 'starter'), session('other', null)]
  const send = vi.fn<SessionToolsDeps['send']>(async () => delivery)
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    name: () => 'Starter',
    send,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), send }
}

describe('send_message now', () => {
  it('queues by default', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'hi' })
    expect(out.isError).toBeUndefined()
    expect(send).toHaveBeenCalledWith('started', 'hi', expect.anything(), false)
  })

  it('passes now to the host and reports how it went in', async () => {
    const { tools: t, send } = tools({ delivered: 'steered' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'stop', now: true })
    expect(send).toHaveBeenCalledWith('started', 'stop', expect.anything(), true)
    expect(out.structuredContent).toEqual({ id: 'started', delivered: 'steered' })
  })

  it('says why a message asked to go now was queued', async () => {
    const { tools: t } = tools({ delivered: 'queued', reason: 'its turn was ending' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: true })
    expect(out.structuredContent).toEqual({
      id: 'started',
      delivered: 'queued',
      reason: 'its turn was ending',
    })
  })

  it('rejects a now that is not a boolean', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: 'yes' })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('never sends now to a session the caller did not start', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'other', text: 'x', now: true })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})

function work(sessionId: string, running: Partial<RunningWork> = {}): RunningWork {
  return {
    sessionId,
    agentId: 'claude-code',
    title: sessionId,
    turn: false,
    waiting: 0,
    commands: [],
    tasks: [],
    subagents: [],
    scheduled: 0,
    unnamed: false,
    ...running,
  }
}

function archiving(running: Record<string, RunningWork[]>, startedStatus = 'ready') {
  const sessions = [
    { ...session('starter', null), status: 'running' as const },
    { ...session('started', 'starter'), status: startedStatus as ToolSession['status'] },
  ]
  const archiveAfterTurn = vi.fn<SessionToolsDeps['archiveAfterTurn']>()
  const archiveNow = vi.fn<SessionToolsDeps['archiveNow']>(async () => {})
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    agentName: () => 'Claude Code',
    work: (id: string) => running[id] ?? [],
    archiveAfterTurn,
    archiveNow,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), archiveAfterTurn, archiveNow }
}

function text(out: Awaited<ReturnType<SessionTools['call']>>): string {
  return out.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('archive_session', () => {
  it('archives the caller once its turn ends when only the turn runs', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [work('starter', { turn: true, waiting: 1 })],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBeUndefined()
    expect(archiveAfterTurn).toHaveBeenCalledWith('starter', 'Claude Code')
  })

  it('refuses to archive the caller while its background work runs, and names it', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [
        work('starter', {
          turn: true,
          commands: ['sleep 300'],
          subagents: ['Explore the repo'],
          scheduled: 2,
        }),
      ],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('background command "sleep 300"')
    expect(text(out)).toContain('subagent "Explore the repo"')
    expect(text(out)).toContain('2 scheduled jobs')
    expect(text(out)).not.toContain('turn')
    expect(archiveAfterTurn).not.toHaveBeenCalled()
  })

  it('refuses to archive the caller while a sub-session of it works', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [work('starter', { turn: true }), work('child', { title: 'Child', turn: true })],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('"Child"')
    expect(archiveAfterTurn).not.toHaveBeenCalled()
  })

  it('refuses to archive a started session that runs background work between turns', async () => {
    const { tools: t, archiveNow } = archiving({
      started: [work('started', { tasks: ['Watch the build'] })],
    })
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('background task "Watch the build"')
    expect(archiveNow).not.toHaveBeenCalled()
  })

  it('refuses to archive a started session while its turn runs, and says so', async () => {
    const { tools: t, archiveNow } = archiving(
      { started: [work('started', { turn: true })] },
      'running',
    )
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('its turn')
    expect(archiveNow).not.toHaveBeenCalled()
  })

  it('archives a started session at once when nothing runs', async () => {
    const { tools: t, archiveNow } = archiving({})
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBeUndefined()
    expect(archiveNow).toHaveBeenCalledWith('started', 'Claude Code')
  })
})

// Huli: an agent moves its own session on the user's task board.
describe('set_board_status', () => {
  function board(callerBoard: ToolSession['board']) {
    const sessions = [{ ...session('starter', null), board: callerBoard }]
    const setBoard = vi.fn<SessionToolsDeps['setBoard']>((_id, status) => {
      sessions[0]!.board = status
    })
    const deps = {
      info: (id: string) => sessions.find((item) => item.id === id) ?? null,
      setBoard,
    } as unknown as SessionToolsDeps
    return { tools: new SessionTools(deps), setBoard }
  }

  it("moves the caller's own session and says where it is now", async () => {
    const { tools: t, setBoard } = board('in_progress')
    const out = await t.call(caller, 'set_board_status', { status: 'review' })
    expect(out.isError).toBeUndefined()
    expect(setBoard).toHaveBeenCalledWith('starter', 'review')
    expect(out.structuredContent).toMatchObject({ id: 'starter', board_status: 'review' })
  })

  it('refuses a column the board does not have, another session, or one off the board', async () => {
    const { tools: t, setBoard } = board('in_progress')
    for (const input of [{ status: 'blocked' }, {}, { status: 'done', id: 'other' }]) {
      expect((await t.call(caller, 'set_board_status', input)).isError).toBe(true)
    }
    const off = board(null)
    const out = await off.tools.call(caller, 'set_board_status', { status: 'review' })
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'not_allowed' })
    expect(setBoard).not.toHaveBeenCalled()
    expect(off.setBoard).not.toHaveBeenCalled()
  })
})

// Huli: a session the user referenced in a message to the caller (@ in the composer).
describe('read_session_history of a referenced session', () => {
  function history(refs: Record<string, string[]>) {
    const elsewhere = { ...session('elsewhere', null), projectPath: '/other' }
    const sessions = [session('starter', null), session('other', null), elsewhere]
    const read = vi.fn<SessionToolsDeps['history']>(async () => [
      { number: 1, agentId: 'codex', user: 'fix it', assistant: 'fixed' },
    ])
    const deps = {
      info: (id: string) => sessions.find((item) => item.id === id) ?? null,
      history: read,
      agentLabel: () => 'Codex',
      referenced: (callerId: string, id: string) => refs[callerId]?.includes(id) ?? false,
    } as unknown as SessionToolsDeps
    return { tools: new SessionTools(deps), read }
  }

  it('reads a referenced session, in another project too', async () => {
    const { tools: t, read } = history({ starter: ['other', 'elsewhere'] })
    for (const id of ['other', 'elsewhere']) {
      const out = await t.call(caller, 'read_session_history', { id })
      expect(out.isError).toBeUndefined()
      expect(read).toHaveBeenLastCalledWith(id)
    }
  })

  it('refuses one the user referenced to another session, or never', async () => {
    const { tools: t, read } = history({ someone: ['other', 'elsewhere'] })
    const same = await t.call(caller, 'read_session_history', { id: 'other' })
    expect(same.isError).toBe(true)
    const away = await t.call(caller, 'read_session_history', { id: 'elsewhere' })
    expect(away.isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('says not found for a referenced session that is gone', async () => {
    const { tools: t, read } = history({ starter: ['gone'] })
    const out = await t.call(caller, 'read_session_history', { id: 'gone' })
    expect(out.isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })
})

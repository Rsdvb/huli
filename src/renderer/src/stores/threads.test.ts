import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DigestedToolEntry, SessionSnapshot, ThreadEntry } from '@shared/thread'

const hostMock = vi.fn()
// Sessions on another computer, as the window learned their host.
const remote = new Set<string>()

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  sessionHost: (sessionId: string) => (remote.has(sessionId) ? 'mac' : null),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

function snapshot(id: string, entries: ThreadEntry[], seq = 1): SessionSnapshot {
  return {
    seq,
    older: null,
    plan: null,
    entries,
    session: {
      id,
      agentId: 'claude-code',
      projectPath: '/p',
      acpSessionId: null,
      status: 'ready',
      title: id,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 1,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
  }
}

describe('threads store performance and digests', () => {
  const rafQueue: FrameRequestCallback[] = []

  beforeEach(() => {
    hostMock.mockReset()
    remote.clear()
    rafQueue.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('loads a digested tool entry on demand, deduplicates calls, and preserves fresher status', async () => {
    const digested: DigestedToolEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'digest', of: 'diff', path: 'a.ts', size: 12000, added: 5, removed: 2 }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInputDigest: { size: 4000, lines: 80 },
    }
    const full: ThreadEntry = {
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'old\n', newText: 'new\n' }],
      locations: [{ path: 'a.ts' }],
      permission: null,
      permissionResult: null,
      rawInput: 'full input',
    }

    let resolveEntry!: (value: ThreadEntry) => void
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') {
        return Promise.resolve(snapshot('s1', [digested as unknown as ThreadEntry], 1))
      }
      if (method === 'sessions.entry') {
        return new Promise<ThreadEntry>((resolve) => {
          resolveEntry = resolve
        })
      }
      return Promise.resolve()
    })

    const { focusSession, loadFullEntry, receiveBatch, useThreadsStore } = await import('./threads')
    await focusSession('s1')

    const first = loadFullEntry('s1', 't1')
    const second = loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)

    // A live patch marks the call completed while the full entry is in flight.
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'entry.update', id: 't1', changes: { status: 'completed' } }],
    })
    for (const cb of rafQueue.splice(0)) cb(performance.now())

    resolveEntry(full)
    await Promise.all([first, second])

    const updated = useThreadsStore.getState().replicas.s1?.state?.byId.t1
    expect(updated?.kind).toBe('tool')
    if (updated?.kind === 'tool') {
      expect(updated.status).toBe('completed')
      expect(updated.rawInput).toBe('full input')
      expect(updated.content).toEqual(full.content)
    }

    // Calling again on an already-full entry issues no RPC (old-host and loaded compatibility).
    await loadFullEntry('s1', 't1')
    expect(hostMock.mock.calls.filter((c) => c[0] === 'sessions.entry')).toHaveLength(1)
  })

  it('drops queued patches on sequence gaps and triggers a snapshot resync', async () => {
    const snapCalls: unknown[] = []
    hostMock.mockImplementation((method: string, params: unknown) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open') return Promise.resolve(snapshot('s1', [], 1))
      if (method === 'sessions.snapshot') {
        snapCalls.push(params)
        return Promise.resolve(snapshot('s1', [], 10))
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch } = await import('./threads')
    await focusSession('s1')

    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [{ op: 'session.update', changes: { title: 'a' } }],
    })
    // Sequence gap before frame runs: drops queue and marks session for resync.
    receiveBatch({
      sessionId: 's1',
      seq: 5,
      patches: [{ op: 'session.update', changes: { title: 'b' } }],
    })
    receiveBatch({
      sessionId: 's1',
      seq: 9,
      patches: [{ op: 'session.update', changes: { title: 'c' } }],
    })

    for (const cb of rafQueue.splice(0)) cb(performance.now())
    await Promise.resolve()

    expect(snapCalls).toHaveLength(1)
  })

  it("reads another computer's session lean and keeps a replica the host finds current", async () => {
    remote.add('s1')
    const entry: ThreadEntry = {
      kind: 'agent',
      id: 'a1',
      markdown: 'done',
      attachments: [],
      streaming: false,
    }
    const reads: { method: string; params: Record<string, unknown> }[] = []
    let answer: SessionSnapshot = { ...snapshot('s1', [entry], 4), epoch: 'run.0.tok.l' }
    hostMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.open' || method === 'sessions.snapshot') {
        reads.push({ method, params })
        return Promise.resolve(answer)
      }
      return Promise.resolve()
    })
    const { focusSession, rewatchAll, useThreadsStore } = await import('./threads')
    await focusSession('s1')
    expect(reads[0]).toEqual({ method: 'sessions.open', params: { sessionId: 's1', lean: true } })
    const held = useThreadsStore.getState().replicas.s1!.state!

    // A reconnect: the host has nothing new and sends no entries; the replica keeps its own.
    answer = {
      ...snapshot('s1', [], 4),
      epoch: 'run.0.tok.l',
      unchanged: true,
      session: { ...answer.session, title: 'renamed' },
    }
    rewatchAll()
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    expect(reads[1]!.params).toEqual({
      sessionId: 's1',
      from: 0,
      lean: true,
      known: { epoch: 'run.0.tok.l', seq: 4 },
    })
    await vi.waitFor(() =>
      expect(useThreadsStore.getState().replicas.s1?.state?.session.title).toBe('renamed'),
    )
    const kept = useThreadsStore.getState().replicas.s1!
    expect(kept.state!.byId).toBe(held.byId)
    expect(kept.state!.order).toEqual(['a1'])
    expect(kept.seq).toBe(4)

    // An older host names no epoch: the next read names nothing, and its page replaces the replica.
    answer = snapshot('s1', [], 7)
    rewatchAll()
    await vi.waitFor(() => expect(useThreadsStore.getState().replicas.s1?.seq).toBe(7))
    expect(useThreadsStore.getState().replicas.s1?.state?.order).toEqual([])
    rewatchAll()
    await vi.waitFor(() => expect(reads).toHaveLength(4))
    expect(reads[3]!.params).toEqual({ sessionId: 's1', from: 0, lean: true })
  })

  it("reads this computer's sessions whole", async () => {
    const reads: unknown[] = []
    hostMock.mockImplementation((method: string, params: unknown) => {
      if (method === 'sessions.open') {
        reads.push(params)
        return Promise.resolve(snapshot('s1', [], 1))
      }
      return Promise.resolve()
    })
    const { focusSession } = await import('./threads')
    await focusSession('s1')
    expect(reads).toEqual([{ sessionId: 's1' }])
  })

  it('keeps at most 1 recent unwatched session in the web client', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    hostMock.mockImplementation((method: string, params: { sessionId?: string }) => {
      if (method === 'sessions.open') return Promise.resolve(snapshot(params.sessionId ?? 's', []))
      return Promise.resolve()
    })

    const { focusSession, useThreadsStore } = await import('./threads')
    await focusSession('s1')
    await focusSession('s2')
    expect(Object.keys(useThreadsStore.getState().replicas)).toEqual(['s2'])
    expect(hostMock).toHaveBeenCalledWith('sessions.unwatch', { sessionId: 's1' })
  })
})

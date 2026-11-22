import { describe, expect, it } from 'vitest'
import { isThreadEntry } from '@shared/thread'
import { kiteTasks } from './kite-tasks'

describe('Huli: the _kite/tasks extension', () => {
  it('takes the lists it sends, each item checked and cut to size', () => {
    const read = kiteTasks({
      sessionId: 's1',
      tasks: [
        {
          id: 'dev',
          kind: 'shell',
          title: 'Start the dev server',
          command: 'npm run dev',
          status: 'running',
          startedAt: 10,
          endedAt: null,
          summary: null,
          pid: 4321,
          progress: 'ready on :5173',
        },
        { id: 'bad', kind: 'daemon', title: 'x', status: 'running', startedAt: 1 },
        { id: 'neg', kind: 'shell', title: 'x', status: 'running', startedAt: 1, pid: -3 },
        { id: 'long', kind: 'monitor', title: 'y'.repeat(400), status: 'stopped', startedAt: 1 },
      ],
      foreground: [
        { toolCallId: 't1', taskId: 'k1', kind: 'shell', title: 'npm test', startedAt: 5 },
        { toolCallId: 't2', taskId: 'k2', kind: 'agent', title: 'x', startedAt: 5 },
      ],
      subagents: [{ sessionId: 'child', progress: 'Reading files' }, { sessionId: 'child' }],
    })
    expect(read?.sessionId).toBe('s1')
    const [tasks, running, held, ...rest] = read!.effects
    expect(running).toEqual({ kind: 'backgroundRunning', running: true, listed: true })
    expect(tasks).toMatchObject({
      kind: 'tasks',
      tasks: [
        { id: 'dev', pid: 4321, progress: 'ready on :5173', endedAt: null },
        { id: 'neg' },
        { id: 'long', endedAt: null, summary: null },
      ],
    })
    if (tasks?.kind !== 'tasks') throw new Error('no tasks')
    expect(tasks.tasks[1]).not.toHaveProperty('pid')
    expect(tasks.tasks[2]!.title).toHaveLength(300)
    expect(held).toEqual({
      kind: 'foreground',
      tasks: [{ toolCallId: 't1', taskId: 'k1', kind: 'shell', title: 'npm test', startedAt: 5 }],
    })
    expect(rest).toEqual([{ kind: 'subagent', sessionId: 'child', progress: 'Reading files' }])
  })

  it('leaves out the lists it does not send, and refuses what names no session', () => {
    expect(kiteTasks({ sessionId: 's1' })).toEqual({ sessionId: 's1', effects: [] })
    expect(kiteTasks({ tasks: [] })).toBeNull()
    expect(kiteTasks(null)).toBeNull()
  })

  it('reads back a recall entry only in its shape', () => {
    const memory = { path: '/m/a.md', scope: 'personal' }
    expect(isThreadEntry({ kind: 'recall', id: 'r', action: 'saved', memories: [memory] })).toBe(
      true,
    )
    expect(isThreadEntry({ kind: 'recall', id: 'r', action: 'lost', memories: [memory] })).toBe(
      false,
    )
    expect(
      isThreadEntry({
        kind: 'recall',
        id: 'r',
        action: 'recalled',
        memories: [{ path: '/m/a.md', scope: 'world' }],
      }),
    ).toBe(false)
  })
})

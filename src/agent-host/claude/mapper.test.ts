// Huli: what the Claude Code mapper makes of the SDK's messages, against the thread model, for the
// messages the connection's own tests do not drive.

import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type EntryChanges,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { ClaudeMapper } from './mapper'
import type { SdkMessage } from './sdk'

const SESSION = 'claude-1'

class Run {
  thread: ThreadState = threadFromSnapshot({
    session: {
      id: 'k1',
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: SESSION,
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  readonly mapper = new ClaudeMapper(SESSION, '/repo')
  readonly effects: MapperEffect[] = []
  readonly ignored: string[] = []
  private readonly scope = newTurnScope()
  private n = 0
  now = 1_000

  feed(...messages: unknown[]): this {
    for (const message of messages) {
      const deliveries = this.mapper.live(message as SdkMessage)
      if (deliveries === null) {
        const m = message as { type: string; subtype?: string }
        this.ignored.push(m.subtype ? `${m.type}/${m.subtype}` : m.type)
        continue
      }
      for (const delivery of deliveries) {
        if (delivery.sessionId !== SESSION) continue
        const out = delivery.map(this.context())
        this.thread = applyPatches(this.thread, out.patches)
        this.effects.push(...out.effects)
      }
    }
    return this
  }

  /** Changes an entry as the host does, such as with the answer to its permission. */
  update(id: string, changes: EntryChanges): this {
    this.thread = applyPatches(this.thread, [{ op: 'entry.update', id, changes }])
    return this
  }

  context(): MapperContext {
    return {
      thread: this.thread,
      replaying: false,
      cancelling: false,
      scope: this.scope,
      now: this.now,
      nextId: () => `e:${++this.n}`,
      sessionIdFor: (id) => `kettu-${id}`,
    }
  }

  entries(): ThreadEntry[] {
    return threadEntries(this.thread)
  }

  entry(id: string): ThreadEntry | undefined {
    return this.thread.byId[id]
  }
}

const system = (subtype: string, fields: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  uuid: `u-${subtype}`,
  session_id: SESSION,
  ...fields,
})

const notices = (run: Run) => run.entries().filter((entry) => entry.kind === 'notice')

const toolCall = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: {
    id: `msg-${id}`,
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id, name, input }],
  },
  parent_tool_use_id: null,
  uuid: `uuid-${id}`,
  session_id: SESSION,
})

const toolResult = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
})

describe('a retried request', () => {
  const retry = (attempt: number, fields: Record<string, unknown> = {}) =>
    system('api_retry', {
      attempt,
      max_retries: 10,
      retry_delay_ms: 1_000,
      error_status: 529,
      error: 'overloaded',
      uuid: `u-retry-${attempt}`,
      ...fields,
    })

  it('shows one notice that counts the attempts, then says the request went through', () => {
    const run = new Run().feed(retry(1), retry(2))
    expect(notices(run)).toMatchObject([
      { severity: 'warning', title: 'Retrying (2/10) · service overloaded' },
    ])
    run.feed({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-1' } },
      parent_tool_use_id: null,
      session_id: SESSION,
    })
    expect(notices(run)).toMatchObject([
      { severity: 'info', title: 'Went through after 2 retries · service overloaded' },
    ])
  })

  it('says when the turn ended still failing, and names a connection error', () => {
    const run = new Run().feed(retry(3, { error: 'unknown', error_status: null }))
    for (const delivery of run.mapper.retryEnded(false)) {
      run.thread = applyPatches(run.thread, delivery.map(run.context()).patches)
    }
    expect(notices(run)).toMatchObject([
      { severity: 'warning', title: 'Still failing after 3 retries · connection failed' },
    ])
  })

  it("leaves a subagent's retries to it", () => {
    expect(notices(new Run().feed(retry(1, { agent_id: 'task-1' })))).toEqual([])
  })
})

describe('a call that did not run', () => {
  it('is cancelled, not failed, when the user stopped it', () => {
    const run = new Run().feed(
      toolCall('t1', 'Bash', { command: 'sleep 100' }),
      toolResult('t1', '[Request interrupted by user for tool use]', { is_error: true }),
    )
    expect(run.entry('t:t1')).toMatchObject({ status: 'cancelled' })
    expect(run.entry('t:t1')).not.toHaveProperty('denied')
  })

  it('is denied by the user who turned its permission down', () => {
    const run = new Run()
      .feed(toolCall('t1', 'Write', { file_path: '/repo/a.ts', content: 'x' }))
      .update('t:t1', { permissionResult: { optionId: 'reject', kind: 'reject_once' } })
      .feed(toolResult('t1', 'The user denied this.', { is_error: true }))
    expect(run.entry('t:t1')).toMatchObject({ status: 'cancelled', denied: { by: 'user' } })
  })

  it('still fails when the tool itself failed', () => {
    const run = new Run().feed(
      toolCall('t1', 'Read', { file_path: '/repo/missing.ts' }),
      toolResult('t1', 'File does not exist.', { is_error: true }),
    )
    expect(run.entry('t:t1')).toMatchObject({ status: 'failed' })
  })
})

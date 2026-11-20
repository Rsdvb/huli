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

describe("Claude Code's own lines", () => {
  it("shows a command's output once, though Claude Code also writes it as its message", () => {
    const run = new Run().feed(
      system('local_command_output', { content: 'Session: 12% used\nWeek: 40% used' }),
      {
        type: 'assistant',
        message: {
          id: 'msg-usage',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Session: 12% used\nWeek: 40% used' }],
        },
        parent_tool_use_id: null,
        uuid: 'uuid-usage',
        session_id: SESSION,
      },
    )
    expect(run.entries()).toMatchObject([
      {
        kind: 'notice',
        severity: 'info',
        title: 'Command output',
        description: 'Session: 12% used\nWeek: 40% used',
      },
    ])
  })

  it("shows a hook's block reason and a Stop hook's denial, not a transcript-only line", () => {
    const run = new Run().feed(
      system('informational', { content: 'only in the transcript', level: 'info', uuid: 'a' }),
      system('informational', {
        content: 'UserPromptSubmit hook blocked the prompt\nNo secrets in prompts',
        level: 'warning',
        uuid: 'b',
      }),
      system('informational', {
        content: 'Stop hook prevented continuation',
        level: 'notice',
        prevent_continuation: true,
        uuid: 'c',
      }),
    )
    expect(notices(run)).toMatchObject([
      {
        severity: 'warning',
        title: 'UserPromptSubmit hook blocked the prompt',
        description: 'No secrets in prompts',
      },
      { severity: 'warning', title: 'Stop hook prevented continuation' },
    ])
  })

  it('replaces a notification by its key', () => {
    const run = new Run().feed(
      system('notification', { key: 'ide', text: 'IDE disconnected', priority: 'low' }),
      system('notification', { key: 'ide', text: 'IDE connected', priority: 'high' }),
    )
    expect(notices(run)).toMatchObject([{ severity: 'warning', title: 'IDE connected' }])
  })
})

describe('a refusal', () => {
  it('says the request went to the fallback model, and why the first refused', () => {
    const run = new Run().feed(
      system('model_refusal_fallback', {
        trigger: 'refusal',
        direction: 'retry',
        scope: 'session',
        original_model: 'claude-opus-5',
        fallback_model: 'claude-sonnet-5',
        api_refusal_category: 'cyber',
        api_refusal_explanation: 'The request asked for a working exploit.',
        content: '',
      }),
      system('model_refusal_no_fallback', { original_model: 'claude-opus-5', content: '' }),
    )
    expect(notices(run)).toMatchObject([
      {
        severity: 'info',
        title: 'claude-opus-5 refused, so Claude Code asked claude-sonnet-5 instead',
        description: 'The request asked for a working exploit.',
      },
    ])
  })
})

describe('MCP servers', () => {
  const init = (servers: { name: string; status: string }[], uuid: string) =>
    system('init', { mcp_servers: servers, uuid })

  it('says which could not start or need a sign-in, once until their state changes', () => {
    const run = new Run().feed(
      init(
        [
          { name: 'github', status: 'failed' },
          { name: 'linear', status: 'needs-auth' },
          { name: 'kettu', status: 'connected' },
        ],
        'a',
      ),
      init([{ name: 'github', status: 'failed' }], 'b'),
      init([{ name: 'github', status: 'connected' }], 'c'),
      init([{ name: 'github', status: 'failed' }], 'd'),
    )
    expect(notices(run)).toMatchObject([
      { id: 'n:mcp:failed:a', severity: 'warning', title: 'MCP server github could not start' },
      { id: 'n:mcp:auth:a', title: 'MCP server linear needs you to sign in' },
      { id: 'n:mcp:failed:d', title: 'MCP server github could not start' },
    ])
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

  it('is denied by what denied it without asking, with its reason', () => {
    const run = new Run().feed(
      toolCall('t1', 'Bash', { command: 'rm -rf build' }),
      system('permission_denied', {
        tool_name: 'Bash',
        tool_use_id: 't1',
        decision_reason_type: 'classifier',
        decision_reason: 'Deletes files outside the task',
        message: 'Permission denied',
      }),
      toolResult('t1', 'Permission denied', { is_error: true }),
    )
    expect(run.entry('t:t1')).toMatchObject({
      status: 'cancelled',
      denied: { by: 'review', reason: 'Deletes files outside the task' },
    })
  })

  it('still fails when the tool itself failed', () => {
    const run = new Run().feed(
      toolCall('t1', 'Read', { file_path: '/repo/missing.ts' }),
      toolResult('t1', 'File does not exist.', { is_error: true }),
    )
    expect(run.entry('t:t1')).toMatchObject({ status: 'failed' })
  })
})

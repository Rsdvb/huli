// What the Codex mapper makes of app-server items, against the same thread model ACP fills.

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { fenced } from '../session-updates'
import { commandFacts, deniedEvent, diffHunks, stripShellPrefix, ThreadMapper } from './mapper'

function run(
  notifications: [string, unknown, number?][],
  options: { replaying?: boolean; title?: string; appeals?: boolean } = {},
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'codex',
      projectPath: os.tmpdir(),
      acpSessionId: 'thread-1',
      status: 'running',
      title: options.title ?? null,
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
  const mapper = new ThreadMapper({ appeals: options.appeals ?? false })
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  let n = 0
  let now = 1_000
  const unknown: string[] = []
  for (const [method, params, time] of notifications) {
    if (time !== undefined) now = time
    const ctx: MapperContext = {
      thread,
      replaying: options.replaying ?? false,
      cancelling: false,
      scope,
      now,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }
    const out = mapper.notification(method, params, ctx)
    if (!out) unknown.push(method)
    else {
      thread = applyPatches(thread, out.patches)
      effects.push(...out.effects)
    }
    now += 100
  }
  return { thread, entries: threadEntries(thread), effects, unknown }
}

const at = { threadId: 'thread-1', turnId: 'turn-1' }
const started = (item: unknown): [string, unknown] => ['item/started', { ...at, item }]
const completed = (item: unknown): [string, unknown] => ['item/completed', { ...at, item }]

describe('output speed', () => {
  const usage = (output: number, reasoning = 0, time?: number): [string, unknown, number?] => {
    const last = {
      totalTokens: 1_000 + output,
      inputTokens: output === 0 ? 0 : 1_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
    }
    const tokenUsage = { total: last, last, modelContextWindow: 200_000 }
    return ['thread/tokenUsage/updated', { ...at, tokenUsage }, time]
  }
  const command = {
    type: 'commandExecution',
    id: 'x',
    command: 'ls',
    cwd: '/p',
    status: 'completed',
    commandActions: [],
    aggregatedOutput: '',
    exitCode: 0,
  }

  it('times streamed output from its first delta, and hidden reasoning from the request going out', () => {
    const user = { type: 'userMessage', id: 'u', content: [] }
    const { thread } = run([
      [...completed(user), 1_000],
      ['item/agentMessage/delta', { ...at, itemId: 'm', delta: 'Hi' }, 4_000],
      usage(300, 0, 6_000),
      [...completed(command), 8_000],
      ['item/agentMessage/delta', { ...at, itemId: 'm2', delta: 'Done' }, 15_000],
      usage(1_000, 700, 18_000),
      // A compaction counts nothing.
      usage(0, 0, 19_000),
    ])
    expect(thread.session.speed).toEqual({
      last: { tokens: 1_000, ms: 10_000, approx: true, firstTokenMs: null },
      recent: [
        { rate: 150, approx: false },
        { rate: 100, approx: true },
      ],
      turn: { since: null, tokens: 1_300, ms: 12_000, requests: 2, approx: 1 },
      session: { tokens: 1_300, ms: 12_000, requests: 2, approx: 1 },
    })
  })

  it('keeps the latest request with its input split from what came from the cache', () => {
    const last = {
      totalTokens: 41_210,
      inputTokens: 40_600,
      cachedInputTokens: 36_000,
      cacheWriteInputTokens: 2_000,
      outputTokens: 610,
      reasoningOutputTokens: 200,
    }
    const { thread } = run([
      [...completed({ type: 'userMessage', id: 'u', content: [] }), 1_000],
      [
        'thread/tokenUsage/updated',
        { ...at, tokenUsage: { total: last, last, modelContextWindow: 272_000 } },
        7_000,
      ],
    ])
    expect(thread.session.lastRequest).toEqual({
      at: 1_000,
      input: 2_600,
      cacheRead: 36_000,
      cacheWrite: 2_000,
      output: 610,
      ms: 6_000,
    })
  })

  it('times nothing in a replay', () => {
    const { thread } = run([usage(300, 0, 6_000)], { replaying: true })
    expect(thread.session.speed).toBeUndefined()
    expect(thread.session.lastRequest).toBeUndefined()
  })
})

describe('commands', () => {
  it('strips the shell Codex runs a command in', () => {
    expect(stripShellPrefix("/bin/zsh -lc 'touch a'")).toBe('touch a')
    expect(stripShellPrefix('bash -c ls')).toBe('ls')
    expect(stripShellPrefix('git status')).toBe('git status')
  })

  it('reads a file, a search and a listing as codex-acp showed them', () => {
    expect(
      commandFacts('cat a.ts', '/p', [
        { type: 'read', command: 'cat a.ts', name: 'a.ts', path: 'a.ts' },
      ]),
    ).toEqual({
      title: "Read file 'a.ts'",
      toolKind: 'read',
      locations: [{ path: path.resolve('/p', 'a.ts') }],
    })
    expect(
      commandFacts('rg x', '/p', [{ type: 'search', command: 'rg x', query: 'x', path: 'src' }]),
    ).toEqual({
      title: "Search for 'x' in src",
      toolKind: 'search',
      locations: [],
    })
    expect(
      commandFacts('ls', '/p', [{ type: 'listFiles', command: 'ls', path: null }]),
    ).toMatchObject({
      title: 'List files',
      toolKind: 'read',
    })
    // Several actions run as one command.
    expect(
      commandFacts("/bin/zsh -lc 'cat a && cat b'", '/p', [
        { type: 'read', command: 'cat a', name: 'a', path: 'a' },
        { type: 'read', command: 'cat b', name: 'b', path: 'b' },
      ]),
    ).toEqual({
      title: 'cat a && cat b',
      toolKind: 'execute',
      locations: [],
      rawInput: 'cat a && cat b',
    })
  })

  it('fences output with a fence longer than any inside, and shows the output of a read file not at all', () => {
    expect(fenced('a\n```\nb\n')).toBe('````\na\n```\nb\n````')
    const read = {
      type: 'commandExecution',
      id: 'x',
      command: 'cat a',
      cwd: '/p',
      status: 'completed',
      commandActions: [{ type: 'read', command: 'cat a', name: 'a', path: 'a' }],
      aggregatedOutput: 'secret file text',
      exitCode: 0,
    }
    const { entries } = run([completed(read)])
    expect(entries[0]).toMatchObject({ kind: 'tool', toolKind: 'read', content: [] })
  })

  it('keeps the end of a long output, and marks a declined command cancelled, not failed', () => {
    const item = {
      type: 'commandExecution',
      id: 'x',
      command: 'yes',
      cwd: '/p',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'yes' }],
      aggregatedOutput: null,
      exitCode: null,
    }
    const { entries } = run([
      started(item),
      ['item/commandExecution/outputDelta', { ...at, itemId: 'x', delta: 'y\n'.repeat(40_000) }],
      completed({ ...item, status: 'declined' }),
    ])
    const tool = entries[0]
    expect(tool).toMatchObject({ status: 'cancelled', denied: { by: 'rule' } })
    const markdown =
      tool?.kind === 'tool' && tool.content[0]?.type === 'markdown' ? tool.content[0].markdown : ''
    expect(markdown.startsWith('```\n…\n')).toBe(true)
    expect(markdown.length).toBeLessThan(70 * 1024)
  })

  it('shows what Codex typed into a running command in its output', () => {
    const item = {
      type: 'commandExecution',
      id: 'x',
      command: 'python3 ask.py',
      cwd: '/p',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'python3 ask.py' }],
      aggregatedOutput: null,
      exitCode: null,
    }
    const { entries, unknown } = run([
      started(item),
      ['item/commandExecution/outputDelta', { ...at, itemId: 'x', delta: 'Name? ' }],
      [
        'item/commandExecution/terminalInteraction',
        { ...at, itemId: 'x', processId: 'p', stdin: 'Ada\n' },
      ],
    ])
    expect(unknown).toEqual([])
    expect(entries[0]).toMatchObject({
      content: [{ type: 'markdown', markdown: '```\nName? \n› Ada\n```' }],
    })
  })

  it('keeps the exit code a command ended with', () => {
    const item = {
      type: 'commandExecution',
      id: 'x',
      command: 'false',
      cwd: '/p',
      status: 'failed',
      commandActions: [{ type: 'unknown', command: 'false' }],
      aggregatedOutput: '',
      exitCode: 1,
    }
    const { entries } = run([completed(item)])
    expect(entries[0]).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(entries[0]).not.toHaveProperty('denied')
  })
})

describe('MCP results', () => {
  const call = (result: unknown, status = 'completed') => ({
    type: 'mcpToolCall',
    id: 'mcp-1',
    server: 'github',
    tool: 'get_pr',
    status,
    arguments: { number: 7 },
    result,
    error: null,
  })

  it('keeps links, sounds and the structured result, and shows progress on the running row', () => {
    const { entries, unknown } = run([
      started(call(null, 'inProgress')),
      ['item/mcpToolCall/progress', { ...at, itemId: 'mcp-1', message: 'Fetching reviews 2/5' }],
    ])
    expect(unknown).toEqual([])
    expect(entries[0]).toMatchObject({ status: 'in_progress', progress: 'Fetching reviews 2/5' })
    const done = run([
      completed(
        call({
          content: [
            { type: 'resource_link', uri: 'https://github.com/o/r/pull/7', name: 'PR 7' },
            { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
          ],
          structuredContent: { number: 7, state: 'open' },
        }),
      ),
    ]).entries[0]
    expect(done).toMatchObject({
      content: [
        { type: 'ref', ref: { kind: 'link', uri: 'https://github.com/o/r/pull/7', name: 'PR 7' } },
        { type: 'ref', ref: { kind: 'audio', mimeType: 'audio/wav', data: 'AAAA' } },
        { type: 'markdown', markdown: '```json\n{\n  "number": 7,\n  "state": "open"\n}\n```' },
      ],
    })
  })

  it('leaves out a structured result its text already holds as JSON', () => {
    const { entries } = run([
      completed(
        call({
          content: [{ type: 'text', text: '{"state":"open"}' }],
          structuredContent: { state: 'open' },
        }),
      ),
    ])
    expect(entries[0]).toMatchObject({ content: [{ type: 'markdown' }] })
    expect(entries[0]?.kind === 'tool' && entries[0].content).toHaveLength(1)
  })
})

describe('sub-agent calls', () => {
  it("show the new agent's model and effort, and each agent's state with its message", () => {
    const { entries } = run([
      completed({
        type: 'collabAgentToolCall',
        id: 'spawn-1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['child-1'],
        prompt: 'Find the flaky test',
        model: 'gpt-5.5-codex',
        reasoningEffort: 'high',
        agentsStates: { 'child-1': { status: 'pendingInit', message: null } },
      }),
      completed({
        type: 'collabAgentToolCall',
        id: 'wait-1',
        tool: 'wait',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['child-1'],
        prompt: null,
        agentsStates: { 'child-1': { status: 'completed', message: 'It was the clock test' } },
      }),
    ])
    expect(entries).toMatchObject([
      {
        title: 'Start subagent',
        description: 'Find the flaky test',
        content: [
          {
            type: 'markdown',
            markdown: ['- Runs on gpt-5.5-codex · high effort', '- Starting'].join(
              String.fromCharCode(10),
            ),
          },
        ],
      },
      {
        title: 'Wait for subagents',
        content: [{ type: 'markdown', markdown: '- Finished: It was the clock test' }],
      },
    ])
  })
})

describe("Codex 0.170's details", () => {
  it('marks a review, and keeps search results, a plan change, a reroute and an image failure', () => {
    const nl = String.fromCharCode(10)
    const { entries, unknown } = run([
      completed({ type: 'enteredReviewMode', id: 'rv', review: 'uncommitted changes' }),
      completed({
        type: 'webSearch',
        id: 'w',
        query: 'vitest',
        action: { type: 'search', query: 'vitest', queries: ['vitest', 'vitest config'] },
        results: [{ url: 'https://vitest.dev', title: 'Vitest' }],
      }),
      [
        'turn/plan/updated',
        { ...at, explanation: 'Found the cause', plan: [{ step: 'Fix', status: 'inProgress' }] },
      ],
      ['model/rerouted', { ...at, fromModel: 'a', toModel: 'b', reason: 'highRiskCyberActivity' }],
      completed({
        type: 'imageGeneration',
        id: 'img',
        status: 'failed',
        revisedPrompt: null,
        failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: null },
      }),
      completed({ type: 'exitedReviewMode', id: 'rv2', review: 'done' }),
    ])
    expect(unknown).toEqual([])
    expect(entries).toMatchObject([
      { kind: 'notice', title: 'Review started', description: 'uncommitted changes' },
      {
        kind: 'tool',
        content: [
          {
            type: 'markdown',
            markdown: [
              'Also searched for:',
              '',
              '- vitest config',
              '',
              '- [Vitest](https://vitest.dev)',
            ].join(nl),
          },
        ],
      },
      { kind: 'plan' },
      { kind: 'notice', title: 'The plan changed', description: 'Found the cause' },
      {
        kind: 'notice',
        title: 'Codex switched from a to b',
        description: 'The request looked like high-risk cybersecurity activity.',
      },
      {
        kind: 'tool',
        status: 'failed',
        content: [{ type: 'markdown', markdown: 'The image usage limit is reached.' }],
      },
      { kind: 'notice', title: 'Review finished' },
    ])
  })

  it("hands the review's text to the host when review mode ends, and not when it starts", () => {
    const { effects } = run([
      completed({ type: 'enteredReviewMode', id: 'rv', review: 'uncommitted changes' }),
      completed({ type: 'exitedReviewMode', id: 'rv2', review: '- [P1] Bug — /p/a.ts:1-1' }),
    ])
    expect(effects.filter((effect) => effect.kind === 'review')).toEqual([
      { kind: 'review', text: '- [P1] Bug — /p/a.ts:1-1' },
    ])
  })
})

describe('hooks', () => {
  const hook = (
    status: string,
    entries: { kind: string; text: string }[],
    statusMessage: string | null = null,
  ): [string, unknown] => [
    'hook/completed',
    {
      threadId: 'thread-1',
      turnId: 'turn-1',
      run: {
        id: `h-${status}`,
        eventName: 'preToolUse',
        status,
        statusMessage,
        entries,
        displayOrder: 0,
        executionMode: 'sync',
        handlerType: 'command',
        scope: 'turn',
        sourcePath: '/p/.codex/hooks.toml',
        startedAt: 1,
      },
    },
  ]

  it('shows a hook that blocked, failed or warned, with what it said, and none that only ran', () => {
    const { entries, unknown } = run([
      ['hook/started', { threadId: 'thread-1', turnId: 'turn-1', run: {} }],
      hook('completed', [{ kind: 'context', text: 'for the model only' }]),
      hook('blocked', [{ kind: 'feedback', text: 'No writes outside src/' }], 'Denied by policy'),
      hook('failed', [{ kind: 'error', text: 'exit 2' }]),
      completed({
        type: 'hookPrompt',
        id: 'hp-1',
        fragments: [{ hookRunId: 'h', text: 'Run the tests too.' }],
      }),
    ])
    expect(unknown).toEqual([])
    expect(entries).toMatchObject([
      {
        kind: 'notice',
        severity: 'warning',
        title: 'A before-tool hook blocked it',
        description: ['Denied by policy', 'No writes outside src/'].join(String.fromCharCode(10)),
      },
      {
        kind: 'notice',
        severity: 'error',
        title: 'A before-tool hook failed',
        description: 'exit 2',
      },
      {
        kind: 'notice',
        id: 'n:hook:hp-1',
        title: 'A hook added to the conversation',
        description: 'Run the tests too.',
      },
    ])
  })
})

describe('the goal', () => {
  const goal = (status: string, tokensUsed: number, timeUsedSeconds: number): [string, unknown] => [
    'thread/goal/updated',
    {
      threadId: 'thread-1',
      turnId: null,
      goal: {
        threadId: 'thread-1',
        objective: 'Make the suite pass',
        status,
        tokensUsed,
        tokenBudget: 200_000,
        timeUsedSeconds,
        createdAt: 1,
        updatedAt: 2,
      },
    },
  ]

  it('shows its state, keeps its use up to date, and says when it changed or was cleared', () => {
    const { entries, unknown } = run([
      goal('active', 1_200, 30),
      goal('active', 45_000, 600),
      goal('budgetLimited', 200_000, 3_900),
      ['thread/goal/cleared', { threadId: 'thread-1' }],
    ])
    expect(unknown).toEqual([])
    expect(entries).toMatchObject([
      {
        kind: 'notice',
        severity: 'info',
        title: 'Goal: Make the suite pass',
        description: '45,000 tokens used of 200,000 · 10 minutes',
      },
      {
        kind: 'notice',
        severity: 'warning',
        title: 'Goal out of budget: Make the suite pass',
        description: '200,000 tokens used of 200,000 · 1 h 5 min',
      },
      { kind: 'notice', title: 'Goal cleared' },
    ])
  })
})

describe('a lost stream', () => {
  const lost = (attempt: number, willRetry = true): [string, unknown] => [
    'error',
    {
      ...at,
      willRetry,
      error: {
        message: `Reconnecting... ${attempt}/5 (stream disconnected before completion)`,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      },
    },
  ]

  it('shows one notice that counts the attempts, then says the stream came back', () => {
    const { entries, unknown } = run([
      lost(1),
      lost(2),
      ['item/agentMessage/delta', { ...at, itemId: 'm', delta: 'Hi' }],
    ])
    expect(unknown).toEqual([])
    expect(entries).toMatchObject([
      {
        kind: 'notice',
        id: 'n:retry:turn-1',
        severity: 'info',
        title: 'Reconnected after 2 retries',
      },
      { kind: 'agent', markdown: 'Hi' },
    ])
  })

  it('says so when the turn failed while it retried', () => {
    const { entries } = run([lost(1), lost(5, false)])
    expect(entries).toMatchObject([
      { kind: 'notice', severity: 'warning', title: 'Could not reconnect after 1 retry' },
    ])
  })
})

describe('auto-review', () => {
  const action = { type: 'command', command: 'rm -rf build', cwd: '/p', source: 'shell' }
  const review = (status: string, extra: Record<string, unknown> = {}): [string, unknown] => [
    status === 'inProgress'
      ? 'item/autoApprovalReview/started'
      : 'item/autoApprovalReview/completed',
    {
      ...at,
      reviewId: 'r1',
      targetItemId: 'cmd-1',
      startedAtMs: 1,
      action,
      review: { status, riskLevel: 'high', rationale: null, ...extra },
    },
  ]

  it('shows the review on the row of the call it looks at, and a denial as no failure', () => {
    const { entries, unknown } = run([
      review('inProgress'),
      review('denied', { rationale: 'Deletes the build outside the task' }),
      completed({
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'rm -rf build',
        cwd: '/p',
        status: 'declined',
        commandActions: [{ type: 'unknown', command: 'rm -rf build' }],
        aggregatedOutput: null,
        exitCode: null,
      }),
    ])
    expect(unknown).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 't:cmd-1',
      title: 'rm -rf build',
      toolKind: 'execute',
      status: 'cancelled',
      review: { status: 'denied', risk: 'high', rationale: 'Deletes the build outside the task' },
      denied: { by: 'review', reason: 'Deletes the build outside the task' },
    })
  })

  it('leaves an approved call to run, and ends one that starts no item with its review', () => {
    const { entries } = run([
      review('approved', { riskLevel: 'low' }),
      [
        'item/autoApprovalReview/completed',
        {
          ...at,
          reviewId: 'r2',
          targetItemId: null,
          startedAtMs: 1,
          action: {
            type: 'networkAccess',
            host: 'pypi.org',
            port: 443,
            protocol: 'https',
            target: 'x',
          },
          review: { status: 'approved', riskLevel: 'low', rationale: null },
        },
      ],
      ['guardianWarning', { threadId: 'thread-1', message: 'Too many denied actions' }],
    ])
    expect(entries).toMatchObject([
      { id: 't:cmd-1', status: 'pending', review: { status: 'approved', risk: 'low' } },
      { id: 't:review:r2', status: 'completed', toolKind: 'fetch' },
      { kind: 'notice', severity: 'warning', description: 'Too many denied actions' },
    ])
    expect(entries[0]).not.toHaveProperty('denied')
  })

  it('offers to allow a denied call, with the denial as Codex’s core takes it back', () => {
    const denied = review('denied', {
      rationale: 'Deletes the build outside the task',
      userAuthorization: 'low',
    })
    Object.assign(denied[1] as Record<string, unknown>, {
      completedAtMs: 5,
      decisionSource: 'agent',
    })
    const { entries, effects } = run([review('inProgress'), denied], { appeals: true })
    const appeal = entries[0]?.kind === 'tool' ? entries[0].review?.appeal : undefined
    expect(appeal).toMatchObject({ risk: null })
    expect(JSON.parse(appeal!.event)).toEqual({
      id: 'r1',
      target_item_id: 'cmd-1',
      turn_id: 'turn-1',
      started_at_ms: 1,
      completed_at_ms: 5,
      status: 'denied',
      risk_level: 'high',
      user_authorization: 'low',
      rationale: 'Deletes the build outside the task',
      decision_source: 'agent',
      action: { type: 'command', source: 'shell', command: 'rm -rf build', cwd: '/p' },
    })
    expect(effects).toContainEqual({ kind: 'appeal', entryId: 't:cmd-1' })
  })

  it('offers none on a Codex that takes no denial back, or for a review that denied nothing', () => {
    const reviewOf = (result: ReturnType<typeof run>) =>
      result.entries[0]?.kind === 'tool' ? result.entries[0].review : undefined
    const plain = run([review('denied')])
    expect(reviewOf(plain)).toMatchObject({ status: 'denied' })
    expect(reviewOf(plain)).not.toHaveProperty('appeal')
    expect(plain.effects.some((effect) => effect.kind === 'appeal')).toBe(false)
    expect(reviewOf(run([review('approved')], { appeals: true }))).not.toHaveProperty('appeal')
  })

  it('carries each action over in the core’s names, and none it cannot carry whole', () => {
    const event = (action: unknown, status = 'denied') =>
      deniedEvent({ ...at, reviewId: 'r9', action, review: { status } })?.action ?? null
    expect(
      event({
        type: 'execve',
        source: 'unifiedExec',
        program: 'git',
        argv: ['git', 'push'],
        cwd: '/p',
      }),
    ).toEqual({
      type: 'execve',
      source: 'unified_exec',
      program: 'git',
      argv: ['git', 'push'],
      cwd: '/p',
    })
    expect(event({ type: 'applyPatch', cwd: '/p', files: ['a.ts'] })).toEqual({
      type: 'apply_patch',
      cwd: '/p',
      files: ['a.ts'],
    })
    expect(
      event({
        type: 'networkAccess',
        target: 't',
        host: 'pypi.org',
        protocol: 'socks5Tcp',
        port: 443,
      }),
    ).toEqual({
      type: 'network_access',
      target: 't',
      host: 'pypi.org',
      protocol: 'socks5_tcp',
      port: 443,
    })
    expect(
      event({ type: 'mcpToolCall', server: 'gh', toolName: 'merge', toolTitle: 'Merge' }),
    ).toEqual({
      type: 'mcp_tool_call',
      server: 'gh',
      tool_name: 'merge',
      connector_id: null,
      connector_name: null,
      tool_title: 'Merge',
    })
    expect(
      event({ type: 'writeStdin', approvalId: 'a', processId: '1', stdin: 'y', cwd: '/p' }),
    ).toBeNull()
    expect(event({ type: 'requestPermissions', reason: null, permissions: {} })).toBeNull()
    expect(event({ type: 'command', source: 'zsh', command: 'ls', cwd: '/p' })).toBeNull()
    expect(event({ type: 'command', source: 'shell', command: 'ls' })).toBeNull()
    expect(event({ type: 'applyPatch', cwd: '/p', files: [] }, 'approved')).toBeNull()
  })
})

describe('diffs', () => {
  it('reads each hunk of a unified diff as its old and new text', () => {
    expect(
      diffHunks('@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-x\n+y\n\\ No newline at end of file\n'),
    ).toEqual([
      { oldText: 'a\nb', newText: 'a\nc' },
      { oldText: 'x', newText: 'y' },
    ])
    expect(diffHunks('not a diff')).toBeNull()
  })

  it('shows a moved file at its new path and a deleted one as all old text', () => {
    const { entries } = run([
      completed({
        type: 'fileChange',
        id: 'p',
        status: 'completed',
        changes: [
          {
            path: '/p/a',
            kind: { type: 'update', move_path: '/p/b' },
            diff: '@@ -1 +1 @@\n-1\n+2\n',
          },
          { path: '/p/c', kind: { type: 'delete' }, diff: 'gone\n' },
        ],
      }),
    ])
    expect(entries[0]).toMatchObject({
      locations: [{ path: '/p/b' }, { path: '/p/c' }],
      content: [
        { type: 'diff', path: '/p/b', oldText: '1', newText: '2' },
        { type: 'diff', path: '/p/c', oldText: 'gone\n', newText: '' },
      ],
    })
  })
})

describe('the plan tool', () => {
  const call = (id: string, server: string, tool: string) => ({
    type: 'mcpToolCall',
    id,
    server,
    tool,
    status: 'completed',
    arguments: {},
    result: null,
    error: null,
    durationMs: 1,
  })

  it('shows no row for its call, and one for another server with a tool of that name', () => {
    const { entries } = run([
      started({ ...call('a', 'kettu', 'set_plan'), status: 'inProgress' }),
      completed(call('a', 'kettu', 'set_plan')),
      completed(call('b', 'other', 'set_plan')),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['t:b'])
  })

  it('shows no row for a memory write, unless it failed and so wrote nothing', () => {
    const refused = { message: 'This looks like a secret' }
    const { entries } = run([
      completed(call('a', 'kettu', 'remember')),
      completed({ ...call('b', 'kettu', 'update_memory'), status: 'failed', error: refused }),
      completed({ ...call('c', 'kettu', 'set_plan'), status: 'failed', error: refused }),
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['t:b'])
    expect(entries[0]).toMatchObject({ status: 'failed' })
  })

  it("keeps what a workflow tool returned for its card, and nothing from another server's", () => {
    const structuredContent = {
      accepted: false,
      checks: [{ check: 'outcome', ok: false, detail: 'Report one of its outcomes.' }],
      next: { kind: 'retry' },
      facts: null,
    }
    const result = { content: [{ type: 'text', text: 'Refused' }], structuredContent }
    const { entries } = run([
      completed({ ...call('a', 'kettu', 'report_step'), status: 'failed', result }),
      completed({ ...call('b', 'other', 'report_step'), result }),
    ])
    expect(entries[0]).toMatchObject({
      structured: {
        accepted: false,
        checks: structuredContent.checks,
        next: { kind: 'retry' },
      },
    })
    expect(entries[0]).not.toHaveProperty('structured.facts')
    expect(entries[1]).not.toHaveProperty('structured')
  })
})

describe('a question asked without waiting', () => {
  const asked = {
    type: 'agentMessage',
    id: 'call_1',
    text: 'Keep the vault?',
    phase: 'final_answer',
    delivery: 'async',
    questions: [{ title: 'Keep the vault?', options: ['Keep it', 'Delete it'] }],
  }
  const reply = (answer: string) => ({
    type: 'userMessage',
    id: 'u1',
    content: [
      {
        type: 'text',
        text:
          '<send_user_message_question_reply>\n' +
          JSON.stringify([
            {
              questionItemId: JSON.stringify(['request_user_input_async', 'call_1', 0]),
              question: 'Keep the vault?',
              answer,
            },
          ]) +
          '\n</send_user_message_question_reply>',
        text_elements: [],
      },
    ],
  })

  it('is a completed step that names the question, not an agent message', () => {
    const { entries } = run([completed(asked)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      id: 't:call_1',
      status: 'completed',
      question: 'Keep the vault?',
      permission: null,
      permissionResult: null,
    })
  })

  it('lists every question with its choices in the step', () => {
    const { entries } = run([
      completed({
        ...asked,
        questions: [
          { title: 'Keep the vault?', options: ['Keep it', 'Delete it'] },
          { title: 'Why?', options: null },
        ],
      }),
    ])
    const entry = entries[0]
    expect(entry?.kind === 'tool' && entry.content).toEqual([
      {
        type: 'markdown',
        markdown: '1. Keep the vault?\n   - Keep it\n   - Delete it\n2. Why?',
      },
    ])
  })

  it('marks the question answered on a replay and draws no message for the reply', () => {
    const { entries } = run([completed(asked), completed(reply('Keep it'))], { replaying: true })
    expect(entries.map((entry) => entry.kind)).toEqual(['tool'])
    expect(entries[0]).toMatchObject({
      permissionResult: {
        kind: 'allow_once',
        questions: [{ question: 'Keep the vault?', answered: true, answer: 'Keep it' }],
      },
    })
  })

  it('keeps a message that only looks like a reply', () => {
    const lookalike = {
      type: 'userMessage',
      id: 'u2',
      content: [
        { type: 'text', text: '<send_user_message_question_reply>not json', text_elements: [] },
      ],
    }
    expect(run([completed(lookalike)], { replaying: true }).entries.map((e) => e.kind)).toEqual([
      'user',
    ])
  })
})

describe('other items', () => {
  it('maps plans, searches, MCP calls, compaction and a reroute', () => {
    const { entries } = run([
      [
        'turn/plan/updated',
        {
          ...at,
          explanation: null,
          plan: [
            { step: 'Read', status: 'completed' },
            { step: 'Fix', status: 'inProgress' },
          ],
        },
      ],
      [
        'turn/plan/updated',
        {
          ...at,
          explanation: null,
          plan: [
            { step: 'Read', status: 'completed' },
            { step: 'Fix', status: 'completed' },
          ],
        },
      ],
      completed({
        type: 'webSearch',
        id: 'w',
        query: 'vitest',
        action: { type: 'search', query: 'vitest', queries: null },
      }),
      completed({
        type: 'webSearch',
        id: 'o',
        query: '',
        action: { type: 'openPage', url: 'https://example.com' },
      }),
      completed({
        type: 'mcpToolCall',
        id: 'mcp',
        server: 'kettu',
        tool: 'create_artifact',
        status: 'completed',
        arguments: { title: 'Notes' },
        result: { content: [{ type: 'text', text: 'Created' }] },
        error: null,
      }),
      started({ type: 'contextCompaction', id: 'c' }),
      completed({ type: 'contextCompaction', id: 'c' }),
      ['model/rerouted', { ...at, fromModel: 'a', toModel: 'b', reason: 'x' }],
    ])
    expect(entries.map((e) => e.kind)).toEqual([
      'plan',
      'tool',
      'tool',
      'tool',
      'compaction',
      'notice',
    ])
    expect(entries[0]).toMatchObject({
      items: [
        { content: 'Read', status: 'completed', priority: 'medium' },
        { content: 'Fix', status: 'completed', priority: 'medium' },
      ],
    })
    expect(entries[1]).toMatchObject({ toolKind: 'search', title: 'Web search: vitest' })
    expect(entries[2]).toMatchObject({ toolKind: 'fetch', title: 'Open https://example.com' })
    expect(entries[3]).toMatchObject({
      toolKind: 'other',
      title: 'kettu: create_artifact',
      content: [{ type: 'markdown', markdown: 'Created' }],
    })
    expect(entries[4]).toMatchObject({ kind: 'compaction', status: 'completed' })
    expect(entries[5]).toMatchObject({ kind: 'notice', title: 'Codex switched from a to b' })
  })

  it('shows raw reasoning only while the thought has no summary', () => {
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      ['item/reasoning/textDelta', { ...at, itemId: 'r', contentIndex: 0, delta: 'raw' }],
      [
        'item/reasoning/summaryTextDelta',
        { ...at, itemId: 'r', summaryIndex: 0, delta: ' summary' },
      ],
      ['item/reasoning/textDelta', { ...at, itemId: 'r', contentIndex: 0, delta: ' more raw' }],
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', markdown: 'raw' },
      { kind: 'thought', markdown: ' summary' },
    ])
  })

  it('keeps each reasoning summary part as a thought of its own', () => {
    const part = (index: number): [string, unknown] => [
      'item/reasoning/summaryPartAdded',
      { ...at, itemId: 'r', summaryIndex: index },
    ]
    const delta = (index: number, text: string): [string, unknown] => [
      'item/reasoning/summaryTextDelta',
      { ...at, itemId: 'r', summaryIndex: index, delta: text },
    ]
    const summary = ['**Verifying shared top bar**', '**Locating artifact import contract**']
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      part(0),
      delta(0, summary[0]!),
      part(1),
      delta(1, summary[1]!),
      completed({ type: 'reasoning', id: 'r', summary, content: [] }),
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', id: 'm:r', markdown: summary[0], streaming: false },
      { kind: 'thought', id: 'm:r#part1', markdown: summary[1], streaming: false },
    ])
  })

  it('starts a new thought at each part Codex announces, even under one index', () => {
    const part: [string, unknown] = [
      'item/reasoning/summaryPartAdded',
      { ...at, itemId: 'r', summaryIndex: 0 },
    ]
    const delta = (text: string): [string, unknown] => [
      'item/reasoning/summaryTextDelta',
      { ...at, itemId: 'r', summaryIndex: 0, delta: text },
    ]
    const { entries } = run([
      started({ type: 'reasoning', id: 'r', summary: [], content: [] }),
      part,
      delta('**One**'),
      part,
      delta('**Two**'),
    ])
    expect(entries).toMatchObject([
      { kind: 'thought', markdown: '**One**' },
      { kind: 'thought', markdown: '**Two**' },
    ])
  })

  it('replays a reasoning item as one thought per summary part', () => {
    const { entries } = run(
      [completed({ type: 'reasoning', id: 'r', summary: ['**One**', '', '**Two**'], content: [] })],
      { replaying: true },
    )
    expect(entries).toMatchObject([
      { kind: 'thought', id: 'm:r', markdown: '**One**', streaming: false },
      { kind: 'thought', id: 'm:r#part1', markdown: '**Two**', streaming: false },
    ])
  })

  it('shows no thought that stays empty', () => {
    const item = { type: 'reasoning', id: 'r', summary: [], content: [] }
    expect(run([started(item), completed(item)]).entries).toEqual([])
    const { entries } = run([
      started(item),
      ['item/reasoning/summaryTextDelta', { ...at, itemId: 'r', summaryIndex: 0, delta: 'Hm' }],
      completed({ ...item, summary: ['Hm'] }),
    ])
    expect(entries).toEqual([
      { kind: 'thought', id: 'm:r', markdown: 'Hm', streaming: false, durationMs: 100 },
    ])
  })

  it('takes no notification it does not know', () => {
    expect(run([['item/somethingNew', at]]).unknown).toEqual(['item/somethingNew'])
  })

  it('leaves the live user message to the host, and replays it', () => {
    const user = {
      type: 'userMessage',
      id: 'u',
      content: [{ type: 'text', text: 'hi', text_elements: [] }],
    }
    expect(run([completed(user)]).entries).toEqual([])
    expect(run([completed(user)], { replaying: true }).entries).toEqual([
      { kind: 'user', id: 'm:u', content: [{ type: 'text', text: 'hi' }] },
    ])
  })
})

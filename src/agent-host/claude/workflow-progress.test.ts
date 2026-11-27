// Huli: what the Claude Code mapper makes of a workflow's progress, against the shapes Claude Code
// 2.1.326 sends: `task_progress` with the run's `workflow_progress` rows, `workflow_phase` and
// `workflow_agent`, each replaced in place as it changes.

import { describe, expect, it } from 'vitest'
import { threadFromSnapshot, type BackgroundTaskView } from '@shared/thread'
import { newTurnScope, type MapperContext, type MapperEffect } from '../session-updates'
import { ClaudeMapper } from './mapper'
import type { SdkMessage, StoredMessage } from './sdk'
import { AGENT_REPLY_LIMIT, lastReply } from './workflow-progress'

const SESSION = 'claude-1'

const context = (): MapperContext => ({
  thread: threadFromSnapshot({
    session: {
      id: 'k1',
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: SESSION,
      status: 'ready',
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
  }),
  replaying: false,
  cancelling: false,
  scope: newTurnScope(),
  now: 1_000,
  nextId: () => 'e:1',
  sessionIdFor: (id) => `kettu-${id}`,
})

/** What each message sent, by the session it went to. */
class Run {
  readonly sent: { sessionId: string; effect: MapperEffect }[] = []
  constructor(readonly mapper = new ClaudeMapper(SESSION, '/repo')) {}

  feed(...messages: Record<string, unknown>[]): this {
    for (const message of messages) {
      const deliveries = this.mapper.live({ session_id: SESSION, ...message } as SdkMessage) ?? []
      for (const delivery of deliveries) {
        for (const effect of delivery.map(context()).effects) {
          this.sent.push({ sessionId: delivery.sessionId, effect })
        }
      }
    }
    return this
  }

  /** Every list of background tasks the session was sent. */
  lists(): BackgroundTaskView[][] {
    return this.sent.flatMap(({ effect }) => (effect.kind === 'tasks' ? [effect.tasks] : []))
  }

  workflow(): BackgroundTaskView {
    const task = this.lists()
      .at(-1)
      ?.find((item) => item.id === 'w1')
    if (!task) throw new Error('no workflow listed')
    return task
  }
}

const system = (subtype: string, fields: Record<string, unknown>) => ({
  type: 'system',
  subtype,
  uuid: `u-${subtype}`,
  ...fields,
})

const started = system('task_started', {
  task_id: 'w1',
  run_id: 'r1',
  tool_use_id: 'toolu_wf',
  description: 'Review the paper',
  task_type: 'local_workflow',
  workflow_name: 'review',
})

const phase = (index: number, title: string) => ({ type: 'workflow_phase', index, title })

/** An agent's row as the run writes it, with the fields every row of a started agent has. */
const agent = (index: number, fields: Record<string, unknown>) => ({
  type: 'workflow_agent',
  index,
  label: `agent ${index}`,
  phaseIndex: 1,
  phaseTitle: '调研',
  agentId: `a${index}`,
  model: 'claude-sonnet-4-5',
  queuedAt: 100,
  attempt: 1,
  promptPreview: `Prompt of agent ${index}`,
  promptFramed: true,
  lastProgressAt: 200,
  ...fields,
})

const progress = (rows: unknown[] | undefined, fields: Record<string, unknown> = {}) =>
  system('task_progress', {
    task_id: 'w1',
    run_id: 'r1',
    tool_use_id: 'toolu_wf',
    description: '调研: agent 1',
    usage: { total_tokens: 10, tool_uses: 2, duration_ms: 50 },
    last_tool_name: 'agent 1',
    summary: 'Review the paper',
    ...(rows ? { workflow_progress: rows } : {}),
    ...fields,
  })

const ROWS = [
  phase(1, '调研'),
  phase(2, '审核'),
  agent(1, {
    state: 'done',
    startedAt: 150,
    durationMs: 4_000,
    tokens: 900,
    toolCalls: 4,
    lastToolName: 'Read',
    lastToolSummary: 'Reading a.ts',
    resultPreview: '{"verdict":"ok"}',
  }),
  agent(2, { state: 'error', startedAt: 150, durationMs: 1_000, error: 'API Error: 529' }),
  agent(3, {
    state: 'progress',
    startedAt: 160,
    phaseIndex: 2,
    phaseTitle: '审核',
    lastToolName: 'Grep',
    lastToolSummary: '  Searching   for "x"\n',
    tokens: 30,
    toolCalls: 1,
  }),
  // Queued for its turn: no start yet.
  agent(4, { state: 'start', phaseIndex: 2, phaseTitle: '审核', agentId: undefined }),
  // Begun, with only its last tool's name so far.
  agent(5, {
    state: 'start',
    phaseIndex: 2,
    phaseTitle: '审核',
    startedAt: 170,
    lastToolName: 'Read',
  }),
]

describe("Huli: a Claude Code workflow's agents", () => {
  it('lists them by phase on its board row, as its run reports them', () => {
    const run = new Run().feed(started, progress(ROWS))
    const task = run.workflow()
    expect(task).toMatchObject({ kind: 'workflow', title: 'Review the paper', status: 'running' })
    // Its summary is only its name.
    expect(task).not.toHaveProperty('progress')
    expect(task.workflow).toEqual({
      phases: [
        { index: 1, title: '调研' },
        { index: 2, title: '审核' },
      ],
      agents: [
        {
          index: 1,
          label: 'agent 1',
          phase: 1,
          state: 'done',
          startedAt: 150,
          durationMs: 4_000,
          progress: null,
          error: null,
        },
        {
          index: 2,
          label: 'agent 2',
          phase: 1,
          state: 'failed',
          startedAt: 150,
          durationMs: 1_000,
          progress: null,
          error: 'API Error: 529',
        },
        {
          index: 3,
          label: 'agent 3',
          phase: 2,
          state: 'running',
          startedAt: 160,
          durationMs: null,
          progress: 'Searching for "x"',
          error: null,
        },
        {
          index: 4,
          label: 'agent 4',
          phase: 2,
          state: 'queued',
          startedAt: null,
          durationMs: null,
          progress: null,
          error: null,
        },
        {
          index: 5,
          label: 'agent 5',
          phase: 2,
          state: 'running',
          startedAt: 170,
          durationMs: null,
          progress: 'Read',
          error: null,
        },
      ],
    })
  })

  it('sends the list again only when what the board shows changed', () => {
    const run = new Run().feed(started, progress(ROWS))
    const before = run.lists().length
    const shown = run.workflow().workflow!
    // Progress of an agent's own, between full lists, and the same list again change nothing.
    run.feed(progress(undefined), progress(ROWS), progress(ROWS, { resent: true }))
    expect(run.lists()).toHaveLength(before)
    // One agent moved on: the others keep their objects.
    const next = ROWS.map((row) =>
      row.type === 'workflow_agent' && row.index === 3
        ? { ...row, lastToolSummary: 'Reading b.ts', tokens: 60 }
        : row,
    )
    run.feed(progress(next))
    const now = run.workflow().workflow!
    expect(run.lists()).toHaveLength(before + 1)
    expect(now.agents[2]!.progress).toBe('Reading b.ts')
    expect(now.agents[0]).toBe(shown.agents[0])
    expect(now.agents[2]).not.toBe(shown.agents[2])
  })

  it('shows the wait for a usage limit to reset, and drops it once the run goes on', () => {
    const run = new Run().feed(
      started,
      progress(ROWS, {
        summary: 'Waiting for the usage limit to reset at 3pm',
        usage_limit_wait: { resets_at: 1_900_000_000 },
      }),
    )
    expect(run.workflow().progress).toBe('Waiting for the usage limit to reset at 3pm')
    run.feed(progress(ROWS))
    expect(run.workflow()).not.toHaveProperty('progress')
  })

  it('stops what still ran when the workflow ends, and tells stopped agents from failed ones', () => {
    const rows = [
      ...ROWS,
      agent(6, { state: 'error', startedAt: 150, error: 'skipped by user' }),
      agent(7, {
        state: 'error',
        startedAt: 150,
        error: 'Stopped because the workflow was stopped',
        endedWithRun: 'killed',
      }),
    ]
    const run = new Run().feed(
      started,
      progress(rows),
      system('task_updated', { task_id: 'w1', patch: { status: 'killed', end_time: 5_000 } }),
      system('task_notification', {
        task_id: 'w1',
        status: 'stopped',
        summary: 'Dynamic workflow "Review the paper" was stopped',
        output_file: '',
      }),
    )
    const task = run.workflow()
    expect(task).toMatchObject({ status: 'stopped', endedAt: 5_000 })
    expect(task.workflow!.agents.map((item) => [item.index, item.state])).toEqual([
      [1, 'done'],
      [2, 'failed'],
      [3, 'stopped'],
      [4, 'stopped'],
      [5, 'stopped'],
      [6, 'stopped'],
      [7, 'stopped'],
    ])
    expect(task.workflow!.agents[2]!.progress).toBeNull()
    // A list that comes after the end changes nothing.
    const lists = run.lists().length
    run.feed(progress(ROWS))
    expect(run.lists()).toHaveLength(lists)
  })

  it("keeps what an agent was asked and gave back through an ended run's list cut to fit", () => {
    const run = new Run().feed(started, progress(ROWS))
    expect(run.mapper.workflowAgent('w1', 1)).toEqual({
      prompt: 'Prompt of agent 1',
      result: '{"verdict":"ok"}',
      error: null,
      model: 'claude-sonnet-4-5',
      tokens: 900,
      toolCalls: 4,
      lastTool: 'Read',
      attempt: 1,
      agentId: 'a1',
      ended: true,
    })
    // The notification's list leaves out what each was asked and returned.
    run.feed(
      system('task_notification', {
        task_id: 'w1',
        status: 'completed',
        summary: 'Dynamic workflow "Review the paper" completed',
        output_file: '',
        workflow_progress: [
          phase(1, '调研'),
          // Only the fields Claude Code keeps of a row when it cuts the list down.
          {
            type: 'workflow_agent',
            index: 1,
            label: 'agent 1',
            state: 'done',
            phaseIndex: 1,
            queuedAt: 100,
            startedAt: 150,
            tokens: 900,
            toolCalls: 4,
            durationMs: 4_000,
          },
          {
            type: 'workflow_agent',
            index: 3,
            label: 'agent 3',
            state: 'done',
            phaseIndex: 2,
            startedAt: 160,
            durationMs: 9_000,
          },
        ],
        workflow_progress_omitted: 0,
      }),
    )
    expect(run.mapper.workflowAgent('w1', 1)).toMatchObject({
      prompt: 'Prompt of agent 1',
      result: '{"verdict":"ok"}',
      model: 'claude-sonnet-4-5',
      attempt: 1,
      agentId: 'a1',
    })
    expect(run.workflow().workflow!.agents[0]).toMatchObject({ state: 'done', durationMs: 4_000 })
    expect(run.workflow().workflow!.agents[2]).toMatchObject({ state: 'done', durationMs: 9_000 })
    expect(run.mapper.workflowAgent('w1', 3)).toMatchObject({ ended: true, tokens: 30 })
    expect(run.mapper.workflowAgent('w1', 4)).toMatchObject({ ended: true, agentId: null })
    expect(run.mapper.workflowAgent('w1', 99)).toBeNull()
    expect(run.mapper.workflowAgent('other', 1)).toBeNull()
  })

  it('takes rows that come before the task is listed', () => {
    const run = new Run().feed(progress(ROWS))
    expect(run.lists()).toEqual([])
    run.feed(started)
    expect(run.workflow().workflow!.agents).toHaveLength(5)
  })

  it('forgets a run whose task Clean forgot', () => {
    const run = new Run().feed(
      started,
      progress(ROWS),
      system('task_updated', { task_id: 'w1', patch: { status: 'completed', end_time: 5_000 } }),
    )
    run.mapper.cleanEnded()
    expect(run.mapper.workflowAgent('w1', 1)).toBeNull()
  })
})

describe("Huli: a subagent's parent", () => {
  const subagent = (taskId: string, parent?: string) =>
    system('task_started', {
      task_id: taskId,
      tool_use_id: `toolu_${taskId}`,
      description: `Explore ${taskId}`,
      subagent_type: 'Explore',
      task_type: 'local_agent',
      ...(parent ? { parent_task_id: parent } : {}),
    })
  const startedUnder = (run: Run, taskId: string) =>
    run.sent.find(
      ({ effect }) =>
        effect.kind === 'subagent' && effect.sessionId === taskId && effect.state !== undefined,
    )?.sessionId

  it('is the subagent that launched it while that runs', () => {
    const run = new Run().feed(subagent('p1'), subagent('c1', 'p1'))
    expect(startedUnder(run, 'c1')).toBe('p1')
  })

  it('is the session when the parent is a task it never reported', () => {
    const run = new Run().feed(subagent('c1', 'gone'))
    expect(startedUnder(run, 'c1')).toBe(SESSION)
  })

  it('is a parent the connection knows from before, as one an earlier process started', () => {
    const mapper = new ClaudeMapper(SESSION, '/repo', undefined, null, (id) => id === 'old')
    const run = new Run(mapper).feed(subagent('c1', 'old'))
    expect(startedUnder(run, 'c1')).toBe('old')
  })
})

describe("Huli: a workflow agent's last message", () => {
  const assistant = (content: unknown[]): StoredMessage => ({
    type: 'assistant',
    uuid: 'u',
    session_id: SESSION,
    message: { role: 'assistant', content },
    parent_tool_use_id: null,
  })
  const user: StoredMessage = {
    type: 'user',
    uuid: 'u0',
    session_id: SESSION,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
    parent_tool_use_id: null,
  }

  it('is its last text, past the calls after it', () => {
    expect(
      lastReply([
        assistant([{ type: 'text', text: 'Early' }]),
        assistant([
          { type: 'text', text: '  Found two problems.' },
          { type: 'text', text: 'Both in a.ts.  ' },
        ]),
        assistant([{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
        user,
      ]),
    ).toEqual({ text: 'Found two problems.\n\nBoth in a.ts.', truncated: false })
  })

  it('is the structured result it returned when it wrote no text', () => {
    expect(
      lastReply([
        assistant([
          { type: 'tool_use', id: 't', name: 'StructuredOutput', input: { verdict: 'ok' } },
        ]),
      ]),
    ).toEqual({ text: '{\n  "verdict": "ok"\n}', truncated: false })
  })

  it('is cut to its first 16 KiB, and is none before it said anything', () => {
    const long = lastReply([assistant([{ type: 'text', text: 'x'.repeat(AGENT_REPLY_LIMIT + 5) }])])
    expect(long).toEqual({ text: 'x'.repeat(AGENT_REPLY_LIMIT), truncated: true })
    expect(lastReply([user])).toBeNull()
    expect(lastReply([])).toBeNull()
  })
})

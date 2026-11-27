// The `workflow` scenario: a multi-agent workflow on the session board, as Claude Code's Workflow
// tool runs one (task_type local_workflow), through Kite's own task extension (processes.ts). The
// turn starts it and ends; the run goes on: a first phase of three agents ends at once, a second
// of six comes to three done, one failed, one at work and one queued, and holds there (`--hold
// <ms>`, 90 s by default) while the one at work says what it does, then it all ends with a third
// phase. `_kite/tasks/agent` answers what an agent was asked and gave back.

import { sessionBoard, type Task } from './processes.ts'
import type { Scenario } from './turn.ts'

interface Agent {
  index: number
  label: string
  phase: number
  steps: string[]
  /** Listed once the run queued it. */
  shown: boolean
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number | null
  durationMs: number | null
  progress: string | null
  error: string | null
}

const PHASES = [
  { index: 1, title: '调研' },
  { index: 2, title: '审核' },
  { index: 3, title: '汇总' },
]

const AGENTS: { label: string; phase: number; steps: string[] }[] = [
  { label: '梳理会话接口', phase: 1, steps: ['Reading src/shared/agent-host.ts'] },
  { label: '读现有测试', phase: 1, steps: ['Searching for "describe(" in src/agent-host'] },
  { label: '查依赖版本', phase: 1, steps: ['Reading package.json'] },
  { label: '审核 auth 模块', phase: 2, steps: ['Reading src/agent-host/auth.ts'] },
  { label: '审核 sessions', phase: 2, steps: ['Reading src/agent-host/sessions.ts'] },
  { label: '审核 IPC 校验', phase: 2, steps: ['Running npx vitest run validate'] },
  {
    label: '审核 board UI',
    phase: 2,
    steps: [
      'Reading src/renderer/src/features/board/board-pane.tsx',
      'Searching for "useThreadsStore" in features/board',
      'Comparing the live and ended rows',
    ],
  },
  { label: '审核 mapper', phase: 2, steps: ['Reading src/agent-host/claude/mapper.ts'] },
  { label: '审核手机端', phase: 2, steps: ['Reading mobile/src/app/background/[id].tsx'] },
  { label: '合并发现', phase: 3, steps: ["Reading the reviewers' findings"] },
  { label: '写报告', phase: 3, steps: ['Writing REVIEW.md'] },
]

/** The agents of the second phase that fail, that hold at work, and that end before the hold. */
const FAILS = 5
const HOLDS = 7
const ENDS = [4, 6, 8]

function promptOf(label: string): string {
  return (
    `You are one agent of a review workflow. Task: ${label}.\n\n` +
    'Read the code it names, list each problem with its file and line, and say how sure you ' +
    'are. Return a JSON object with `findings` and `confidence`.'
  )
}

function replyOf(label: string): string {
  return (
    `${label}: done.\n\n` +
    '- No blocking problems found.\n' +
    '- One naming nit: the helper reads better as `readTasks`.\n' +
    '- Tests cover the happy path; the empty list is not covered.\n\n' +
    'Confidence: high.'
  )
}

export const workflow: Scenario = async (turn) => {
  const board = sessionBoard(turn.session.id, turn.notify)
  const hold = turn.options.holdMs > 0 ? turn.options.holdMs : 90_000
  const agents: Agent[] = AGENTS.map((item, i) => ({
    ...item,
    index: i + 1,
    shown: false,
    state: 'queued',
    startedAt: null,
    durationMs: null,
    progress: null,
    error: null,
  }))
  const agent = (index: number) => agents[index - 1]!
  const ofPhase = (phase: number) => agents.filter((item) => item.phase === phase)
  const details = new Map<number, Record<string, unknown>>()
  const task: Task = {
    id: `wf-${turn.id}`,
    kind: 'workflow',
    title: 'Review the board and its sources',
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    summary: null,
    child: null,
    output: '',
    details,
  }
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let ticker: ReturnType<typeof setInterval> | undefined
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (task.status !== 'running') return
      run()
      publish()
    }, ms)
    timers.add(timer)
  }
  const list = () => {
    task.workflow = {
      phases: PHASES,
      agents: agents.flatMap((item) =>
        item.shown
          ? [
              {
                index: item.index,
                label: item.label,
                phase: item.phase,
                state: item.state,
                startedAt: item.startedAt,
                durationMs: item.durationMs,
                progress: item.progress,
                error: item.error,
              },
            ]
          : [],
      ),
    }
  }
  const publish = () => {
    list()
    board.publish()
  }
  const detail = (item: Agent, extra: Record<string, unknown> = {}) => {
    details.set(item.index, {
      prompt: promptOf(item.label),
      result: null,
      reply: null,
      error: null,
      model: 'claude-sonnet-4-5',
      tokens: 12_000 * item.index,
      toolCalls: 2 + item.index,
      lastTool: 'Read',
      attempt: 1,
      ...extra,
    })
  }
  const queue = (phase: number) => {
    for (const item of ofPhase(phase)) {
      item.shown = true
      detail(item)
    }
  }
  const start = (item: Agent) => {
    item.state = 'running'
    item.startedAt = Date.now()
    item.progress = item.steps[0]!
  }
  const finish = (item: Agent, state: 'done' | 'failed', ms: number) => {
    item.state = state
    item.startedAt ??= Date.now() - ms
    item.durationMs = ms
    item.progress = null
    if (state === 'failed') {
      item.error = 'API Error: 529 Overloaded. The server is busy; try again later.'
      detail(item, { error: item.error, lastTool: 'Bash', attempt: 2 })
    } else {
      const reply = replyOf(item.label)
      detail(item, { result: reply.slice(0, 120), reply: { text: reply, truncated: false } })
    }
  }
  task.onStop = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    clearInterval(ticker)
    for (const item of agents) {
      if (item.state !== 'running' && item.state !== 'queued') continue
      item.state = 'stopped'
      item.progress = null
      item.error = 'Stopped because the workflow was stopped'
    }
    list()
  }
  board.tasks.set(task.id, task)

  // The first phase: three agents start together and end soon.
  queue(1)
  for (const item of ofPhase(1)) start(item)
  publish()
  later(1_500, () => {
    ofPhase(1).forEach((item, i) => finish(item, 'done', 1_200 + i * 300))
    // The second: six agents queued, four start at once.
    queue(2)
    for (const item of ofPhase(2).slice(0, 4)) start(item)
  })
  later(3_000, () => {
    finish(agent(FAILS), 'failed', 1_400)
    for (const index of ENDS) finish(agent(index), 'done', 1_000 + index * 250)
    let step = 0
    ticker = setInterval(() => {
      const item = agent(HOLDS)
      item.progress = item.steps[++step % item.steps.length]!
      publish()
    }, 5_000)
  })
  later(3_000 + hold, () => {
    clearInterval(ticker)
    for (const item of ofPhase(2)) {
      if (item.state === 'running' || item.state === 'queued') finish(item, 'done', 2_000)
    }
    queue(3)
    for (const item of ofPhase(3)) start(item)
  })
  later(5_000 + hold, () => {
    for (const item of ofPhase(3)) finish(item, 'done', 1_800)
    task.status = 'completed'
    task.endedAt = Date.now()
    task.summary = 'Dynamic workflow "Review the board and its sources" completed'
  })

  await turn.send({
    sessionUpdate: 'agent_message_chunk',
    messageId: turn.messageId(),
    content: {
      type: 'text',
      text: 'I started a review workflow in the background: three phases, eleven agents. Its agents are on the board.',
    },
  })
  return 'end_turn'
}

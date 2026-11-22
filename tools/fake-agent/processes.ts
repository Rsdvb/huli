// The `processes` scenario: background tasks the session board lists, through Kite's own ACP
// extension (`_kite/tasks`, see src/agent-host/acp/kite-tasks.ts). It starts real processes, so
// the board reads their CPU, memory and ports: a dev server on KITE_PORT (or a free port), a
// second server outside that block, and a watcher that prints a line a second. A test run then
// holds up its tool call until the client moves it to the background or it ends, a quick command
// ends at once, and a subagent says what it does in a line that changes. Every process of a
// session ends with the agent.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Scenario, Turn } from './turn.ts'

export const KITE_TASKS = {
  list: '_kite/tasks',
  stop: '_kite/tasks/stop',
  output: '_kite/tasks/output',
  background: '_kite/tasks/background',
  clean: '_kite/tasks/clean',
} as const

const OUTPUT_KEPT = 8 * 1024

interface Task {
  id: string
  kind: 'shell' | 'monitor'
  title: string
  command: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  summary: string | null
  child: ChildProcess | null
  output: string
}

interface Held {
  toolCallId: string
  taskId: string
  kind: 'shell' | 'subagent'
  title: string
  startedAt: number
  /** Ends the hold: true when the client moved it to the background. */
  release(moved: boolean): void
}

type Notify = (method: string, params: unknown) => Promise<void>

/** One session's tasks, kept past its turns. */
class Board {
  readonly tasks = new Map<string, Task>()
  readonly held = new Map<string, Held>()
  readonly progress = new Map<string, string>()

  private readonly sessionId: string
  private readonly notify: Notify

  constructor(sessionId: string, notify: Notify) {
    this.sessionId = sessionId
    this.notify = notify
  }

  publish(): void {
    void this.notify(KITE_TASKS.list, {
      sessionId: this.sessionId,
      tasks: [...this.tasks.values()].map((task) => ({
        id: task.id,
        kind: task.kind,
        title: task.title,
        command: task.command,
        status: task.status,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        summary: task.summary,
        ...(task.child?.pid && task.status === 'running' ? { pid: task.child.pid } : {}),
      })),
      foreground: [...this.held.values()].map((held) => ({
        toolCallId: held.toolCallId,
        taskId: held.taskId,
        kind: held.kind,
        title: held.title,
        startedAt: held.startedAt,
      })),
      subagents: [...this.progress].map(([sessionId, progress]) => ({ sessionId, progress })),
    }).catch(() => {})
  }

  /** Runs `script` in a Node process of its own as a running task. */
  start(id: string, kind: Task['kind'], title: string, command: string, script: string): Task {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
    const task: Task = {
      id,
      kind,
      title,
      command,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      summary: null,
      child,
      output: '',
    }
    const take = (chunk: Buffer) => {
      task.output = (task.output + chunk.toString('utf8')).slice(-OUTPUT_KEPT)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.once('exit', (code) => {
      if (task.status !== 'running') return
      task.status = code === 0 ? 'completed' : 'failed'
      task.endedAt = Date.now()
      task.summary = `${title} (exit code ${code ?? 1})`
      task.child = null
      this.publish()
    })
    this.tasks.set(id, task)
    return task
  }

  /** A task that ran and ended before the board saw it. */
  ended(id: string, title: string, command: string, output: string, ms: number): void {
    const now = Date.now()
    this.tasks.set(id, {
      id,
      kind: 'shell',
      title,
      command,
      status: 'completed',
      startedAt: now - ms,
      endedAt: now,
      summary: `${title} (exit code 0)`,
      child: null,
      output,
    })
  }

  stop(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') throw new Error('That task is not running')
    task.status = 'stopped'
    task.endedAt = Date.now()
    task.summary = `${task.title} was stopped`
    task.child?.kill()
    task.child = null
    this.publish()
  }

  output(taskId: string): { output: string; truncated: boolean } {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('No such task')
    return { output: task.output, truncated: task.output.length >= OUTPUT_KEPT }
  }

  background(toolCallId: string | undefined): boolean {
    const held = [...this.held.values()].filter(
      (item) => toolCallId === undefined || item.toolCallId === toolCallId,
    )
    for (const item of held) item.release(true)
    return held.length > 0
  }

  clean(): void {
    for (const [id, task] of this.tasks) if (task.status !== 'running') this.tasks.delete(id)
    this.publish()
  }
}

const boards = new Map<string, Board>()

/** The board of a session a request names; throws for one without. */
export function boardOf(params: unknown): {
  board: Board
  params: Record<string, unknown>
} {
  const record = (params ?? {}) as Record<string, unknown>
  const board = typeof record.sessionId === 'string' ? boards.get(record.sessionId) : undefined
  if (!board) throw new Error('This session runs no tasks')
  return { board, params: record }
}

/** Ends every task process, as the agent exits. */
function stopAllTasks(): void {
  for (const board of boards.values()) {
    for (const task of board.tasks.values()) task.child?.kill()
  }
}
process.once('exit', stopAllTasks)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const serverScript = (port: number, name: string) =>
  `const http = require('node:http');` +
  `http.createServer((q, s) => s.end(${JSON.stringify(name)})).listen(${port}, '127.0.0.1', () => {` +
  `console.log('  ${name} ready on http://localhost:${port}/');` +
  `setInterval(() => console.log('  [hmr] ' + new Date().toLocaleTimeString() + ' page reload'), 4000)` +
  `})`

const WATCH_SCRIPT = `let n = 0; setInterval(() => console.log('watching src/ … ' + (++n) + ' change(s) seen'), 1000)`

const TEST_SCRIPT =
  `let n = 0; const t = setInterval(() => { console.log('PASS test ' + (++n)); ` +
  `if (n >= 45) { clearInterval(t); console.log('45 passed'); } }, 1000)`

async function say(turn: Turn, text: string): Promise<void> {
  await turn.send({
    sessionUpdate: 'agent_message_chunk',
    messageId: turn.messageId(),
    content: { type: 'text', text },
  })
}

export const processes: Scenario = async (turn) => {
  const sessionId = turn.session.id
  let board = boards.get(sessionId)
  if (!board) {
    board = new Board(sessionId, turn.notify)
    boards.set(sessionId, board)
  }
  const n = turn.id
  const base = Number(process.env.KITE_PORT) || (await freePort())
  const outside = Number(process.env.KITE_PORT) ? base + 100 : await freePort()
  await say(turn, 'Starting the dev servers and a watcher in the background.\n\n')
  board.start(
    `dev-${n}`,
    'shell',
    'Start the dev server',
    'npm run dev',
    serverScript(base, 'vite'),
  )
  board.start(
    `api-${n}`,
    'shell',
    'Start the API server',
    `node server.js --port ${outside}`,
    serverScript(outside, 'api'),
  )
  board.start(`watch-${n}`, 'monitor', 'Watch src for changes', 'tsc --watch', WATCH_SCRIPT)
  board.ended(`lint-${n}`, 'Run the linter', 'npm run lint', '✔ No problems found\n', 3200)

  // A subagent that says what it does, for the row that shows it.
  const child = `${sessionId}-explore-${n}`
  if (turn.supportsSubagents) {
    await turn.send({
      sessionUpdate: 'subagent_update',
      sessionId: child,
      title: 'Explore the build setup',
      description: 'Explore',
      capabilities: { cancel: {} },
      state: { state: 'running' },
    })
    board.progress.set(child, 'Reading vite.config.ts and the workspace packages')
  }
  board.publish()

  // The test run holds up its call until it is moved to the background or ends.
  const toolCallId = `test-${n}`
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'npm test',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'npm test', description: 'Run the test suite' },
  })
  const test = board.start(`test-${n}`, 'shell', 'Run the test suite', 'npm test', TEST_SCRIPT)
  board.tasks.delete(test.id)
  const moved = await new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      board.held.delete(toolCallId)
      clearInterval(summaries)
      resolve(value)
    }
    board.held.set(toolCallId, {
      toolCallId,
      taskId: test.id,
      kind: 'shell',
      title: 'npm test',
      startedAt: Date.now(),
      release: done,
    })
    board.publish()
    const lines = [
      'Comparing the dev and build configs',
      'Checking how the workspace packages are linked',
      'Writing up what it found',
    ]
    let step = 0
    const summaries = setInterval(() => {
      if (!turn.supportsSubagents) return
      board.progress.set(child, lines[step++ % lines.length]!)
      board.publish()
    }, 6000)
    test.child?.once('exit', () => done(false))
    turn.signal.addEventListener('abort', () => done(false), { once: true })
  })
  if (moved) {
    board.tasks.set(test.id, test)
  } else {
    test.child?.kill()
  }
  board.publish()
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: moved ? 'Command running in background with ID: ' + test.id : test.output,
        },
      },
    ],
  })
  if (turn.signal.aborted) return 'cancelled'
  if (turn.supportsSubagents) {
    board.progress.delete(child)
    await turn.send({
      sessionUpdate: 'subagent_update',
      sessionId: child,
      state: { state: 'idle', stopReason: 'end_turn' },
    })
  }
  board.publish()
  await say(
    turn,
    moved
      ? 'The tests go on in the background; the dev servers and the watcher keep running.'
      : 'The tests finished; the dev servers and the watcher keep running.',
  )
  return 'end_turn'
}

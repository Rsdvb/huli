import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MANAGER_SETTINGS,
  newManager,
  type DigestItem,
  type ManagerSettings,
  type RosterWorker,
} from '@shared/manager'
import type { FromSession, StopReason } from '@shared/thread'
import type { SessionRecord } from '../storage'
import { ManagerHub, type ManagerPort, type PortState, type WorkerSpec } from './hub'

const writer: RosterWorker = {
  id: 'w-00000001',
  name: '写手',
  role: 'implement',
  agentId: 'codex',
  model: 'gpt-5.5',
  effort: null,
  profileId: null,
  mode: null,
  worktree: false,
  persona: '你写代码干净利落。',
}
const helper: RosterWorker = { ...writer, id: 'w-00000002', name: '杂活', role: 'other' }
const reviewer: RosterWorker = {
  ...writer,
  id: 'w-00000003',
  name: '审阅',
  role: 'review',
  agentId: 'claude-code',
  persona: '你是严格的审阅者。',
}
const planner: RosterWorker = { ...reviewer, id: 'w-00000004', name: '规划', role: 'plan' }

interface Queued {
  id: string
  text: string
  from: FromSession
}

/** The session manager as the coordinator sees it, with sessions that do what a test says. */
class FakePort implements ManagerPort {
  clock = 1_000_000
  settingsValue: ManagerSettings = {
    ...structuredClone(DEFAULT_MANAGER_SETTINGS),
    workers: [writer, helper, reviewer, planner],
    reviewerId: reviewer.id,
  }
  readonly store = new Map<string, SessionRecord>()
  readonly states = new Map<string, PortState>()
  readonly replies = new Map<string, string>()
  readonly errors = new Map<string, string>()
  readonly sent: { id: string; text: string }[] = []
  readonly created: { id: string; spec: WorkerSpec }[] = []
  readonly wakes: { text: string; digest: DigestItem[] }[] = []
  readonly queues = new Map<string, Queued[]>()
  readonly cancelled: string[] = []
  readonly notices: string[] = []
  readonly attentions: string[] = []
  readonly answered: { id: string; requestId: string; allow: boolean }[] = []
  readonly pendings = new Map<
    string,
    { requestId: string; what: string; level: 'low' | 'medium' | 'high' }[]
  >()
  hub!: ManagerHub
  private next = 0

  now = () => this.clock
  lang = () => 'zh' as const
  log = () => {}
  settings = () => this.settingsValue
  record = (id: string) => this.store.get(id) ?? null
  records = () => this.store.values()
  save = () => {}
  touch = () => {}
  state = (id: string) => this.states.get(id) ?? null
  folder = (id: string) => this.store.get(id)?.worktree?.path ?? '/repo'
  folderKey = (folder: string) => folder.toLowerCase()
  branch = () => 'main'
  lastReply = async (id: string) => this.replies.get(id) ?? null
  lastError = (id: string) => this.errors.get(id) ?? null
  turnFiles = () => ['src/a.ts']
  head = async () => 'a'.repeat(40)
  numstat = async () => [{ path: 'src/a.ts', added: 4, removed: 1 }]
  agent = () => ({ name: 'Agent', ready: true, reason: null })
  runs = (entry: Pick<RosterWorker, 'agentId' | 'model'>) =>
    `${entry.agentId}${entry.model ? ` · ${entry.model}` : ''}`
  readOnlyMode = () => 'read-only'
  createWorker = async (managerId: string, spec: WorkerSpec) => {
    const id = `s${++this.next}`
    this.store.set(id, {
      ...base(id),
      parentId: managerId,
      startedBy: managerId,
      title: spec.title,
      worker: spec.worker,
    })
    this.created.push({ id, spec })
    this.hub.added(this.store.get(id)!)
    this.startTurn(id, null)
    return id
  }
  send = async (id: string, text: string) => {
    this.sent.push({ id, text })
    this.startTurn(id, null)
  }
  deliver = async (managerId: string, itemId: string | null, text: string, from: FromSession) => {
    const queue = this.queues.get(managerId) ?? []
    const index = itemId === null ? -1 : queue.findIndex((item) => item.id === itemId)
    if (index >= 0) {
      queue[index] = { id: itemId!, text, from }
      this.wakes[this.wakes.length - 1] = { text, digest: from.digest ?? [] }
      return { itemId, merged: true }
    }
    this.wakes.push({ text, digest: from.digest ?? [] })
    const busy = this.states.get(managerId)?.turn === true
    if (!busy) return { itemId: null, merged: false }
    const id = `q${++this.next}`
    this.queues.set(managerId, [...queue, { id, text, from }])
    return { itemId: id, merged: false }
  }
  waitingDigest = (managerId: string, itemId: string) =>
    this.queues.get(managerId)?.find((item) => item.id === itemId)?.from.digest ?? null
  cancel = async (id: string) => {
    this.cancelled.push(id)
    this.endTurn(id, 'cancelled')
  }
  pauseQueue = () => {}
  resumeQueue = async () => {}
  notice = (_id: string, _severity: string, title: string) => {
    this.notices.push(title)
  }
  attention = (_id: string, title: string) => {
    this.attentions.push(title)
  }
  pending = (id: string) => this.pendings.get(id) ?? []
  respond = (id: string, requestId: string, allow: boolean) => {
    const list = this.pendings.get(id) ?? []
    if (!list.some((item) => item.requestId === requestId)) return false
    this.pendings.set(
      id,
      list.filter((item) => item.requestId !== requestId),
    )
    this.answered.push({ id, requestId, allow })
    return true
  }
  assess = (id: string, requestId: string) =>
    this.pendings.get(id)?.find((item) => item.requestId === requestId)?.level ?? null
  text = (key: string, params?: Record<string, string | number>) =>
    params ? `${key} ${JSON.stringify(params)}` : key

  idle(): PortState {
    return {
      status: 'ready',
      turn: false,
      waiting: 0,
      queued: 0,
      queuePaused: false,
      limitPaused: false,
      turnStartedAt: null,
    }
  }

  startTurn(id: string, typed: string | null): void {
    this.states.set(id, {
      ...this.idle(),
      status: 'running',
      turn: true,
      turnStartedAt: this.clock,
    })
    this.hub.turnStarted(id, typed)
  }

  endTurn(id: string, stopReason: StopReason | null): void {
    this.states.set(id, this.idle())
    this.hub.turnEnded(id, stopReason)
  }
}

function base(id: string): SessionRecord {
  return {
    id,
    agentId: 'codex',
    acpSessionId: `acp-${id}`,
    projectPath: '/repo',
    title: null,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
  }
}

/** Lets every microtask and settled promise of the coordinator run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let port: FakePort
let hub: ManagerHub

function manager(over: Partial<Parameters<typeof newManager>[0]> = {}): void {
  port.store.set('m', {
    ...base('m'),
    agentId: 'claude-code',
    manager: newManager({ autoReview: true, approvals: 'user', ...over }, port.clock),
  })
  port.states.set('m', port.idle())
}

/** The worker reports with report_work and its turn ends. */
async function finish(
  id: string,
  report: Parameters<ManagerHub['report']>[1] = {
    status: 'done',
    summary: '改好了',
    changed: [],
    findings: [],
  },
): Promise<void> {
  hub.report(id, report)
  port.endTurn(id, 'end_turn')
  await flush()
}

beforeEach(() => {
  port = new FakePort()
  hub = new ManagerHub(port)
  port.hub = hub
})

describe('dispatch', () => {
  it('starts a worker from the roster, its task as its first message', async () => {
    manager({ autoReview: false })
    const result = await hub.startWorker('m', {
      worker: '写手',
      task: '把时钟改成只读一次',
      acceptance: ['测试通过'],
      files: ['src/clock.ts'],
    })
    expect(result).toEqual({ kind: 'started', id: 's1', existing: false })
    const { spec } = port.created[0]!
    expect(spec.kind).toBe('implement')
    expect(spec.prompt).toContain('把时钟改成只读一次')
    expect(spec.prompt).toContain('- 测试通过')
    expect(spec.prompt).toContain('src/clock.ts')
    // The persona goes ahead on the wire, never into the message.
    expect(spec.prompt).not.toContain('干净利落')
    expect(spec.worker).toMatchObject({
      managerId: 'm',
      name: '写手',
      kind: 'implement',
      base: 'a'.repeat(40),
    })
    expect(port.store.get('m')!.manager!.task.turns).toBe(1)
  })

  it('refuses a worker not on the roster and a writing task to a reader', async () => {
    manager()
    await expect(
      hub.startWorker('m', { worker: '没有', task: 't', acceptance: [], files: [] }),
    ).rejects.toThrow(/No worker "没有"/)
    await expect(
      hub.startWorker('m', {
        worker: '审阅',
        task: 't',
        kind: 'implement',
        acceptance: [],
        files: [],
      }),
    ).rejects.toThrow(/only reads/)
  })

  it('holds a second writer for the same folder and starts it when the first settles', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '写手', task: 'one', acceptance: [], files: [] })
    const held = await hub.startWorker('m', {
      worker: '杂活',
      task: 'two',
      acceptance: [],
      files: [],
    })
    expect(held).toEqual({ kind: 'held', position: 1, reason: 'folder' })
    expect(port.created).toHaveLength(1)
    // A reader goes beside it.
    await hub.startWorker('m', { worker: '规划', task: 'read', acceptance: [], files: [] })
    expect(port.created).toHaveLength(2)
    await finish('s1')
    expect(port.created.map((item) => item.spec.worker.name)).toEqual(['写手', '规划', '杂活'])
  })

  it('returns the same worker for a repeated request id', async () => {
    manager()
    const first = await hub.startWorker('m', {
      worker: '规划',
      task: 'read',
      acceptance: [],
      files: [],
      requestId: 'r1',
    })
    const again = await hub.startWorker('m', {
      worker: '规划',
      task: 'read',
      acceptance: [],
      files: [],
      requestId: 'r1',
    })
    expect(again).toEqual({ kind: 'started', id: (first as { id: string }).id, existing: true })
    expect(port.created).toHaveLength(1)
  })

  it('refuses once the task has spent its turns, until the user gives more', async () => {
    port.settingsValue.limits = { ...port.settingsValue.limits, turnsPerTask: 5 }
    manager()
    port.store.get('m')!.manager!.task.turns = 5
    await expect(
      hub.startWorker('m', { worker: '规划', task: 't', acceptance: [], files: [] }),
    ).rejects.toThrow(/turns are spent/)
    hub.moreTurns('m')
    await expect(
      hub.startWorker('m', { worker: '规划', task: 't', acceptance: [], files: [] }),
    ).resolves.toMatchObject({ kind: 'started' })
  })
})

describe('reports', () => {
  it('wakes the manager once a worker settles, with its structured report', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: '补测试', acceptance: [], files: [] })
    await finish('s1', {
      status: 'done',
      summary: '补了 3 个测试',
      changed: ['src/a.test.ts'],
      findings: [],
    })
    expect(port.wakes).toHaveLength(1)
    expect(port.wakes[0]!.digest).toEqual([
      { sessionId: 's1', name: '杂活', status: 'done', line: '补了 3 个测试' },
    ])
    expect(port.wakes[0]!.text).toContain('补了 3 个测试')
    expect(port.store.get('s1')!.worker!.owed).toBeUndefined()
  })

  it('does not report while a turn the worker queued goes on', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 't', acceptance: [], files: [] })
    hub.report('s1', { status: 'done', summary: 'x', changed: [], findings: [] })
    // The turn ends but the next one starts at once, as a queued message does.
    port.states.set('s1', { ...port.idle(), queued: 1 })
    port.hub.turnEnded('s1', 'end_turn')
    await flush()
    expect(port.wakes).toHaveLength(0)
  })

  it('reminds a worker that ended without report_work once, then reads its reply', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 't', acceptance: [], files: [] })
    port.replies.set('s1', '做完了，改了 a.ts')
    port.endTurn('s1', 'end_turn')
    await flush()
    expect(port.sent.map((item) => item.text)).toEqual([expect.stringContaining('report_work')])
    expect(port.wakes).toHaveLength(0)
    port.endTurn('s1', 'end_turn')
    await flush()
    expect(port.wakes).toHaveLength(1)
    expect(port.store.get('s1')!.worker!.report).toMatchObject({
      status: 'done',
      by: 'derived',
      summary: '做完了，改了 a.ts',
    })
  })

  it('reports a failed turn with its error, without a reminder', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 't', acceptance: [], files: [] })
    port.errors.set('s1', 'DeepSeek 余额不足')
    port.endTurn('s1', null)
    await flush()
    expect(port.sent).toHaveLength(0)
    expect(port.wakes[0]!.digest[0]).toMatchObject({ status: 'failed', line: 'DeepSeek 余额不足' })
  })

  it('merges workers that settle while the manager works into one wake', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '规划', task: 'a', acceptance: [], files: [] })
    await hub.startWorker('m', { worker: '杂活', task: 'b', acceptance: [], files: [] })
    port.states.set('m', { ...port.idle(), status: 'running', turn: true })
    await finish('s1')
    await finish('s2')
    expect(port.wakes).toHaveLength(1)
    expect(port.wakes[0]!.digest.map((item) => item.sessionId)).toEqual(['s1', 's2'])
    expect(port.store.get('m')!.manager!.task.wakes).toBe(1)
  })

  it("quotes what the user said to a worker in the worker's report", async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 't', acceptance: [], files: [] })
    port.endTurn('s1', 'cancelled')
    port.startTurn('s1', '别改 README')
    await finish('s1')
    expect(port.wakes).toHaveLength(1)
    expect(port.wakes[0]!.digest[0]!.said).toEqual(['别改 README'])
    expect(port.wakes[0]!.text).toContain('用户插话：别改 README')
  })

  it('starts a new task when the user writes to the manager, and only then', () => {
    manager()
    const record = port.store.get('m')!
    record.manager!.task.turns = 7
    record.manager!.stoppedAt = 5
    hub.turnStarted('m', null)
    expect(record.manager!.task.turns).toBe(7)
    hub.turnStarted('m', '再加个重试')
    expect(record.manager!.task.turns).toBe(0)
    expect(record.manager!.stoppedAt).toBeUndefined()
  })
})

describe('the review loop', () => {
  it('reviews a finished implementation, sends changes back and wakes the manager once approved', async () => {
    manager()
    await hub.startWorker('m', {
      worker: '写手',
      task: '修复时钟',
      acceptance: ['不再读两次'],
      files: [],
    })
    await finish('s1', {
      status: 'done',
      summary: '改成读一次',
      changed: ['src/clock.ts'],
      findings: [],
    })
    // Round 1: Kite starts the reviewer in the implementer's folder; the manager sleeps.
    expect(port.wakes).toHaveLength(0)
    const review = port.created[1]!
    expect(review.spec).toMatchObject({
      kind: 'review',
      shareWith: 's1',
      readOnlyMode: 'read-only',
    })
    expect(review.spec.prompt).toContain('第 1/3 轮')
    expect(review.spec.prompt).toContain(`git diff ${'a'.repeat(40)}`)
    expect(review.spec.prompt).toContain('- 不再读两次')
    await finish('s2', {
      status: 'done',
      summary: '有一处没处理',
      changed: [],
      verdict: 'changes',
      findings: [{ level: 'must', file: 'src/clock.ts', line: 4, text: 'null 没处理' }],
    })
    expect(port.sent.at(-1)).toMatchObject({ id: 's1' })
    expect(port.sent.at(-1)!.text).toContain('[must] src/clock.ts:4 null 没处理')
    expect(port.wakes).toHaveLength(0)
    await finish('s1', { status: 'done', summary: '处理了 null', changed: [], findings: [] })
    expect(port.sent.at(-1)).toMatchObject({ id: 's2' })
    expect(port.sent.at(-1)!.text).toContain('第 2/3 轮')
    await finish('s2', {
      status: 'done',
      summary: '可以了',
      changed: [],
      verdict: 'approve',
      findings: [],
    })
    expect(port.wakes).toHaveLength(1)
    expect(port.wakes[0]!.digest).toEqual([
      { sessionId: 's1', name: '写手', status: 'approved', line: '处理了 null', round: 2 },
    ])
  })

  it('asks the user after the last round', async () => {
    port.settingsValue.limits = { ...port.settingsValue.limits, reviewRounds: 1 }
    manager()
    await hub.startWorker('m', { worker: '写手', task: 't', acceptance: [], files: [] })
    await finish('s1')
    await finish('s2', {
      status: 'done',
      summary: '不行',
      changed: [],
      verdict: 'changes',
      findings: [{ level: 'must', text: '没有测试' }],
    })
    expect(port.wakes[0]!.digest[0]).toMatchObject({ sessionId: 's1', status: 'out_of_rounds' })
    expect(port.wakes[0]!.text).toContain('[must] 没有测试')
    expect(port.attentions).toEqual(['manager.outOfRounds.title'])
  })

  it('needs a verdict from a reviewer that reports done', async () => {
    manager()
    await hub.startWorker('m', { worker: '写手', task: 't', acceptance: [], files: [] })
    await finish('s1')
    expect(() =>
      hub.report('s2', { status: 'done', summary: 'ok', changed: [], findings: [] }),
    ).toThrow(/verdict/)
  })

  it('stays off for a session without it, and for odd jobs', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '写手', task: 't', acceptance: [], files: [] })
    await finish('s1')
    expect(port.created).toHaveLength(1)
    expect(port.wakes).toHaveLength(1)
  })
})

describe("the user's controls", () => {
  it('stops the manager and its working workers, and nothing wakes it after', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '规划', task: 'a', acceptance: [], files: [] })
    await hub.startWorker('m', { worker: '杂活', task: 'b', acceptance: [], files: [] })
    await hub.stopAll('m')
    await flush()
    expect(port.cancelled.sort()).toEqual(['s1', 's2'])
    expect(port.wakes).toHaveLength(0)
    expect(port.notices).toEqual([expect.stringContaining('manager.stoppedAll.title')])
    await expect(
      hub.startWorker('m', { worker: '规划', task: 'c', acceptance: [], files: [] }),
    ).rejects.toThrow(/stopped everything/)
  })

  it('holds reports while paused and sends them on resume', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 'a', acceptance: [], files: [] })
    await hub.setPaused('m', true)
    await finish('s1')
    expect(port.wakes).toHaveLength(0)
    await hub.setPaused('m', false)
    await flush()
    expect(port.wakes).toHaveLength(1)
  })

  it('reports nothing of a worker the user took over', async () => {
    manager({ autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 'a', acceptance: [], files: [] })
    hub.setDetached('s1', true)
    port.startTurn('s1', '我自己来')
    await finish('s1')
    expect(port.wakes).toHaveLength(0)
    expect(port.store.get('m')!.manager!.task.turns).toBe(1)
  })
})

describe("the manager answering its workers' requests", () => {
  beforeEach(async () => {
    manager({ approvals: 'low', autoReview: false })
    await hub.startWorker('m', { worker: '杂活', task: 'a', acceptance: [], files: [] })
    port.pendings.set('s1', [
      { requestId: 'r1', what: '运行 pnpm test', level: 'low' },
      { requestId: 'r2', what: '运行 pnpm add x', level: 'medium' },
    ])
  })

  it('wakes the manager for a low request and lets it answer that one only', async () => {
    hub.requested('s1', 'r1', 'low', '运行 pnpm test')
    hub.requested('s1', 'r2', 'medium', '运行 pnpm add x')
    await flush()
    expect(port.wakes).toHaveLength(1)
    expect(port.wakes[0]!.digest[0]).toMatchObject({ status: 'asks', request: { id: 'r1' } })
    expect(hub.answer('m', 's1', 'r1', true)).toBe('Allowed once.')
    expect(port.answered).toEqual([{ id: 's1', requestId: 'r1', allow: true }])
    expect(() => hub.answer('m', 's1', 'r2', false)).toThrow(/only the user/)
    expect(port.store.get('m')!.manager!.answers).toMatchObject([
      { workerId: 's1', name: '杂活', what: '运行 pnpm test', allowed: true },
    ])
    expect(port.notices).toEqual([expect.stringContaining('manager.answered.allowed')])
  })

  it("refuses to answer when the user answers this session's requests", () => {
    port.store.get('m')!.manager!.approvals = 'user'
    expect(() => hub.answer('m', 's1', 'r1', true)).toThrow(/user answers/)
    expect(port.answered).toEqual([])
  })

  it('takes the stricter risk at answer time', () => {
    port.pendings.set('s1', [{ requestId: 'r1', what: '运行 pnpm test', level: 'high' }])
    expect(() => hub.answer('m', 's1', 'r1', true)).toThrow(/rates this request high/)
  })
})

describe('after a restart', () => {
  it('resumes owed workers up to the slots and holds the rest until one settles', async () => {
    port.settingsValue.limits = { ...port.settingsValue.limits, concurrent: 1 }
    manager({ autoReview: false })
    for (const id of ['s1', 's2']) {
      port.store.set(id, {
        ...base(id),
        parentId: 'm',
        startedBy: 'm',
        worker: {
          managerId: 'm',
          workerId: planner.id,
          name: '规划',
          role: 'plan',
          kind: 'plan',
          title: 't',
          tokens: 0,
          cost: 0,
          owed: 5,
        },
      })
    }
    hub.load()
    hub.recover()
    await flush()
    expect(port.sent.map((item) => item.id)).toEqual(['s1'])
    expect(port.sent[0]!.text).toContain('Kite 重启了')
    await finish('s1', { status: 'done', summary: 'ok', changed: [], findings: [] })
    expect(port.sent.map((item) => item.id)).toEqual(['s1', 's2'])
  })

  it('tells the manager instead when set so', async () => {
    port.settingsValue.afterRestart = 'tell'
    manager()
    port.store.set('s1', {
      ...base('s1'),
      parentId: 'm',
      worker: {
        managerId: 'm',
        workerId: helper.id,
        name: '杂活',
        role: 'other',
        kind: 'other',
        title: 't',
        tokens: 0,
        cost: 0,
        owed: 5,
      },
    })
    hub.load()
    hub.recover()
    await flush()
    expect(port.sent).toHaveLength(0)
    expect(port.wakes[0]!.digest[0]).toMatchObject({ sessionId: 's1', status: 'interrupted' })
  })
})

describe('the blocks ahead of a prompt', () => {
  it('gives the manager its block once per agent session, and again once it changed', () => {
    manager()
    const first = hub.aheadFor('m', 'acp-1')!
    expect(first.text).toContain('你现在是「总管」')
    expect(first.text).toContain('写手（写代码）：codex · gpt-5.5')
    hub.markSent('m', first.mark)
    expect(hub.aheadFor('m', 'acp-1')).toBeNull()
    expect(hub.aheadFor('m', 'acp-2')).not.toBeNull()
    port.settingsValue.workers = [writer]
    expect(hub.aheadFor('m', 'acp-1')).not.toBeNull()
  })

  it('gives a worker its persona, and a reader that it only reads', async () => {
    manager()
    await hub.startWorker('m', { worker: '规划', task: 't', acceptance: [], files: [] })
    const block = hub.aheadFor('s1', 'acp-s1')!.text
    expect(block).toContain('你是「规划」（规划调研）')
    expect(block).toContain('你是严格的审阅者。')
    expect(block).toContain('你只读，不改文件')
    expect(hub.readOnly('s1')).toBe('worker')
    expect(hub.readOnly('m')).toBe('manager')
  })
})

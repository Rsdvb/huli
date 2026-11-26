import { afterEach, expect, it, vi } from 'vitest'
import { reportedTurns, type ThreadEntry } from '@shared/thread'
import { FakeAppServer, FakeRpcError, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

// A host starts and runs two sessions; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>

const isReport = (entry: ThreadEntry): entry is UserEntry =>
  entry.kind === 'user' && entry.from?.ended !== undefined

/** Allows the permission card a session's turn is held on, which lets the turn end. */
async function allow(window: TestPort, sessionId: string): Promise<void> {
  await window.untilStatus(sessionId, 'awaiting_permission')
  const held = window
    .entries(sessionId)
    .find((entry) => entry.kind === 'tool' && entry.permission !== null)
  if (held?.kind !== 'tool' || !held.permission) throw new Error('No permission card')
  await window.request('permissions.respond', {
    sessionId,
    requestId: held.permission.requestId,
    optionId: 'allow-once',
  })
}

/** A caller held on a permission card, so a report from a session it starts waits in its queue. */
async function busyCaller(): Promise<{ host: TestHost; window: TestPort; callerId: string }> {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: callerId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(callerId)
  await window.untilStatus(callerId, 'ready')
  await window.request('sessions.prompt', {
    sessionId: callerId,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.untilStatus(callerId, 'awaiting_permission')
  return { host, window, callerId }
}

it('drops a queued report once the caller archives the session it reports on', async () => {
  const { host, window, callerId } = await busyCaller()
  const startedId = await host.host.sessions.startFromTool(callerId, {
    prompt: 'Check the login page.',
    options: {},
    report: true,
  })
  await window.until(() => window.thread(callerId).session.queue.some((item) => item.from?.ended))

  await host.host.sessions.archiveStarted(startedId, 'Fake Agent')
  await window.until(() => window.thread(callerId).session.queue.length === 0)

  await allow(window, callerId)
  await window.untilEntry(callerId, (entry) => entry.kind === 'turn_end')
  await window.untilStatus(callerId, 'ready')
  expect(window.entries(callerId).filter(isReport)).toEqual([])
  expect(window.thread(callerId).session.queue).toEqual([])
})

it('still reports a turn whose session archives itself when it ends', async () => {
  const { host, window, callerId } = await busyCaller()
  const startedId = await host.host.sessions.startFromTool(callerId, {
    prompt: '/permission',
    options: {},
    report: true,
  })
  await window.open(startedId)
  await window.untilStatus(startedId, 'awaiting_permission')
  host.host.sessions.archiveWhenIdle(startedId, 'Fake Agent')
  await allow(window, startedId)
  await window.until(() => window.thread(callerId).session.queue.some((item) => item.from?.ended))

  await allow(window, callerId)
  await window.untilEntry(callerId, isReport)
})

/** Starts a session of the caller's that reports back, as start_session does. */
function startChild(host: TestHost, callerId: string, prompt = 'Check the tests'): Promise<string> {
  return host.host.sessions.startFromTool(callerId, {
    prompt,
    agentId: 'fake-agent',
    options: {},
    report: true,
  })
}

/** A fake agent session whose turn runs on until it is stopped. */
async function workingCaller(env?: Record<string, string>) {
  const host = await startTestHost(env ? { agentEnv: env } : {})
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/cancel' }],
  })
  // At the agent, as a long turn is by the time a session it started ends one.
  await window.untilEntry(
    id,
    (entry) => entry.kind === 'agent' && entry.markdown.startsWith('Working on step'),
  )
  return { host, window, id }
}

const PROMPT = 'ask me something'

/** A Codex session with a turn that runs. */
async function runningCodex() {
  const server = new FakeAppServer()
  const started: { threadId?: string; turnId?: string } = {}
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    if (input[0]?.text === PROMPT) Object.assign(started, { threadId: params.threadId, turnId })
    return { turn: turn(turnId) }
  })
  const host = await startTestHost({ fakeAppServer: server })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  void window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: PROMPT }],
  })
  await server.until(() => started.turnId !== undefined)
  return { server, host, window, id, started }
}

const steeredTexts = (server: FakeAppServer) =>
  server.sent('turn/steer').map((params) => (params.input as { text: string }[])[0]!.text)

function queueOf(window: TestPort, id: string) {
  return window.thread(id).session.queue
}

it('steers a report into the running turn at once, as a report and not the user’s message', async () => {
  const { host, window, id } = await workingCaller()
  const childId = await startChild(host, id)

  await window.untilEntry(id, isReport)
  const report = window.entries(id).find(isReport)!
  expect(report).toMatchObject({
    steered: true,
    from: { sessionId: childId, ended: { stopReason: 'end_turn' } },
  })
  expect(report.content).toEqual([
    {
      type: 'text',
      text:
        `Kettu: the turn you asked the Fake agent session ${childId} for has ended. ` +
        'Read its reply with get_session.',
    },
  ])
  // The agent read it in the turn it is in, which runs on.
  await window.untilEntry(
    id,
    (entry) => entry.kind === 'agent' && entry.markdown.startsWith('Noted mid-turn: Kettu:'),
  )
  expect(queueOf(window, id)).toEqual([])
  expect(window.summary(id)?.status).toBe('running')
})

it('queues a report for an agent that cannot steer, and joins the reports that wait', async () => {
  const { host, window, id } = await workingCaller({ FAKE_AGENT_WITHOUT: 'steering' })
  const first = await startChild(host, id, 'Check the tests')
  await window.until(() => queueOf(window, id).length === 1)
  const second = await startChild(host, id, 'Check the docs')
  await window.until(() => reportedTurns(queueOf(window, id)[0]?.from).length === 2)

  const queue = queueOf(window, id)
  expect(queue).toHaveLength(1)
  expect(reportedTurns(queue[0]!.from).map((t) => [t.sessionId, t.stopReason])).toEqual([
    [first, 'end_turn'],
    [second, 'end_turn'],
  ])
  const text = queue[0]!.content[0]!.type === 'text' ? queue[0]!.content[0]!.text : ''
  expect(text.split('\n')).toEqual([
    `Kettu: the turn you asked the Fake agent session ${first} for has ended. Read its reply with get_session.`,
    `Kettu: the turn you asked the Fake agent session ${second} for has ended. Read its reply with get_session.`,
  ])
  expect(window.entries(id).some(isReport)).toBe(false)

  // Archiving one of the sessions takes its turn out of the report, which goes on with the other.
  await host.host.sessions.archiveStarted(first, 'Fake agent')
  await window.until(() => reportedTurns(queueOf(window, id)[0]?.from).length === 1)
  const [left] = queueOf(window, id)
  expect(left!.from).toEqual({
    sessionId: second,
    title: 'Check the docs',
    ended: { agent: 'Fake agent', stopReason: 'end_turn' },
  })
  expect(left!.content).toEqual([
    {
      type: 'text',
      text: `Kettu: the turn you asked the Fake agent session ${second} for has ended. Read its reply with get_session.`,
    },
  ])
})

it('keeps a report where it waits when the turn was ending', async () => {
  const { server, host, window, id } = await runningCodex()
  server.on('turn/steer', () => {
    throw new FakeRpcError(-32600, 'no active turn to steer')
  })
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Then the docs' }],
  })
  const childId = await startChild(host, id)

  await server.until(() => server.sent('turn/steer').length === 1)
  await window.until(() => queueOf(window, id).length === 2)
  const queue = queueOf(window, id)
  // Behind the user's own message, which goes first, as before the steering was tried.
  expect(queue[0]!.from).toBeUndefined()
  expect(queue[1]!.from).toMatchObject({ sessionId: childId, ended: { stopReason: 'end_turn' } })
  expect(steeredTexts(server)[0]).toContain(`session ${childId} for has ended`)
})

it('skips no question for a report: it waits, and goes into the turn once answered', async () => {
  const { server, host, window, id, started } = await runningCodex()
  const asked = server.request('item/tool/requestUserInput', {
    ...started,
    itemId: 'ask-1',
    questions: [
      {
        id: 'q',
        header: 'Indent',
        question: 'Tabs or spaces?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Tabs', description: '' },
          { label: 'Spaces', description: '' },
        ],
      },
    ],
  })
  await window.untilStatus(id, 'awaiting_permission')
  let answered: unknown = null
  void asked.answer.then((answer) => (answered = answer))
  const childId = await startChild(host, id)

  await window.until(() => queueOf(window, id).length === 1)
  expect(queueOf(window, id)[0]!.from).toMatchObject({ sessionId: childId })
  expect(server.sent('turn/steer')).toHaveLength(0)
  expect(answered).toBeNull()
  const ask = window.entries(id).find((entry) => entry.kind === 'tool' && entry.permission)
  expect(ask).toMatchObject({ permission: { questions: [{ question: 'Tabs or spaces?' }] } })

  const requestId = ask?.kind === 'tool' ? ask.permission!.requestId : ''
  await window.request('permissions.respond', {
    sessionId: id,
    requestId,
    answers: [{ question: 0, choices: [1] }],
  })
  await server.until(() => server.sent('turn/steer').length === 1)
  expect(steeredTexts(server)[0]).toContain(`session ${childId} for has ended`)
  expect(await asked.answer).not.toEqual({ answers: {} })
  await window.until(() => queueOf(window, id).length === 0)
  await window.untilEntry(id, isReport)
  expect(window.entries(id).find(isReport)).toMatchObject({ steered: true })
})

it('pauses reports at the limit the settings set, and says so once', async () => {
  const host = await startTestHost({ startedSessions: { working: 3, daily: 10, reports: 1 } })
  hosts.push(host)
  const window = host.connect()
  const { id: callerId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(callerId)
  await window.untilStatus(callerId, 'ready')

  await host.host.sessions.startFromTool(callerId, { prompt: 'One.', options: {}, report: true })
  await window.untilEntry(callerId, isReport)
  await window.untilEntry(callerId, (entry) => entry.kind === 'turn_end')
  await window.untilStatus(callerId, 'ready')

  await host.host.sessions.startFromTool(callerId, { prompt: 'Two.', options: {}, report: true })
  await window.untilEntry(
    callerId,
    (entry) => entry.kind === 'notice' && entry.cause === 'reports_paused',
  )
  const notices = window
    .entries(callerId)
    .filter((entry) => entry.kind === 'notice' && entry.cause === 'reports_paused')
  expect(notices).toHaveLength(1)
  expect(window.entries(callerId).filter(isReport)).toHaveLength(1)
  expect(window.thread(callerId).session.queue).toEqual([])
})

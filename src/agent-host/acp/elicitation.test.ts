// Elicitations an ACP agent sends in a session: agy 1.5.12's `ask_question`, recorded, as the
// questions card and back, and any agent's form or page as a card, with what is declined.

import {
  agent,
  methods,
  type AgentContext,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
  type ToolEntry,
} from '@shared/thread'
import type {
  ConnectionHooks,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'
import { agyAnswer, agyQuestions } from './elicitation'
import recorded from './fixtures/agy-ask.json'

type Scripted = (client: AgentContext, sessionId: string) => Promise<void>

/** An agent whose turn runs `turn`; `agentId` makes it agy. */
function connect(turn: Scripted, agentId?: 'antigravity') {
  const capabilities: { value: ClientCapabilities } = { value: {} }
  const app = agent({ name: 'elicitation-test' })
    .onRequest(methods.agent.initialize, (ctx) => {
      capabilities.value = ctx.params.clientCapabilities ?? {}
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
        authMethods: [],
      }
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      await turn(ctx.client, ctx.params.sessionId)
      return { stopReason: 'end_turn' }
    })
  const ignored: string[] = []
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: (_, what) => ignored.push(what),
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    ...(agentId ? { agentId } : {}),
    name: 'Test Agent',
  })
  return { connection, capabilities, ignored }
}

/** A session's thread whose requests get `answer`, recording each request. */
function threadTarget(answer: (request: PermissionRequest) => PermissionAnswer | Promise<never>) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'antigravity',
      projectPath: '/tmp/ask',
      acpSessionId: 's-1',
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
  let n = 0
  const scope = newTurnScope()
  const requests: PermissionRequest[] = []
  const shown: ThreadEntry[] = []
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async (request) => {
      requests.push(request)
      target.apply(request.output)
      const entry = thread.byId[request.toolEntryId]
      if (entry) shown.push(entry)
      return answer(request)
    },
    send: () => {},
    startMode: () => null,
  }
  return { target, requests, shown, entries: (): ThreadEntry[] => threadEntries(thread) }
}

const notify = (client: AgentContext, sessionId: string, value: unknown) =>
  client.notify(methods.client.session.update, { sessionId, update: value as SessionUpdate })

const elicit = (client: AgentContext, params: Record<string, unknown>) =>
  client.request(methods.client.elicitation.create, params as unknown as CreateElicitationRequest)

/** Runs agy's recorded ask, answered with `answer`, and returns what agy got back. */
async function askAgy(
  ask: { before: unknown[]; elicitation: Record<string, unknown>; after: unknown[] },
  answer: (request: PermissionRequest) => PermissionAnswer | Promise<never>,
) {
  let response: CreateElicitationResponse | null = null
  const { connection } = connect(async (client, sessionId) => {
    for (const value of ask.before) await notify(client, sessionId, value)
    response = await elicit(client, { sessionId, ...ask.elicitation })
    for (const value of ask.after) await notify(client, sessionId, value)
  }, 'antigravity')
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/ask')
  const thread = threadTarget(answer)
  connection.register(sessionId, thread.target)
  await connection.prompt(sessionId, [{ type: 'text', text: 'ask me' }])
  connection.close()
  return { ...thread, response: response as CreateElicitationResponse | null }
}

describe("agy's ask_question", () => {
  it('reads its form as questions, single and multi-select, with own words', () => {
    expect(agyQuestions(recorded.single.elicitation.requestedSchema)).toEqual({
      questions: [
        {
          header: '',
          question: 'Pick a color',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }],
          allowsText: true,
          secret: false,
        },
      ],
      fields: [{ key: 'q1', multiSelect: false, values: ['1', '2'], textKey: 'q1_other' }],
    })
    expect(agyQuestions(recorded.multi.elicitation.requestedSchema)?.fields).toEqual([
      { key: 'q1', multiSelect: true, values: ['1', '2', '3'], textKey: 'q1_other' },
    ])
  })

  it('reads no questions from a form of another shape', () => {
    const schema = recorded.single.elicitation.requestedSchema
    const props = schema.properties
    expect(agyQuestions({ ...schema, properties: { ...props, extra: { type: 'string' } } })).toBe(
      null,
    )
    expect(agyQuestions({ ...schema, properties: { q1_other: props.q1_other } })).toBe(null)
    expect(agyQuestions({ ...schema, properties: { q1: { ...props.q1, title: ' ' } } })).toBe(null)
    expect(
      agyQuestions({
        ...schema,
        properties: { q1: { ...props.q1, oneOf: [props.q1.oneOf[0], props.q1.oneOf[0]] } },
      }),
    ).toBe(null)
    expect(agyQuestions({ type: 'object', properties: {} })).toBe(null)
    expect(agyQuestions(null)).toBe(null)
  })

  it('shows the questions on the call that asks them and sends the answer', async () => {
    const { requests, shown, entries, response } = await askAgy(recorded.single, () => ({
      answers: [{ question: 0, choices: [1] }],
    }))
    expect(response).toEqual({ action: 'accept', content: { q1: '2' } })
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request!.toolEntryId).toBe('t:call_14246997105528906331')
    expect(request!.questions?.map((q) => q.question)).toEqual(['Pick a color'])
    expect(request!.options.map((option) => option.id)).toEqual(['answer:0', 'answer:1', 'other'])
    expect(shown[0]).toMatchObject({ title: 'Pick a color', question: 'Pick a color' })
    // One row, the question's, which agy then completes.
    const rows = entries().filter((entry): entry is ToolEntry => entry.kind === 'tool')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: 'Pick a color',
      question: 'Pick a color',
      status: 'completed',
    })
  })

  it("sends a multi-select's choices and own words, in the agent's order", async () => {
    const { response } = await askAgy(recorded.multi, () => ({
      answers: [{ question: 0, choices: [2, 0], text: ' Kiwi ' }],
    }))
    expect(response).toEqual({ action: 'accept', content: { q1: ['1', '3'], q1_other: 'Kiwi' } })
  })

  it('declines a skipped ask or Something else, and cancels a cancelled or withdrawn one', async () => {
    expect((await askAgy(recorded.single, () => ({ answers: [] }))).response).toEqual({
      action: 'decline',
    })
    expect((await askAgy(recorded.single, () => ({ optionId: 'other' }))).response).toEqual({
      action: 'decline',
    })
    expect((await askAgy(recorded.single, () => 'cancelled')).response).toEqual({
      action: 'cancel',
    })
    const withdrawn = await askAgy(recorded.single, () => Promise.reject(new Error('withdrawn')))
    expect(withdrawn.response).toEqual({ action: 'cancel' })
  })

  it("answers the first question from an option, for a client without the card's questions", async () => {
    const { response } = await askAgy(recorded.multi, () => ({ optionId: 'answer:1' }))
    expect(response).toEqual({ action: 'accept', content: { q1: ['2'] } })
  })

  it('sends only the questions answered, and own words only where a question takes them', () => {
    const fields = [
      { key: 'q1', multiSelect: false, values: ['1', '2'], textKey: null },
      { key: 'q2', multiSelect: false, values: ['1', '2', '3'], textKey: 'q2_other' },
    ]
    expect(agyAnswer(fields, { answers: [{ question: 1, choices: [], text: 'mine' }] })).toEqual({
      action: 'accept',
      content: { q2_other: 'mine' },
    })
    expect(
      agyAnswer(fields, { answers: [{ question: 0, choices: [0], text: 'dropped' }] }),
    ).toEqual({ action: 'accept', content: { q1: '1' } })
    expect(agyAnswer(fields, { optionId: 'answer:9' })).toEqual({ action: 'decline' })
    expect(agyAnswer(fields, { values: { q1: '1' } })).toEqual({ action: 'cancel' })
  })

  it("shows another agent's form of that shape as a form, not as questions", async () => {
    let response: CreateElicitationResponse | null = null
    const { connection } = connect(async (client, sessionId) => {
      response = await elicit(client, { sessionId, ...recorded.single.elicitation })
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/ask')
    const { target, requests } = threadTarget(() => ({ values: { q1: '1' } }))
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    connection.close()
    expect(requests[0]?.questions).toBeUndefined()
    expect(requests[0]?.elicitation?.kind).toBe('form')
    expect(response).toEqual({ action: 'accept', content: { q1: '1' } })
  })
})

const FORM = {
  mode: 'form',
  message: 'Which region should the deploy use?',
  requestedSchema: {
    type: 'object',
    properties: {
      region: { type: 'string', title: 'Region', enum: ['eu', 'us'] },
      replicas: { type: 'integer', title: 'Replicas', minimum: 1 },
    },
    required: ['region'],
  },
}

/** Runs a turn that sends `params` once for the session, answered with `answer`. */
async function formTurn(
  params: Record<string, unknown>,
  answer: (request: PermissionRequest) => PermissionAnswer | Promise<never>,
  scope: 'session' | 'other-session' | 'request' = 'session',
) {
  let response: CreateElicitationResponse | null = null
  const { connection, ignored } = connect(async (client, sessionId) => {
    const scoped =
      scope === 'session'
        ? { sessionId }
        : scope === 'other-session'
          ? { sessionId: 'nobody' }
          : { requestId: 'r-1' }
    response = await elicit(client, { ...scoped, ...params })
  })
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/ask')
  const thread = threadTarget(answer)
  connection.register(sessionId, thread.target)
  await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
  connection.close()
  return { ...thread, ignored, response: response as CreateElicitationResponse | null }
}

describe("a session's form and page elicitations", () => {
  it('declares form and URL elicitation', async () => {
    const { connection, capabilities } = connect(async () => {})
    await connection.initialize('1.0.0')
    connection.close()
    expect(capabilities.value.elicitation).toEqual({ form: {}, url: {} })
  })

  it('shows a form as a card of its fields and sends its values', async () => {
    const { requests, shown, entries, response } = await formTurn(FORM, () => ({
      values: { region: 'eu', replicas: 2 },
    }))
    expect(response).toEqual({ action: 'accept', content: { region: 'eu', replicas: 2 } })
    expect(requests[0]?.elicitation).toEqual({
      kind: 'form',
      server: 'Test Agent',
      message: 'Which region should the deploy use?',
      fields: [
        {
          key: 'region',
          title: 'Region',
          required: true,
          type: 'choice',
          choices: [
            { value: 'eu', label: 'eu' },
            { value: 'us', label: 'us' },
          ],
        },
        {
          key: 'replicas',
          title: 'Replicas',
          required: false,
          type: 'number',
          integer: true,
          minimum: 1,
        },
      ],
    })
    expect(requests[0]?.options.map((option) => [option.id, option.kind])).toEqual([
      ['accept', 'allow_once'],
      ['decline', 'reject_once'],
    ])
    expect(shown[0]).toMatchObject({
      kind: 'tool',
      title: 'Test Agent needs some details',
      elicitation: { server: 'Test Agent', kind: 'form' },
      content: [{ type: 'markdown', markdown: 'Which region should the deploy use?' }],
    })
    expect(entries().at(-1)).toMatchObject({ kind: 'tool', status: 'completed' })
  })

  it('declines on Decline, and cancels when cancelled or withdrawn', async () => {
    expect((await formTurn(FORM, () => ({ optionId: 'decline' }))).response).toEqual({
      action: 'decline',
    })
    const cancelled = await formTurn(FORM, () => 'cancelled')
    expect(cancelled.response).toEqual({ action: 'cancel' })
    expect(cancelled.entries().at(-1)).toMatchObject({ kind: 'tool', status: 'cancelled' })
    const withdrawn = await formTurn(FORM, () => Promise.reject(new Error('withdrawn')))
    expect(withdrawn.response).toEqual({ action: 'cancel' })
  })

  it('declines, without asking, a form no card can show or one outside a known session', async () => {
    const nested = {
      ...FORM,
      requestedSchema: { type: 'object', properties: { deep: { type: 'object' } } },
    }
    const never = () => {
      throw new Error('asked the user')
    }
    for (const [params, scope] of [
      [nested, 'session'],
      [
        { ...FORM, requestedSchema: { properties: { when: { type: 'string', enum: [] } } } },
        'session',
      ],
      [FORM, 'other-session'],
      [FORM, 'request'],
      [{ ...FORM, mode: '_custom' }, 'session'],
    ] as const) {
      const { requests, response, ignored } = await formTurn(params, never, scope)
      expect(response, JSON.stringify(params)).toEqual({ action: 'decline' })
      expect(requests).toEqual([])
      expect(ignored.some((what) => what.startsWith('elicitation/create'))).toBe(true)
    }
  })

  it('offers a web page to open, keeps it open until the agent says it is done', async () => {
    let done: (() => Promise<void>) | null = null
    let response: CreateElicitationResponse | null = null
    const { connection } = connect(async (client, sessionId) => {
      response = await elicit(client, {
        sessionId,
        mode: 'url',
        elicitationId: 'el-1',
        message: 'Authorize the GitHub server.',
        url: 'https://github.com/login/oauth/authorize?client_id=x',
      })
      done = () => client.notify(methods.client.elicitation.complete, { elicitationId: 'el-1' })
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/ask')
    const { target, requests, entries } = threadTarget(() => ({ optionId: 'accept' }))
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    expect(response).toEqual({ action: 'accept' })
    expect(requests[0]?.elicitation).toEqual({
      kind: 'url',
      server: 'Test Agent',
      message: 'Authorize the GitHub server.',
      url: 'https://github.com/login/oauth/authorize?client_id=x',
    })
    expect(entries().at(-1)).toMatchObject({
      status: 'in_progress',
      elicitation: { kind: 'url', url: 'https://github.com/login/oauth/authorize?client_id=x' },
    })
    await done!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entries().at(-1)).toMatchObject({ status: 'completed' })
    connection.close()
  })

  it('declines a page that is no web address', async () => {
    const never = () => {
      throw new Error('asked the user')
    }
    const page = { mode: 'url', elicitationId: 'el-2', message: 'Open', url: 'file:///etc/passwd' }
    expect((await formTurn(page, never)).response).toEqual({ action: 'decline' })
  })
})

// Elicitations an ACP agent sends in a session: a form or a page as a card, and what is declined.

import {
  agent,
  methods,
  type AgentContext,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type {
  ConnectionHooks,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'

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

const elicit = (client: AgentContext, params: Record<string, unknown>) =>
  client.request(methods.client.elicitation.create, params as unknown as CreateElicitationRequest)

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

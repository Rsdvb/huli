// agy 1.5.12's subagents, recorded: its `invoke_subagent` call, and what it wrote of the subagent
// in its brain folder, as the subagent session Kettu shows.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  agent,
  methods,
  type AgentContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { ConnectionHooks, SessionTarget } from '../connection'
import { newTurnScope, type MapperEffect } from '../session-updates'
import {
  fileBrain,
  parseStep,
  subagentSessionId,
  subagentTitle,
  type AgyBrain,
} from './agy-subagents'
import { AcpConnection, inProcessTransport } from './connection'
import recorded from './fixtures/agy-subagent.json'

const { parent, child } = recorded
const CALL_ID = recorded.updates[0]!.toolCallId
const CHILD_SESSION = subagentSessionId(CALL_ID)

type SubagentEffect = Extract<MapperEffect, { kind: 'subagent' }>

/** A thread for a session, applying what it is given. */
function thread(id: string, acpSessionId: string, ids: Record<string, string>) {
  let state: ThreadState = threadFromSnapshot({
    session: {
      id,
      agentId: 'antigravity',
      projectPath: '/tmp/agy-probe',
      acpSessionId,
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
  const effects: MapperEffect[] = []
  const target: SessionTarget = {
    context: () => ({
      thread: state,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: (acpId) => ids[acpId] ?? null,
    }),
    apply: (output) => {
      state = applyPatches(state, output.patches)
      effects.push(...output.effects)
    },
    requestPermission: async () => 'cancelled',
    send: () => {},
    startMode: () => null,
  }
  return { target, effects, entries: (): ThreadEntry[] => threadEntries(state) }
}

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(done()).toBe(true)
}

/**
 * The recorded call in a turn of agy, its brain folder `brain`, and the parent's thread, which
 * holds a subagent session as the host does: registered under the id its first effect names.
 */
async function run(brain: AgyBrain, updates: unknown[] = recorded.updates) {
  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: parent }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      for (const value of updates) {
        await (ctx.client as AgentContext).notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: value as SessionUpdate,
        })
      }
      return { stopReason: 'end_turn' }
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'antigravity',
    agyBrain: brain,
    agyPollMs: 5,
  })
  const ids = { [parent]: 'kettu-parent' }
  const main = thread('kettu-parent', parent, ids)
  const children = new Map<string, ReturnType<typeof thread>>()
  const apply = main.target.apply
  main.target.apply = (output) => {
    apply(output)
    for (const effect of output.effects) {
      if (effect.kind !== 'subagent' || children.has(effect.sessionId)) continue
      const sub = thread(`kettu-${effect.sessionId}`, effect.sessionId, ids)
      children.set(effect.sessionId, sub)
      connection.register(effect.sessionId, sub.target)
    }
  }
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/agy-probe')
  connection.register(sessionId, main.target)
  await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
  const subagentEffects = () =>
    main.effects.filter((effect): effect is SubagentEffect => effect.kind === 'subagent')
  return { connection, main, children, subagentEffects }
}

/** The recorded folder, its transcript written up to `lines` lines so far. */
function recordedBrain(written: { lines: number; killed?: boolean }): AgyBrain {
  return {
    subagents: async (id) =>
      id === parent
        ? [{ conversationId: child, role: 'Echo Tester', killed: written.killed === true }]
        : [],
    spawnedBy: async (id) =>
      id === child ? recorded.message.sourceMetadata.tool.toolCall.id : null,
    transcript: async (id, from) =>
      id === child
        ? { lines: recorded.transcript.slice(from, written.lines), next: written.lines }
        : null,
  }
}

const rows = (entries: ThreadEntry[]) =>
  entries.map((entry) => {
    switch (entry.kind) {
      case 'tool':
        return { tool: entry.title, status: entry.status, content: entry.content }
      case 'agent':
        return { agent: entry.markdown }
      case 'thought':
        return 'thought'
      case 'session_message':
        return { from: entry.senderId, content: entry.content }
      default:
        return entry.kind
    }
  })

describe("agy's subagents", () => {
  it('title a subagent by its prompt, as plain words', () => {
    expect(subagentTitle('# Echo test\nReply with pong')).toBe('Echo test')
    expect(subagentTitle('\n\n你负责完成全部 **14 张吊筒（diaotong）** 图片的标注。')).toBe(
      '你负责完成全部 14 张吊筒（diaotong） 图片的标注。',
    )
    expect(subagentTitle('x'.repeat(90))).toBe(`${'x'.repeat(80)}…`)
    expect(subagentTitle('  \n ')).toBe(null)
  })

  it("read agy's steps, its calls' arguments as the values they are written as", () => {
    const step = parseStep(recorded.transcript[1]!)
    expect(step).toMatchObject({
      index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-high',
      calls: [{ name: 'send_message', args: { Message: 'pong', Recipient: parent } }],
    })
    expect(parseStep('not json')).toBe(null)
    expect(parseStep('{"type":"GENERIC"}')).toBe(null)
  })

  it('show the call as the subagent session, its prompt, then its work from the transcript', async () => {
    const written = { lines: 2 }
    const { connection, main, children, subagentEffects } = await run(recordedBrain(written))
    // No row for the call: its card stands in the parent's thread instead.
    expect(main.entries()).toEqual([])
    expect(subagentEffects()[0]).toEqual({
      kind: 'subagent',
      sessionId: CHILD_SESSION,
      title: 'Echo test',
      description: 'Echo Tester',
      canCancel: false,
      state: { kind: 'running' },
    })
    const sub = children.get(CHILD_SESSION)!
    await until(() => sub.entries().some((entry) => entry.kind === 'tool'))
    expect(rows(sub.entries())).toEqual([
      {
        from: 'kettu-parent',
        content: [
          {
            type: 'text',
            text: '# Echo test\nReply with the single word pong and nothing else. Use no tools.',
          },
        ],
      },
      'thought',
      {
        tool: 'Message the main agent',
        status: 'in_progress',
        content: [{ type: 'markdown', markdown: 'pong' }],
      },
    ])

    written.lines = recorded.transcript.length
    await until(() => subagentEffects().some((effect) => effect.state?.kind === 'idle'))
    expect(rows(sub.entries()).slice(2)).toEqual([
      {
        tool: 'Message the main agent',
        status: 'completed',
        content: [
          {
            type: 'markdown',
            markdown: 'Message sent to "6f67d676-9184-4f6a-a4b8-f67fee282d19".',
          },
        ],
      },
      { agent: 'pong' },
    ])
    // The card names the model once a step does, and the subagent ends with its last step.
    expect(
      subagentEffects()
        .map((effect) => effect.description)
        .filter(Boolean),
    ).toEqual(['Echo Tester', 'Echo Tester · gemini-4-neon-high'])
    expect(subagentEffects().at(-1)?.state).toEqual({
      kind: 'idle',
      stopReason: 'end_turn',
      error: null,
      tokens: null,
    })
    connection.close()
  })

  it('end a subagent agy killed as cancelled', async () => {
    const { connection, subagentEffects } = await run(recordedBrain({ lines: 2, killed: true }))
    await until(() => subagentEffects().some((effect) => effect.state?.kind === 'idle'))
    expect(subagentEffects().at(-1)?.state).toMatchObject({ kind: 'idle', stopReason: 'cancelled' })
    connection.close()
  })

  it('keep only the prompt, ending with the call, when the folder has nothing of it', async () => {
    const empty: AgyBrain = {
      subagents: async () => [],
      spawnedBy: async () => null,
      transcript: async () => null,
    }
    const { connection, children, subagentEffects } = await run(empty)
    await until(() => subagentEffects().some((effect) => effect.state?.kind === 'idle'))
    expect(subagentEffects().at(-1)?.state).toEqual({
      kind: 'idle',
      stopReason: 'end_turn',
      error: null,
      tokens: null,
    })
    expect(rows(children.get(CHILD_SESSION)!.entries())).toEqual([
      expect.objectContaining({ from: 'kettu-parent' }),
    ])
    connection.close()
  })

  it('fail the subagent whose call failed', async () => {
    const [started] = recorded.updates
    const failed = { ...started, sessionUpdate: 'tool_call_update', status: 'failed' }
    const { connection, subagentEffects } = await run(recordedBrain({ lines: 0 }), [
      started,
      failed,
    ])
    expect(subagentEffects().map((effect) => effect.state)).toEqual([
      { kind: 'running' },
      expect.objectContaining({ kind: 'idle', error: { message: 'Run invoke_subagent' } }),
    ])
    connection.close()
  })
})

describe("agy's brain folder", () => {
  let home: string | null = null
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
    home = null
  })

  async function folder(): Promise<string> {
    home = await mkdtemp(path.join(tmpdir(), 'agy-brain-'))
    const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain')
    const own = (id: string, ...parts: string[]) =>
      path.join(brain, id, '.system_generated', ...parts)
    await mkdir(own(parent, 'subagents'), { recursive: true })
    await mkdir(own(child, 'messages'), { recursive: true })
    await mkdir(own(child, 'logs'), { recursive: true })
    await writeFile(own(parent, 'subagents', `${child}.json`), JSON.stringify(recorded.subagent))
    await writeFile(
      own(child, 'messages', `${recorded.message.id}.json`),
      JSON.stringify(recorded.message),
    )
    await writeFile(own(child, 'messages', 'read.json'), '{}')
    // The last line is still being written.
    const [a, b] = recorded.transcript
    await writeFile(own(child, 'logs', 'transcript.jsonl'), `${a}\n${b}\n{"step_index":2,`)
    return home
  }

  it("names a conversation's subagents, the call that started one and its transcript so far", async () => {
    const brain = fileBrain(await folder())
    expect(await brain.subagents(parent)).toEqual([
      { conversationId: child, role: 'Echo Tester', killed: false },
    ])
    expect(await brain.spawnedBy(child)).toBe(CALL_ID)
    const read = await brain.transcript(child, 0)
    expect(read?.lines).toEqual(recorded.transcript.slice(0, 2))
    expect(await brain.transcript(child, read!.next)).toEqual({ lines: [], next: read!.next })
  })

  it('reads nothing for a conversation that is not one folder, or is not there', async () => {
    const brain = fileBrain(await folder())
    for (const id of ['..', `../${child}`, `${child}/..`, '', 'missing-conversation']) {
      expect(await brain.subagents(id)).toEqual([])
      expect(await brain.spawnedBy(id)).toBe(null)
      expect(await brain.transcript(id, 0)).toBe(null)
    }
  })
})

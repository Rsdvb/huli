// What a DeepSeek Harness session dsh made elsewhere looks like once Kettu imports it: the list
// the import dialog shows, and the thread its history replays into, subagents' included.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
  type ToolEntry,
} from '@shared/thread'
import { AgentRequestError, type SessionTarget } from '../connection'
import type { HostedContext } from '../driver'
import { newTurnScope, type MapperEffect } from '../session-updates'
import { DshConnection } from './connection'
import { fixture, IMAGE, placeImage, testHome, type TestHome } from './testing'

const TOOLS = '3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c'
const PARENT = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const CHILD = '4bc9ed73-787d-40e6-83cb-71a91ee4c8a1'
const BLANK = 'a79b301c-c384-4dc4-ae20-fc48dded7474'
const KITE = 'kettu-0123456789abcdef0123456789abcdef'
const OLDER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

let home: TestHome

beforeEach(async () => {
  home = await testHome()
})

afterEach(async () => {
  await home.remove()
})

function connect(): DshConnection {
  const context = {
    def: { id: 'deepseek' },
    hooks: { traffic() {}, account() {}, ignored() {}, log() {} },
    spec: { command: 'node', args: [], env: {}, shell: false, display: {} },
    env: { DSH_HOME: home.home },
    spawn: () => {
      throw new Error('no dsh in this test')
    },
  } as unknown as HostedContext
  return new DshConnection(context)
}

function emptyThread(id: string): ThreadState {
  return threadFromSnapshot({
    session: {
      id,
      agentId: 'deepseek',
      projectPath: home.cwd,
      acpSessionId: id,
      status: 'starting',
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
}

/** Kettu's side of a replay: each session's thread, and a target for every subagent it names. */
function host(connection: DshConnection) {
  const threads = new Map<string, ThreadState>()
  const effects = new Map<string, MapperEffect[]>()
  const open = (id: string): void => {
    threads.set(id, emptyThread(id))
    effects.set(id, [])
    let n = 0
    const scope = newTurnScope()
    const target: SessionTarget = {
      context: () => ({
        thread: threads.get(id)!,
        replaying: true,
        cancelling: false,
        scope,
        now: 0,
        nextId: () => `e:${++n}`,
        sessionIdFor: () => null,
      }),
      apply: (output) => {
        threads.set(id, applyPatches(threads.get(id)!, output.patches))
        for (const effect of output.effects) {
          effects.get(id)!.push(effect)
          // As Kettu does, a subagent's session gets a target of its own at once.
          if (effect.kind === 'subagent' && !threads.has(effect.sessionId)) open(effect.sessionId)
        }
      },
      requestPermission: () => Promise.resolve('cancelled'),
      send() {},
      startMode: () => null,
    }
    connection.register(id, target)
  }
  return {
    open,
    entries: (id: string): ThreadEntry[] => threadEntries(threads.get(id)!),
    effects: (id: string): MapperEffect[] => effects.get(id) ?? [],
    has: (id: string): boolean => threads.has(id),
  }
}

async function load(id: string, cwd = home.cwd) {
  const connection = connect()
  const kettu = host(connection)
  kettu.open(id)
  const setup = await connection.loadSession(id, cwd)
  connection.close()
  return { ...kettu, setup }
}

const tools = (entries: ThreadEntry[]): ToolEntry[] =>
  entries.filter((entry): entry is ToolEntry => entry.kind === 'tool')

const said = (entries: ThreadEntry[], kind: 'user' | 'agent'): string[] =>
  entries.flatMap((entry) =>
    entry.kind === 'user' && kind === 'user'
      ? [entry.content.map((item) => (item.type === 'text' ? item.text : '')).join('')]
      : entry.kind === 'agent' && kind === 'agent'
        ? [entry.markdown]
        : [],
  )

describe('dsh import list', () => {
  it("lists a folder's sessions with a turn, and every folder's with their kinds", async () => {
    for (const name of ['tools.v4', 'blank.v4', 'subagent-parent.v4', 'subagent-child.v4'] as const)
      await home.place(fixture(name))
    const connection = connect()
    const listed = await connection.listSessions(home.cwd, null)
    expect(listed.nextCursor).toBeNull()
    expect(listed.sessions).toEqual([
      {
        sessionId: TOOLS,
        title: 'Hello there, just say hi',
        updatedAt: new Date(1795200768766).toISOString(),
        cwd: home.cwd,
      },
      expect.objectContaining({ sessionId: PARENT, title: 'Please delegate this to a' }),
    ])
    const everywhere = await connection.listAllSessions(null)
    expect(everywhere.sessions.map((s) => [s.sessionId, s.subagent, s.prompted])).toEqual([
      [BLANK, false, false],
      [TOOLS, false, true],
      [PARENT, false, true],
      [CHILD, true, true],
    ])
    expect(everywhere.sessions[1]!.createdAt).toBe(new Date(1795200735180).toISOString())
    connection.close()
  })

  it('offers the import once the agent says it lists and loads sessions', async () => {
    const connection = connect()
    const init = await connection.initialize()
    expect(init.capabilities).toMatchObject({
      listSessions: true,
      loadSession: true,
      resumeSession: true,
    })
    connection.close()
  })
})

describe('dsh history replay', () => {
  it("shows the user's own messages, the replies and every tool with its result", async () => {
    await home.place(fixture('tools.v4'))
    const { entries, effects } = await load(TOOLS)
    const thread = entries(TOOLS)
    // The context dsh adds to each turn is no message of the user's.
    expect(said(thread, 'user')).toEqual([
      'Hello there, just say hi',
      'Please use tools on the notes',
      'Now run a command',
      'Can you fail a tool on purpose',
      'One more after resuming',
    ])
    expect(said(thread, 'agent')).toContain('Done: the tools ran.')
    expect(thread.filter((entry) => entry.kind === 'thought').length).toBeGreaterThan(0)
    expect(thread[0]!.kind).toBe('user')
    const rows = tools(thread)
    expect(rows.map((row) => [row.toolKind, row.status])).toEqual([
      ['read', 'completed'],
      ['edit', 'completed'],
      ['edit', 'completed'],
      ['execute', 'completed'],
      ['read', 'failed'],
    ])
    const [read, write, edit, command, missing] = rows
    expect(JSON.stringify(read!.content)).toContain('hello from the demo project')
    expect(write!.content).toEqual([
      expect.objectContaining({
        type: 'diff',
        oldText: null,
        newText: 'written by the fake model\n',
      }),
    ])
    expect(edit!.content).toEqual([
      expect.objectContaining({
        type: 'diff',
        oldText: 'hello from the demo project',
        newText: 'hello, edited from the demo project',
      }),
    ])
    expect(command!.title).toBe('Write-Output hi')
    expect(JSON.stringify(command!.content)).toContain('hi')
    expect(JSON.stringify(missing!.content)).toContain('not found')
    // The to-do list is the plan, and its call no row.
    expect(thread.find((entry) => entry.kind === 'plan')).toMatchObject({
      items: [
        { content: 'Read the notes', status: 'completed' },
        { content: 'Write a summary', status: 'in_progress' },
      ],
    })
    // Neither a job's board nor a retry, which only mattered while they ran.
    expect(effects(TOOLS).some((effect) => effect.kind === 'tasks')).toBe(false)
    expect(thread.some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it("replays a subagent into its own session, which its parent's row opens", async () => {
    await home.place(fixture('subagent-parent.v4'))
    await home.place(fixture('subagent-child.v4'))
    const kettu = await load(PARENT)
    const parent = kettu.entries(PARENT)
    expect(said(parent, 'user')).toEqual(['Please delegate this to a helper'])
    expect(said(parent, 'agent')).toContain('Asking a helper.')
    expect(tools(parent)).toEqual([])
    expect(kettu.effects(PARENT).filter((effect) => effect.kind === 'subagent')).toEqual([
      { kind: 'subagent', sessionId: CHILD, title: 'Check the notes', description: 'agent-1' },
      {
        kind: 'subagent',
        sessionId: CHILD,
        state: { kind: 'idle', stopReason: 'end_turn', error: null, tokens: null },
      },
    ])
    const child = kettu.entries(CHILD)
    // Live, the task its parent gave it shows as no message either.
    expect(said(child, 'user')).toEqual([])
    expect(said(child, 'agent')).toEqual(['ok from the child agent'])
  })

  it('shows no subagent dsh kept no log of', async () => {
    await home.place(fixture('subagent-parent.v4'))
    const kettu = await load(PARENT)
    expect(kettu.effects(PARENT).some((effect) => effect.kind === 'subagent')).toBe(false)
    expect(kettu.has(CHILD)).toBe(false)
  })

  it('gives a message Kettu sent its file and image back, without the guide sent ahead', async () => {
    await home.place(fixture('kite.v4'))
    await placeImage(home.home)
    const { entries, effects } = await load(KITE)
    const [prompt] = entries(KITE)
    expect(prompt).toMatchObject({
      kind: 'user',
      content: [
        { type: 'text', text: 'Summarize the attached notes' },
        {
          type: 'ref',
          ref: {
            kind: 'attachment',
            attachment: { type: 'file', name: 'notes.txt', sent: 'embedded' },
          },
        },
        {
          type: 'ref',
          ref: {
            kind: 'attachment',
            attachment: { type: 'image', mimeType: 'image/png', size: 70, sent: 'image' },
          },
        },
      ],
    })
    expect(effects(KITE)).toContainEqual(
      expect.objectContaining({ kind: 'replayImage', mimeType: 'image/png', data: IMAGE.base64 }),
    )
  })

  it('shows an image dsh no longer holds by its name alone', async () => {
    await home.place(fixture('kite.v4'))
    const { entries, effects } = await load(KITE)
    expect(JSON.stringify(entries(KITE)[0])).toContain('"type":"image"')
    expect(effects(KITE).some((effect) => effect.kind === 'replayImage')).toBe(false)
  })

  it('replays a session an older dsh saved in format 3 as one of format 4', async () => {
    await home.place(fixture('tools.v3'))
    const { entries } = await load(OLDER)
    const thread = entries(OLDER)
    expect(said(thread, 'user')).toEqual([
      'Hello from an older harness',
      'Please use tools on the notes',
      'Can you fail a tool on purpose',
    ])
    const rows = tools(thread)
    expect(rows.map((row) => row.status)).toEqual(['completed', 'completed', 'completed', 'failed'])
    expect(JSON.stringify(rows[0]!.content)).toContain('hello from the demo project')
    // Format 3 wrote an edit's path as the model gave it; the diff names the file in full.
    expect(rows[2]!.content).toEqual([
      expect.objectContaining({ type: 'diff', path: path.join(home.cwd, 'notes.txt') }),
    ])
  })

  it('ends a call the history holds no result for, as dsh stopped mid-turn', async () => {
    const rows = fixture('tools.v4').split('\n')
    const cut = rows.findIndex((row) => row.includes('"type":"tool/call"'))
    await home.place(`${rows.slice(0, cut + 1).join('\n')}\n`)
    const { entries } = await load(TOOLS)
    expect(tools(entries(TOOLS))).toEqual([expect.objectContaining({ status: 'cancelled' })])
  })

  it('goes on with the model its latest request ran on, a route the home lists', async () => {
    await mkdir(home.home, { recursive: true })
    await writeFile(
      path.join(home.home, 'cordis.patch.yml'),
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      other:',
        '        api: openai-completions',
        '        baseURL: http://127.0.0.1:9/v1',
        '        models:',
        '          - id: other-model',
        '      fake:',
        '        api: openai-completions',
        '        baseURL: http://127.0.0.1:9/v1',
        '        models:',
        '          - id: fake-model',
        '',
      ].join('\n'),
    )
    await home.place(fixture('tools.v4'))
    const { setup } = await load(TOOLS)
    // A new session would start on the first route the home lists.
    const model = setup.config.find((option) => option.id === 'model')
    expect(model?.value).toBe('fake/fake-model')
  })

  it('replays nothing for an empty session, or one dsh has no log of', async () => {
    await home.place(fixture('blank.v4'))
    const blank = await load(BLANK)
    expect(blank.entries(BLANK)).toEqual([])
    expect(blank.setup.config.length).toBeGreaterThan(0)
    const none = await load('kettu-never-prompted')
    expect(none.entries('kettu-never-prompted')).toEqual([])
  })

  it('refuses a session a newer dsh saved, rather than showing it wrong', async () => {
    await home.place(fixture('tools.v4').replace('"version":4', '"version":5'), { version: 5 })
    const connection = connect()
    host(connection).open(TOOLS)
    const loading = connection.loadSession(TOOLS, home.cwd)
    await expect(loading).rejects.toBeInstanceOf(AgentRequestError)
    await expect(loading).rejects.toMatchObject({ kind: 'agent_error' })
    connection.close()
  })
})

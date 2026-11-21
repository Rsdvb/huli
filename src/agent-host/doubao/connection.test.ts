// The Doubao driver against a scripted `doubao` that replays what Doubao CLI 2.37.2 printed: the
// command lines and stdin of each turn, the conversation it resumes, Stop, the queue, the listing,
// the export, and the sign-in.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import { DOUBAO } from '../agents/doubao'
import { AgentRequestError, type SignInImage } from '../connection'
import {
  DoubaoThread,
  fakeDoubaoSpawn,
  fixtureLines,
  fixtureText,
  type FakeDoubao,
  type FakeReply,
} from '../testing/fake-doubao'
import { DoubaoConnection } from './connection'
import { DoubaoGate } from './gate'

const CWD = 'C:\\work\\kite-doubao'
const PROGRAM = 'C:\\Users\\u\\AppData\\Local\\doubao_cli\\app\\current\\doubao.exe'
// The conversation the recorded turns ran in, as the scrubbed fixtures name it.
const CONVERSATION = '10000000000001112'

const folders: string[] = []
const connections: DoubaoConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kite-doubao-'))
  folders.push(dir)
  return dir
}

const lines = (name: string): FakeReply => ({ lines: fixtureLines(name) })

/** What the scripted CLI answers each command line with, unless a test says otherwise. */
function standard(run: FakeDoubao): FakeReply | Promise<FakeReply> {
  const [first, second] = run.args
  if (first === 'model' && second === 'list') return { lines: [fixtureText('model-list.json')] }
  if (first === 'auth') return { lines: ['登录成功，账号已通过验证'] }
  if (first === '--list') return { lines: [fixtureText('session-list.json')] }
  if (first === '--export') return { lines: [fixtureText('export.json').replace(/\n/g, ' ')] }
  if (run.args.includes('--resume')) return lines('resume.jsonl')
  return lines('simple.jsonl')
}

interface Setup {
  connection: DoubaoConnection
  runs: FakeDoubao[]
  accounts: AgentAccount[]
}

async function setup(
  options: {
    respond?: (run: FakeDoubao) => FakeReply | Promise<FakeReply> | null
    gate?: DoubaoGate
    kettuDir?: string | null
  } = {},
): Promise<Setup> {
  const accounts: AgentAccount[] = []
  const { spawn, runs } = fakeDoubaoSpawn((run) => options.respond?.(run) ?? standard(run))
  const kettuDir = options.kettuDir === undefined ? await folder() : options.kettuDir
  const connection = new DoubaoConnection(
    {
      def: DOUBAO,
      hooks: {
        traffic: () => {},
        account: (account) => accounts.push(account),
        ignored: () => {},
        log: () => {},
      },
      spec: {
        command: PROGRAM,
        args: [],
        env: {},
        shell: false,
        display: { command: 'doubao', args: [], env: {} },
      },
      env: {},
      spawn,
      cliVersion: '2.37.2',
      ...(kettuDir ? { kettuDir } : {}),
    },
    options.gate ?? new DoubaoGate(),
  )
  connections.push(connection)
  return { connection, runs, accounts }
}

const text = (value: string) => [{ type: 'text' as const, text: value }]
const turns = (runs: FakeDoubao[]) => runs.filter((run) => run.args.includes('-p'))

async function until(met: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !met(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!met()) throw new Error('The condition never held')
}

describe('the Doubao driver', () => {
  it('runs a turn on the account’s default model, the prompt on stdin, the program itself', async () => {
    const { connection, runs } = await setup()
    const init = await connection.initialize()
    expect(init.capabilities).toMatchObject({ listSessions: true, loadSession: true, logout: true })
    const { sessionId, config } = await connection.newSession(CWD)
    expect(config.find((option) => option.id === 'model')).toMatchObject({ value: '9' })
    expect(config.find((option) => option.id === 'effort')).toMatchObject({ value: 'high' })
    expect(config.find((option) => option.id === 'mode')).toMatchObject({ value: 'ask_always' })
    const thread = new DoubaoThread(CWD, sessionId)
    connection.register(sessionId, thread)
    const result = await connection.prompt(sessionId, text('用一句话回答：1+1 等于几？'))
    expect(result.stopReason).toBe('end_turn')
    const [turn] = turns(runs)
    expect(turn!.options.command).toBe(PROGRAM)
    expect(turn!.options.cwd).toBe(CWD)
    expect(turn!.args.slice(0, 2)).toEqual(['-C', CWD])
    expect(turn!.args).toContain('stream-json')
    expect(turn!.args.join(' ')).not.toContain('1+1')
    expect(turn!.input).toBe('用一句话回答：1+1 等于几？')
    expect(turn!.options.env.DOUBAO_CLI_NO_UPDATE_CHECK).toBe('1')
    expect(thread.entries).toEqual([expect.objectContaining({ markdown: '1+1 等于 2。' })])
  })

  it('resumes the conversation its first turn started, after a restart too', async () => {
    const kettuDir = await folder()
    const first = await setup({ kettuDir })
    await first.connection.initialize()
    const { sessionId } = await first.connection.newSession(CWD)
    await first.connection.prompt(sessionId, text('first'))
    await first.connection.prompt(sessionId, text('second'))
    const [, again] = turns(first.runs)
    expect(again!.args.slice(0, 4)).toEqual(['-C', CWD, '--resume', CONVERSATION])
    expect(again!.args.indexOf('--resume')).toBeLessThan(again!.args.indexOf('-p'))

    const later = await setup({ kettuDir })
    await later.connection.initialize()
    await later.connection.resumeSession(sessionId, CWD)
    await later.connection.prompt(sessionId, text('third'))
    expect(turns(later.runs)[0]!.args).toContain(CONVERSATION)
  })

  it('carries the session’s mode, model and level into the next turn', async () => {
    const { connection, runs } = await setup()
    await connection.initialize()
    const { sessionId } = await connection.newSession(CWD)
    await connection.setConfigOption(sessionId, 'mode', 'ask_risky')
    await connection.setConfigOption(sessionId, 'model', 'seed-lite-7b')
    await connection.setConfigOption(sessionId, 'effort', 'low')
    await expect(connection.setConfigOption(sessionId, 'effort', 'max')).rejects.toThrow()
    await connection.prompt(sessionId, text('hi'))
    const args = turns(runs)[0]!.args
    expect(args.slice(args.indexOf('--model'))).toEqual([
      '--model',
      'seed-lite-7b',
      '--effort',
      'low',
      '--permission-mode',
      'ask_risky',
    ])
  })

  it('fails a turn with the CLI’s own words, and a sign-in it needs as one', async () => {
    let reply: FakeReply = lines('bad-model.jsonl')
    const { connection } = await setup({
      respond: (run) => (run.args.includes('-p') ? reply : null),
    })
    await connection.initialize()
    const { sessionId } = await connection.newSession(CWD)
    await expect(connection.prompt(sessionId, text('hi'))).rejects.toMatchObject({
      kind: 'agent_error',
      message: expect.stringContaining('--model'),
    })
    reply = {
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['当前未登录，请运行 `doubao login` 登录'],
          error: { code: 'login_required' },
        }),
      ],
    }
    const error = await connection.prompt(sessionId, text('hi')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentRequestError)
    expect(error).toMatchObject({ kind: 'auth_required' })
    // A run the shared service dropped says so on stderr only.
    reply = { stderr: ['auth_unavailable: 运行时与共享服务断开连接，任务已停止。请重试'], code: 3 }
    await expect(connection.prompt(sessionId, text('hi'))).rejects.toThrow('共享服务断开连接')
  })

  it('stops a turn by ending its process, and the turn ends cancelled', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const { connection, runs } = await setup({
      respond: (run) =>
        run.args.includes('-p') ? { lines: fixtureLines('stopped.jsonl'), hold: held } : null,
    })
    await connection.initialize()
    const { sessionId } = await connection.newSession(CWD)
    const thread = new DoubaoThread(CWD, sessionId)
    connection.register(sessionId, thread)
    const turn = connection.prompt(sessionId, text('long'))
    await until(() => thread.entries.some((entry) => entry.kind === 'tool'))
    await connection.cancel(sessionId)
    expect((await turn).stopReason).toBe('cancelled')
    expect(turns(runs)[0]!.stopped).toBe(true)
    release()
  })

  it('runs one turn at a time for the account, and says how many go first', async () => {
    const gate = new DoubaoGate()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const respond = (run: FakeDoubao): FakeReply | null => {
      if (!run.args.includes('-p')) return null
      if (!first) return lines('simple.jsonl')
      first = false
      return { lines: fixtureLines('simple.jsonl'), hold: held }
    }
    const one = await setup({ gate, respond })
    const two = await setup({ gate, respond })
    await one.connection.initialize()
    await two.connection.initialize()
    const a = await one.connection.newSession(CWD)
    const b = await two.connection.newSession(CWD)
    const waiting = new DoubaoThread(CWD, b.sessionId)
    two.connection.register(b.sessionId, waiting)
    const running = one.connection.prompt(a.sessionId, text('a'))
    await until(() => turns(one.runs).length === 1)
    const queued = two.connection.prompt(b.sessionId, text('b'))
    await until(() => waiting.entries.some((entry) => entry.kind === 'notice'))
    expect(waiting.entries[0]).toMatchObject({ kind: 'notice', severity: 'info' })
    expect(turns(two.runs)).toHaveLength(0)
    release()
    await running
    await queued
    expect(turns(two.runs)).toHaveLength(1)
    expect(waiting.entries.some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it('lists every conversation, a Kettu session’s under its own id, an app’s under home', async () => {
    // The listing's third conversation is the one this session's turn started.
    const started = '10000000000023332'
    const { connection, runs } = await setup({
      respond: (run) =>
        run.args.includes('-p')
          ? {
              lines: fixtureLines('simple.jsonl').map((line) =>
                line.replaceAll(CONVERSATION, started),
              ),
            }
          : null,
    })
    await connection.initialize()
    const { sessionId } = await connection.newSession(CWD)
    await connection.prompt(sessionId, text('hi'))
    const listed = await connection.listAllSessions()
    expect(runs.at(-1)!.args).toEqual(['--list', '--all', '--json'])
    expect(listed.nextCursor).toBeNull()
    expect(listed.sessions.map((session) => session.sessionId)).toEqual([
      '10000000000021108',
      '10000000000022220',
      sessionId,
      '10000000000024442',
    ])
    expect(listed.sessions[0]).toMatchObject({ title: '豆包', cwd: os.homedir(), prompted: true })
    expect(listed.sessions[2]).toMatchObject({ cwd: CWD })
  })

  it('lists a folder’s conversations for the sidebar’s import', async () => {
    const { connection, runs } = await setup()
    await connection.initialize()
    const page = await connection.listSessions(CWD, null)
    expect(page.sessions.map((session) => session.cwd)).toEqual([CWD])
    expect(page.nextCursor).toBe('eyJza2lwIjo0fQ')
    expect(runs.at(-1)!.args).toEqual(['--list', '--limit', '100', '--json'])
  })

  it('reads on past the latest page for a folder whose conversations are older', async () => {
    const OLD = 'C:\\work\\kite-doubao-old'
    const { connection, runs } = await setup({
      respond: (run) =>
        run.args[0] === '--list'
          ? {
              lines: [
                fixtureText(
                  run.args.includes('--cursor') ? 'session-list-last.json' : 'session-list.json',
                ),
              ],
            }
          : null,
    })
    await connection.initialize()
    const page = await connection.listSessions(OLD, null)
    expect(page).toEqual({
      sessions: [
        {
          sessionId: '10000000000025552',
          title: '整理旧的构建脚本',
          updatedAt: '2026-10-02T09:14:05+08:00',
          cwd: OLD,
        },
      ],
      nextCursor: null,
    })
    expect(runs.filter((run) => run.args[0] === '--list').map((run) => run.args)).toEqual([
      ['--list', '--limit', '100', '--json'],
      ['--list', '--limit', '100', '--json', '--cursor', 'eyJza2lwIjo0fQ'],
    ])
  })

  it('stops after a few pages without the folder, and the next page goes on from there', async () => {
    const { connection, runs } = await setup()
    await connection.initialize()
    const page = await connection.listSessions('C:\\work\\elsewhere', null)
    expect(page).toEqual({ sessions: [], nextCursor: 'eyJza2lwIjo0fQ' })
    expect(runs.filter((run) => run.args[0] === '--list')).toHaveLength(5)
  })

  it('loads an imported conversation’s history from its export', async () => {
    const { connection, runs } = await setup()
    await connection.initialize()
    const thread = new DoubaoThread(CWD, CONVERSATION)
    thread.replaying = true
    connection.register(CONVERSATION, thread)
    await connection.loadSession(CONVERSATION, CWD)
    expect(runs.some((run) => run.args.join(' ') === `--export ${CONVERSATION}`)).toBe(true)
    expect(thread.entries.map((entry) => entry.kind)).toEqual(['user', 'agent', 'user', 'agent'])
    await connection.prompt(CONVERSATION, text('more'))
    expect(turns(runs)[0]!.args).toContain(CONVERSATION)
  })

  it('reports the sign-in auth status reads, the free plan included', async () => {
    let status = '登录成功，账号已通过验证'
    const { connection, accounts } = await setup({
      respond: (run) => (run.args[0] === 'auth' ? { lines: [status] } : null),
    })
    await connection.initialize()
    await connection.readAuthStatus()
    expect(accounts.at(-1)).toMatchObject({ kind: 'account', label: 'Free' })
    status = '当前未登录，请运行 `doubao login` 登录'
    await connection.readAuthStatus()
    expect(accounts.at(-1)).toMatchObject({ kind: 'none' })
    await expect(connection.newSession(CWD, { hidden: 'options' })).rejects.toMatchObject({
      kind: 'auth_required',
    })
  })

  it('signs in with the QR code picture the CLI names, shown to the client that asked', async () => {
    const dir = await folder()
    const png = path.join(dir, 'qrcode.png')
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    const { connection, runs, accounts } = await setup({
      respond: (run) =>
        run.args[0] === 'login'
          ? { stderr: ['正在获取登录二维码...', `QR_IMAGE=${png}`], lines: [], code: 0 }
          : null,
    })
    await connection.initialize()
    const shown: (SignInImage | null)[] = []
    await connection.authenticate('doubao-qr', {
      openLink: () => {},
      showImage: (image) => shown.push(image),
      signal: new AbortController().signal,
    })
    expect(runs.find((run) => run.args[0] === 'login')!.args).toEqual(['login', '--qr=png'])
    expect(shown[0]).toEqual({ mimeType: 'image/png', data: expect.stringMatching(/^iVBORw0K/) })
    expect(shown.at(-1)).toBeNull()
    expect(accounts.at(-1)).toMatchObject({ kind: 'account' })
  })
})

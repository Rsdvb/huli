import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '@shared/platform'
import type { ClosedTerminal } from '@shared/terminal-idle'
import type { ProcessRow } from './processes'
import { ProjectRegistry } from './projects'
import { isTyping, type PtyProcess, TerminalManager } from './terminals'

// Huli: agents' terminals that sit idle are closed, and only those: never one with a program
// running under its shell, one the user opened or typed into, or one a running turn uses.

class FakePty implements PtyProcess {
  readonly startedAt = Date.now()
  readonly written: string[] = []
  private data: ((data: string) => void) | null = null
  constructor(
    readonly pid: number,
    readonly process: string,
  ) {}
  onData(listener: (data: string) => void) {
    this.data = listener
    return { dispose: () => undefined }
  }
  onExit() {
    return { dispose: () => undefined }
  }
  write(data: string): void {
    this.written.push(data)
  }
  emit(data: string): void {
    this.data?.(data)
  }
  resize(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

const MINUTE = 60_000

function idleHost(platform: Platform = 'darwin') {
  const ptys: FakePty[] = []
  const closed: [string, ClosedTerminal[]][] = []
  // What runs under the shells besides the shells themselves; null when the listing fails.
  const state: { children: ProcessRow[] | null; listings: number } = { children: [], listings: 0 }
  const root = platform === 'win32' ? 'C:\\work\\app' : '/work/app'
  const projects = new ProjectRegistry(platform, async (path) => path)
  projects.set([root])
  let nextPid = 1000
  const manager = new TerminalManager({
    platform,
    appVersion: '0.0.0',
    env: platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : { SHELL: '/bin/zsh' },
    projects,
    findOnPath: async () => null,
    loadPty: async () => () => {
      const pty = new FakePty(nextPid++, platform === 'win32' ? 'powershell.exe' : 'zsh')
      ptys.push(pty)
      return pty
    },
    sink: { data: () => {}, replay: () => {}, info: () => {}, removed: () => {} },
    listProcesses: async () => {
      state.listings++
      if (!state.children) throw new Error('ps failed')
      const shells = ptys.map((pty) => ({
        pid: pty.pid,
        ppid: 1,
        startedAt: pty.startedAt,
        name: pty.process,
      }))
      return [...shells, ...state.children]
    },
    idleClosed: (sessionId, terminals) => closed.push([sessionId, terminals]),
  })

  /** An agent's terminal that ran `command`, which printed its output and the next prompt. */
  async function agentTerminal(sessionId = 's1', command = 'pnpm test') {
    const answer = await manager.agentCall({
      kind: 'run',
      sessionId,
      agentId: 'claude-code',
      folder: root,
      command,
    })
    if (!('result' in answer) || answer.result.kind !== 'terminal') throw new Error('no terminal')
    const pty = ptys.at(-1)!
    pty.emit('% ')
    await vi.advanceTimersByTimeAsync(500)
    pty.emit(`\r\n${command} passed\r\n% `)
    await vi.advanceTimersByTimeAsync(50)
    return { id: answer.result.terminal.id, pty }
  }

  /** A process that runs under the shell of `pty`, such as a dev server. */
  function runUnder(pty: FakePty, name = 'node') {
    state.children!.push({
      pid: 9000 + state.children!.length,
      ppid: pty.pid,
      startedAt: Date.now(),
      name,
    })
  }

  const ids = async () => (await manager.list()).map((info) => info.id)
  return { manager, ptys, closed, state, agentTerminal, runUnder, ids, root }
}

describe('idle agent terminals', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes one once its turn ended and it sat idle, and notes what it printed', async () => {
    const { manager, closed, agentTerminal, ids } = idleHost()
    await agentTerminal('s1', 'pnpm test')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1000)
    expect(await ids()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await ids()).toEqual([])
    expect(closed).toEqual([
      [
        's1',
        [
          {
            title: 'pnpm test',
            idleMs: expect.any(Number),
            output: '%\npnpm test passed\n%',
          },
        ],
      ],
    ])
    expect(closed[0]![1][0]!.idleMs).toBeGreaterThanOrEqual(10 * MINUTE)
  })

  it('never closes one with a program running under its shell', async () => {
    const { manager, closed, agentTerminal, runUnder, ids } = idleHost()
    const { pty } = await agentTerminal()
    runUnder(pty, 'vite')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(await ids()).toHaveLength(1)
    expect(closed).toEqual([])
  })

  it('closes none while it cannot list the processes', async () => {
    const { manager, state, agentTerminal, ids } = idleHost()
    await agentTerminal()
    state.children = null
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(await ids()).toHaveLength(1)
  })

  it('never closes one the user typed into, though answers the terminal sends do not count', async () => {
    const { manager, agentTerminal, ids } = idleHost()
    const typed = await agentTerminal('s1')
    const answered = await agentTerminal('s1')
    manager.turnEnded('s1')
    manager.input(answered.id, '\x1b[12;1R\x1b[I\x1b]11;rgb:0000/0000/0000\x07')
    manager.input(typed.id, 'y\r')
    await vi.advanceTimersByTimeAsync(11 * MINUTE)
    expect(await ids()).toEqual([typed.id])
  })

  it("never closes the user's own terminal, or one run from a reply", async () => {
    const { manager, agentTerminal, ids, root } = idleHost()
    const user = await manager.create('window', {
      projectPath: root,
      sessionId: 's1',
      cols: 80,
      rows: 24,
    })
    const replying = manager.agentCall({
      kind: 'reply',
      sessionId: 's1',
      agentId: 'claude-code',
      folder: root,
      command: 'ls',
      fromDevice: false,
    })
    await vi.advanceTimersByTimeAsync(3500)
    const reply = await replying
    if (!('result' in reply) || reply.result.kind !== 'terminal') throw new Error('no reply run')
    await agentTerminal('s1')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(31 * MINUTE)
    expect(await ids()).toEqual([user.id, reply.result.terminal.id])
  })

  it('never closes one the running turn uses', async () => {
    const { manager, agentTerminal, ids } = idleHost()
    await agentTerminal('s1')
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(await manager.closeIdle('s1')).toEqual({ closed: 0 })
    expect(await ids()).toHaveLength(1)
  })

  it('checks again once one that printed after the turn could have sat idle', async () => {
    const { manager, agentTerminal, ids } = idleHost()
    const { pty } = await agentTerminal('s1')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    pty.emit('late output\r\n% ')
    await vi.advanceTimersByTimeAsync(7 * MINUTE + 1000)
    expect(await ids()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    expect(await ids()).toEqual([])
  })

  it('waits for nothing and lists nothing while the setting is off', async () => {
    const { manager, state, agentTerminal, ids } = idleHost()
    manager.setIdleMinutes(0)
    await agentTerminal('s1')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(vi.getTimerCount()).toBe(0)
    expect(state.listings).toBe(0)
    expect(await ids()).toHaveLength(1)
  })

  it('checks every session once a host holds more agent terminals than the cap', async () => {
    const { manager, agentTerminal, ids } = idleHost()
    manager.setIdleMinutes(30)
    for (let i = 0; i < 20; i++) await agentTerminal('s1')
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(6 * MINUTE)
    // Long before s1's own check, the 21st terminal sets one off.
    const { id } = await agentTerminal('s2')
    await vi.advanceTimersByTimeAsync(100)
    expect(await ids()).toEqual([id])
  })

  it('tells the tab list what each does, and closes the idle ones it asks for', async () => {
    const { manager, agentTerminal, runUnder, ids } = idleHost()
    manager.setIdleMinutes(0)
    const idle = await agentTerminal('s1')
    const server = await agentTerminal('s1')
    const fresh = await agentTerminal('s1')
    runUnder(server.pty)
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    fresh.pty.emit('more\r\n% ')
    await vi.advanceTimersByTimeAsync(100)
    const activity = await manager.activity('s1')
    expect(activity.map(({ id, running, idle }) => ({ id, running, idle }))).toEqual([
      { id: idle.id, running: false, idle: true },
      { id: server.id, running: true, idle: false },
      { id: fresh.id, running: false, idle: false },
    ])
    expect(await manager.closeIdle('s1')).toEqual({ closed: 1 })
    expect(await ids()).toEqual([server.id, fresh.id])
  })

  it('closes those idle as long as the setting says as the tab list opens', async () => {
    const { manager, agentTerminal, ids } = idleHost()
    manager.setIdleMinutes(5)
    await agentTerminal('s1')
    const late = await agentTerminal('s1')
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    late.pty.emit('x\r\n% ')
    await vi.advanceTimersByTimeAsync(3 * MINUTE)
    manager.turnEnded('s1')
    const activity = await manager.activity('s1')
    expect(activity.map((each) => each.id)).toEqual([late.id])
    expect(await ids()).toEqual([late.id])
  })
})

describe('busy terminals on Windows', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts only shells with a program running under them, and every one it cannot tell', async () => {
    const { manager, state, agentTerminal, runUnder } = idleHost('win32')
    const idle = await agentTerminal('s1', 'pnpm test')
    const server = await agentTerminal('s1', 'pnpm dev')
    runUnder(server.pty, 'node.exe')
    expect(await manager.busy()).toEqual([
      expect.objectContaining({
        id: server.id,
        title: 'pnpm dev',
        sessionId: 's1',
        opener: 'agent',
        since: expect.any(Number),
      }),
    ])
    expect(idle.id).not.toBe(server.id)
    state.children = null
    await vi.advanceTimersByTimeAsync(6000)
    idle.pty.emit('\r\n% ')
    server.pty.emit('\r\n% ')
    await vi.advanceTimersByTimeAsync(50)
    expect((await manager.busy()).map((terminal) => terminal.id)).toEqual([idle.id, server.id])
  })

  it("keeps an agent's tab named by its command while PowerShell titles the console itself", async () => {
    const { manager, agentTerminal, root } = idleHost('win32')
    const { id, pty } = await agentTerminal('s1', 'pnpm dev')
    const shellTitle = '\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07'
    pty.emit(shellTitle)
    await vi.advanceTimersByTimeAsync(200)
    const user = await manager.create('window', { projectPath: root, cols: 80, rows: 24 })
    const titles = Object.fromEntries((await manager.list()).map((info) => [info.id, info.title]))
    expect(titles[id]).toBe('pnpm dev')
    expect(titles[user.id]).toBe('powershell')
    pty.emit('\x1b]0;npm run dev\x07')
    await vi.advanceTimersByTimeAsync(200)
    expect((await manager.list()).find((info) => info.id === id)?.title).toBe('npm run dev')
  })
})

describe('idle agent terminals on Windows', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("never closes one whose command runs inside PowerShell, off the shell's prompt", async () => {
    const { manager, ptys, ids, root } = idleHost('win32')
    const answer = await manager.agentCall({
      kind: 'run',
      sessionId: 's1',
      agentId: 'claude-code',
      folder: root,
      command: 'Start-Sleep 3000',
    })
    expect('result' in answer).toBe(true)
    const pty = ptys[0]!
    pty.emit('PS C:\\work\\app> ')
    await vi.advanceTimersByTimeAsync(500)
    expect(pty.written).toEqual(['Start-Sleep 3000\r'])
    // As PSReadLine draws it: the line again after each key, the cursor moved back first. Its
    // parts end in the digit the command ends in, which no prompt mark may be taken from.
    pty.emit(
      '\x1b[93mStart-Sle\x1b[m\x1b[93m\x1b[5;42HStart-Sleep \x1b[97m30\x1b[m\x1b[93m\x1b[5;42H' +
        'Start-Sleep \x1b[97m300\x1b[m\x1b[93m\x1b[5;42HStart-Sleep \x1b[97m3000\r\n\x1b[?25h',
    )
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(await ids()).toHaveLength(1)
    expect((await manager.busy()).map((terminal) => terminal.title)).toEqual(['Start-Sleep 3000'])
    pty.emit('PS C:\\work\\app> ')
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(await manager.closeIdle('s1')).toEqual({ closed: 1 })
  })
})

describe('the prompt of an agent terminal on Windows', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is read from the echo of the command, typed before PowerShell showed its prompt', async () => {
    const { manager, ptys, ids, root } = idleHost('win32')
    await manager.agentCall({
      kind: 'run',
      sessionId: 's1',
      agentId: 'claude-code',
      folder: root,
      command: 'echo hi',
    })
    const pty = ptys[0]!
    pty.emit('Windows PowerShell\r\nCopyright (C) Microsoft Corporation.')
    await vi.advanceTimersByTimeAsync(500)
    expect(pty.written).toEqual(['echo hi\r'])
    pty.emit('\r\nPS C:\\work\\app> \x1b[93mecho\x1b[0m hi\r\nhi\r\nPS C:\\work\\app> ')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(11 * MINUTE)
    expect(await ids()).toEqual([])
  })

  it('reads through a redrawn echo and a repaint that leaves the cursor on a blank line', async () => {
    const { manager, ptys, ids, root } = idleHost('win32')
    await manager.agentCall({
      kind: 'run',
      sessionId: 's1',
      agentId: 'claude-code',
      folder: root,
      command: 'echo idle-1',
    })
    const pty = ptys[0]!
    pty.emit('PS C:\\work\\app> ')
    await vi.advanceTimersByTimeAsync(500)
    // As ConPTY sent it: part of the echo, a cursor move back, the whole echo, the output.
    pty.emit(
      '\x1b[93mecho \x1b[37mi\x1b[m\x1b[93m\x1b[5;42Hecho \x1b[37midle-1\r\n\x1b[midle-1\r\nPS C:\\work\\app> ',
    )
    await vi.advanceTimersByTimeAsync(1000)
    // A resize repaints the screen and leaves the cursor on a blank line below the prompt.
    pty.emit('\x1b[HPS C:\\work\\app>\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[10;26H\x1b[?25h')
    manager.turnEnded('s1')
    await vi.advanceTimersByTimeAsync(11 * MINUTE)
    expect(await ids()).toEqual([])
  })
})

describe("the user's typing", () => {
  it("tells keys from the terminal's own answers", () => {
    expect(isTyping('ls\r')).toBe(true)
    expect(isTyping('\x03')).toBe(true)
    expect(isTyping('\x1b[200~pasted\x1b[201~')).toBe(true)
    expect(isTyping('\x1b[12;1R')).toBe(false)
    expect(isTyping('\x1b[?1;2c')).toBe(false)
    expect(isTyping('\x1b[I\x1b[O')).toBe(false)
    expect(isTyping('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')).toBe(false)
    expect(isTyping('\x1b[<0;10;5M')).toBe(false)
  })
})

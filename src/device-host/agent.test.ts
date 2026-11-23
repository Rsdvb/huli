import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAction, DeviceBatchStep } from '@shared/device-agent'
import type { FoundDevice, Tools } from './discovery'

// The agent-device command lines the device host runs, each answering as `answer` says, and the
// platform tools' (adb, simctl, ps) as `execAnswer` says.
const runs: string[][] = []
let answer: (args: string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: 'ok' })
const execs: { file: string; args: string[] }[] = []
let execAnswer: (file: string, args: string[]) => string = () => ''

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execs.push({ file, args })
    const stdout = execAnswer(file, args)
    setImmediate(() => callback(null, stdout, ''))
  },
  spawn: (_file: string, argv: string[]) => {
    const args = argv.slice(1)
    runs.push(args)
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const { code, stdout } = answer(args)
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('exit', code)
    })
    return child
  },
}))

vi.mock('./runtime', () => ({
  packageRoot: () => '/kite/node_modules/agent-device',
  nodeCommand: (env: NodeJS.ProcessEnv) => ({ file: 'node', env }),
}))

const { AgentActions } = await import('./agent')

const simulator = {
  id: 'ios-sim:SIM',
  platform: 'ios',
  kind: 'simulator',
  target: 'SIM',
} as unknown as FoundDevice

const emulator = {
  id: 'android:emulator-5554',
  platform: 'android',
  kind: 'emulator',
  target: 'emulator-5554',
} as unknown as FoundDevice

const ADB = '/sdk/platform-tools/adb'

function actions() {
  return new AgentActions(
    '/data',
    async () => ({}),
    async () => ({ xcrun: null, adb: ADB, emulator: null }) as unknown as Tools,
    () => {},
  )
}

const ok = { code: 0, stdout: 'ok' }
const json = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ success: true, data }) })
const signal = () => new AbortController().signal
const tail = (args: string[]) => args.slice(args.indexOf('--') + 1)
const made: string[] = []
/** A session folder of its own, as the disk names it. */
function sessionFolder(): string {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'kite-device-')))
  made.push(folder)
  return folder
}

afterAll(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true })
})

/** The command line one action runs, after the session it opens first. */
async function commandOf(action: DeviceAction): Promise<string[]> {
  runs.length = 0
  await actions().run('s1', simulator, action, new AbortController().signal)
  return runs.at(-1)!
}

beforeEach(() => {
  answer = () => ({ code: 0, stdout: 'ok' })
  execAnswer = () => ''
  execs.length = 0
  runs.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the agent-device commands', () => {
  it('put what the agent wrote after --, where no word reads as a flag', async () => {
    const typed = await commandOf({ type: 'type', text: '--udid=OTHER' })
    expect(typed.slice(typed.indexOf('--'))).toEqual(['--', '--udid=OTHER'])
    const filled = await commandOf({ type: 'fill', ref: '@e3', text: '--out=/tmp/x' })
    expect(filled[0]).toBe('fill')
    expect(filled.slice(filled.indexOf('--'))).toEqual(['--', '@e3', '--out=/tmp/x'])
    expect(filled).toContain('--settle')
  })

  it('build waits, checks and reads', async () => {
    const tail = (args: string[]) => args.slice(args.indexOf('--') + 1)
    expect(
      tail(await commandOf({ type: 'wait', until: 'text', value: 'Saved', timeoutMs: 5000 })),
    ).toEqual(['text', 'Saved', '5000'])
    expect(
      tail(await commandOf({ type: 'wait', until: 'absent', value: 'label="Spinner"' })),
    ).toEqual(['absent', 'label="Spinner"'])
    expect(tail(await commandOf({ type: 'wait', until: 'stable', timeoutMs: 8000 }))).toEqual([
      'stable',
      '500',
      '8000',
    ])
    expect(
      tail(
        await commandOf({
          type: 'find',
          locator: 'label',
          query: 'Email',
          action: 'fill',
          value: 'a@b.c',
        }),
      ),
    ).toEqual(['label', 'Email', 'fill', 'a@b.c'])
    expect(
      tail(await commandOf({ type: 'find', locator: 'any', query: 'Total', action: 'getText' })),
    ).toEqual(['Total', 'get', 'text'])
    expect(tail(await commandOf({ type: 'get', format: 'attrs', target: '@e4' }))).toEqual([
      'attrs',
      '@e4',
    ])
    expect(tail(await commandOf({ type: 'alert', action: 'wait', timeoutMs: 3000 }))).toEqual([
      'wait',
      '3000',
    ])
    expect(tail(await commandOf({ type: 'keyboard', action: 'dismiss' }))).toEqual(['dismiss'])
  })

  it('ask for the compact answer with level digest', async () => {
    expect(await commandOf({ type: 'snapshot', level: 'digest' })).toEqual(
      expect.arrayContaining(['snapshot', '-i', '--level', 'digest']),
    )
    const tap = await commandOf({ type: 'tap', ref: '@e2', level: 'digest' })
    expect(tap.slice(0, tap.indexOf('--'))).toEqual(
      expect.arrayContaining(['press', '--settle', '--level', 'digest']),
    )
  })

  it('run a batch as one JSON value, stopping at a failing step', async () => {
    const steps: DeviceBatchStep[] = [
      { command: 'press', input: { ref: '@e1', settle: true } },
      { command: 'wait', input: { text: 'Saved' } },
    ]
    const batch = await commandOf({ type: 'batch', steps, stopOnError: true })
    expect(batch[0]).toBe('batch')
    expect(JSON.parse(batch[batch.indexOf('--steps') + 1]!)).toEqual(steps)
    expect(batch).toEqual(expect.arrayContaining(['--on-error', 'stop', '--max-steps', '2']))
  })

  it('answer a check that does not hold, and fail one that cannot run', async () => {
    answer = (args) =>
      args[0] === 'is'
        ? {
            code: 1,
            stdout: 'Error (COMMAND_FAILED): is visible failed for selector label="OK": hidden',
          }
        : { code: 0, stdout: 'ok' }
    const no = await actions().run(
      's1',
      simulator,
      { type: 'is', predicate: 'visible', selector: 'label="OK"' },
      new AbortController().signal,
    )
    expect(no.text).toMatch(/^No\. .*is visible failed/)
    answer = (args) =>
      args[0] === 'is'
        ? { code: 1, stdout: 'Error (DEVICE_NOT_FOUND): gone' }
        : { code: 0, stdout: 'ok' }
    await expect(
      actions().run(
        's1',
        simulator,
        { type: 'is', predicate: 'visible', selector: 'label="OK"' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
  })
})

describe('recordings, comparisons and diagnostics', () => {
  it('record into the session folder, the path after --, stopping at the limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const folder = sessionFolder()
    const video = path.join(folder, '.kite', 'device', 'recordings', 'flow.mp4')
    answer = (args) =>
      args[0] === 'record' && args[1] === 'stop'
        ? json({ outPath: video, durationMs: 180_000 })
        : ok
    const agent = actions()
    await agent.run('s1', simulator, { type: 'record_start', name: 'flow' }, signal(), folder)
    const start = runs.find((args) => args[0] === 'record' && args[1] === 'start')!
    expect(tail(start)).toEqual([video])
    // No app launched in this session: the whole screen.
    expect(start).toEqual(expect.arrayContaining(['--scope', 'device']))
    expect(readFileSync(path.join(folder, '.kite', 'device', '.gitignore'), 'utf8')).toBe('*\n')
    await expect(
      agent.run('s1', simulator, { type: 'record_start' }, signal(), folder),
    ).rejects.toMatchObject({ code: 'busy' })

    await vi.advanceTimersByTimeAsync(180_000)
    vi.useRealTimers()
    const stopped = await agent.run('s1', simulator, { type: 'record_stop' }, signal())
    expect(runs.filter((args) => args[0] === 'record' && args[1] === 'stop')).toHaveLength(1)
    expect(stopped.file).toEqual({ path: video, mimeType: 'video/mp4' })
    expect(stopped.structured).toMatchObject({
      path: '.kite/device/recordings/flow.mp4',
      stoppedAtLimit: true,
    })
    await expect(
      agent.run('s1', simulator, { type: 'record_stop' }, signal()),
    ).rejects.toMatchObject({ code: 'not_recording' })
  })

  it('stop a recording when its session ends, and record nowhere without a folder', async () => {
    const folder = sessionFolder()
    const agent = actions()
    await agent.run('s1', simulator, { type: 'launch', app: 'com.example' }, signal(), folder)
    await agent.run('s1', simulator, { type: 'record_start' }, signal(), folder)
    const start = runs.find((args) => args[0] === 'record' && args[1] === 'start')!
    // The app's own scope, once it was launched.
    expect(start).not.toContain('--scope')
    await agent.stopRecordings((sessionId) => sessionId === 's2')
    expect(runs.some((args) => args[0] === 'record' && args[1] === 'stop')).toBe(false)
    await agent.stopRecordings((sessionId) => sessionId === 's1')
    expect(runs.filter((args) => args[0] === 'record' && args[1] === 'stop')).toHaveLength(1)
    await expect(
      agent.run('s1', simulator, { type: 'record_start' }, signal(), null),
    ).rejects.toMatchObject({ code: 'no_folder' })
  })

  it('compare a shot with the previous one, then with a baseline it saves first', async () => {
    const folder = sessionFolder()
    answer = (args) => {
      if (args[0] === 'screenshot') writeFileSync(tail(args)[0]!, 'png')
      if (args[0] === 'diff') {
        writeFileSync(args[args.indexOf('--out') + 1]!, 'diff')
        return json({ mismatchPercentage: 1.5, differentPixels: 15, totalPixels: 1000 })
      }
      return ok
    }
    const agent = actions()
    const compare = (action: Omit<Extract<DeviceAction, { type: 'screenshot_compare' }>, 'type'>) =>
      agent.run('s1', simulator, { type: 'screenshot_compare', ...action }, signal(), folder)

    expect((await compare({})).structured).toMatchObject({ compared: false })
    const shot = runs.find((args) => args[0] === 'screenshot')!
    expect(shot).toContain('--normalize-status-bar')
    const shots = path.join(folder, '.kite', 'device', 'shots')
    expect(path.dirname(tail(shot)[0]!)).toBe(shots)

    runs.length = 0
    const second = await compare({ threshold: 0.2 })
    const diff = runs.find((args) => args[0] === 'diff')!
    const baseline = diff[diff.indexOf('--baseline') + 1]!
    expect(baseline.startsWith(path.join(shots, 'kettu-'))).toBe(true)
    expect(baseline.endsWith('-previous.png')).toBe(true)
    expect(tail(diff)).toEqual([baseline.replace('-previous.png', '-latest.png')])
    expect(diff).toEqual(expect.arrayContaining(['--threshold', '0.2']))
    expect(second.structured).toMatchObject({ compared: true, mismatchPercent: 1.5 })
    expect(second.image).toBe(Buffer.from('diff').toString('base64'))

    const saved = await compare({ baseline: 'screens/home.png' })
    expect(saved.structured).toMatchObject({ compared: false, saved: true })
    expect(existsSync(path.join(folder, 'screens', 'home.png'))).toBe(true)
    runs.length = 0
    await compare({ baseline: 'screens/home.png' })
    const again = runs.find((args) => args[0] === 'diff')!
    expect(again[again.indexOf('--baseline') + 1]).toBe(path.join(folder, 'screens', 'home.png'))
  })

  it('write no baseline through a link that leads out of the session folder', async () => {
    const folder = sessionFolder()
    const outside = sessionFolder()
    const link = path.join(folder, 'screens')
    // A junction on Windows needs no administrator; elsewhere it is a plain link.
    symlinkSync(outside, link, 'junction')
    answer = (args) => {
      if (args[0] === 'screenshot') writeFileSync(tail(args)[0]!, 'png')
      return ok
    }
    try {
      await expect(
        actions().run(
          's1',
          simulator,
          { type: 'screenshot_compare', baseline: 'screens/home.png' },
          signal(),
          folder,
        ),
      ).rejects.toThrow(/out of this session/)
      expect(existsSync(path.join(outside, 'home.png'))).toBe(false)
    } finally {
      unlinkSync(link)
    }
  })

  it('pass payloads, apps and settings after --, where no word reads as a flag', async () => {
    const pushed = await commandOf({
      type: 'push',
      app: 'com.example',
      payload: { aps: { alert: '--udid=OTHER' } },
    })
    expect(pushed[0]).toBe('push')
    expect(tail(pushed)).toEqual(['com.example', '{"aps":{"alert":"--udid=OTHER"}}'])
    expect(await commandOf({ type: 'reset_app', app: 'com.example', keychain: false })).toEqual([
      'settings',
      '--session',
      expect.stringMatching(/^kettu-/),
      '--',
      'clear-app-state',
      'com.example',
    ])
    const permission = await commandOf({
      type: 'permission',
      app: 'com.example',
      permission: 'camera',
      state: 'reset',
    })
    expect(permission).toEqual(expect.arrayContaining(['--app', 'com.example']))
    expect(tail(permission)).toEqual(['permission', 'reset', 'camera'])
    answer = (args) => (args[0] === 'network' ? json({ active: true, entries: [] }) : ok)
    expect(tail(await commandOf({ type: 'network', limit: 20, include: 'headers' }))).toEqual([
      'dump',
      '20',
      'headers',
    ])
  })

  it("read the app's log where agent-device keeps it, with its crashes since it started", async () => {
    const folder = sessionFolder()
    const log = path.join(folder, 'app.log')
    writeFileSync(log, 'one\ntwo\nthree\n')
    answer = (args) => (args[0] === 'logs' ? json({ path: log, active: true }) : ok)
    const now = Date.now() / 1000
    const line = (at: number, pid: number, text: string) =>
      `${(now + at).toFixed(3)}  ${pid}  ${pid} E AndroidRuntime: ${text}`
    execAnswer = (_file, args) =>
      args.includes('crash')
        ? [
            line(1, 4321, 'FATAL EXCEPTION: main'),
            line(1, 4321, 'Process: com.example, PID: 4321'),
            line(1, 4321, 'java.lang.IllegalStateException: boom'),
            line(2, 999, 'Process: com.other, PID: 999'),
          ].join('\n')
        : ''
    const agent = actions()
    await agent.run('s1', emulator, { type: 'launch', app: 'com.example' }, signal())
    const read = await agent.run(
      's1',
      emulator,
      { type: 'logs', lines: 2, crashes: true },
      signal(),
    )
    expect(runs.find((args) => args[0] === 'logs')).toEqual(
      expect.arrayContaining(['logs', 'path', '--json']),
    )
    expect(execs.find((exec) => exec.args.includes('logcat'))).toEqual({
      file: ADB,
      args: ['-s', 'emulator-5554', 'logcat', '-b', 'crash', '-d', '-v', 'epoch', '-t', '2000'],
    })
    expect(read.structured).toMatchObject({ app: 'com.example', lines: ['two', 'three'] })
    const crashes = read.structured!.crashes as { summary: string }[]
    expect(crashes.map((crash) => crash.summary)).toEqual(['java.lang.IllegalStateException: boom'])
  })

  it("sample the app's CPU with commands made of the serial and the pid alone", async () => {
    const stat = (ticks: number) =>
      `4321 (com.example) S 1 1 0 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 100 0 0`
    execAnswer = (_file, args) =>
      args.includes('pidof')
        ? '4321\n'
        : [stat(100), '500.00 900.00', stat(150), '501.00 902.00'].join('\n')
    answer = (args) =>
      args[0] === 'perf' ? json({ metrics: { memory: { totalPssKb: 1024 } } }) : ok
    const agent = actions()
    await expect(agent.run('s1', emulator, { type: 'perf' }, signal())).rejects.toMatchObject({
      code: 'no_app',
    })
    await agent.run('s1', emulator, { type: 'launch', app: 'com.example' }, signal())
    const sample = await agent.run('s1', emulator, { type: 'perf' }, signal())
    expect(execs.map((exec) => exec.args)).toEqual([
      ['-s', 'emulator-5554', 'shell', 'pidof', 'com.example'],
      [
        '-s',
        'emulator-5554',
        'shell',
        'cat /proc/4321/stat /proc/uptime; sleep 1; cat /proc/4321/stat /proc/uptime',
      ],
    ])
    expect(tail(runs.find((args) => args[0] === 'perf')!)).toEqual(['memory', 'sample'])
    expect(sample.structured).toMatchObject({
      app: 'com.example',
      cpu: { pid: 4321, percent: 50 },
      memory: { totalPssKb: 1024 },
    })
  })
})

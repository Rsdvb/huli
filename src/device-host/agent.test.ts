import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAction, DeviceBatchStep } from '@shared/device-agent'
import type { FoundDevice, Tools } from './discovery'

// The agent-device command lines the device host runs, each answering as `answer` says.
const runs: string[][] = []
let answer: (args: string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: 'ok' })

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
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

function actions() {
  return new AgentActions(
    '/data',
    async () => ({}),
    async () => ({ xcrun: null, adb: null, emulator: null }) as unknown as Tools,
    () => {},
  )
}

/** The command line one action runs, after the session it opens first. */
async function commandOf(action: DeviceAction): Promise<string[]> {
  runs.length = 0
  await actions().run('s1', simulator, action, new AbortController().signal)
  return runs.at(-1)!
}

beforeEach(() => {
  answer = () => ({ code: 0, stdout: 'ok' })
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

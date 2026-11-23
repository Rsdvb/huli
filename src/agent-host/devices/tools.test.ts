import { describe, expect, it, vi } from 'vitest'
import type { DeviceAccessAnswer, DeviceCall, DeviceCallAnswer } from '@shared/device-agent'
import { parseDeviceAccessFile } from './access'
import { actionOf, DeviceArgsError, DeviceTools, type DeviceToolDeps } from './tools'

const caller = { sessionId: 's1', project: '/work/app' }
const SIM = 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF'

// By default the user connected the simulator to the session, so the agent asks before using it.
function tools(
  answer: DeviceAccessAnswer,
  always: string[] = [],
  device: { kind: string; sessionId: string | null } = { kind: 'simulator', sessionId: 's1' },
  extra: Partial<DeviceToolDeps> = {},
) {
  const calls: DeviceCall[] = []
  const stored = new Set(always)
  const deps: DeviceToolDeps = {
    call: async (call): Promise<DeviceCallAnswer> => {
      calls.push(call)
      if (call.kind === 'list') {
        const listed = { id: SIM, name: 'iPhone 17 Pro', ...device }
        return { result: { text: '', value: { devices: [listed] } } }
      }
      return { result: { text: 'done' } }
    },
    sessionOf: (sessionId) => sessionId,
    agentName: () => 'Claude Code',
    projectOf: () => '/work/app',
    ask: vi.fn(async () => answer),
    alwaysAllowed: (id) => stored.has(id),
    allowAlways: (id) => stored.add(id),
    ...extra,
  }
  return { tools: new DeviceTools(deps), deps, calls, stored }
}

describe('device tool arguments', () => {
  it('accepts element references and points', () => {
    expect(actionOf('device_tap', { ref: 'e3' })).toEqual({ type: 'tap', ref: '@e3', long: false })
    expect(actionOf('device_tap', { ref: '@e12~s4', long: true })).toEqual({
      type: 'tap',
      ref: '@e12~s4',
      long: true,
    })
    expect(actionOf('device_tap', { x: 20, y: 40 })).toEqual({
      type: 'tap',
      x: 20,
      y: 40,
      long: false,
    })
  })

  it('refuses what could reach a command line as a flag or another command', () => {
    expect(() => actionOf('device_tap', { ref: '--help' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_launch_app', { app: '--session=other' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_launch_app', { app: '../x' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_open_url', { url: '--relaunch' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_install_app', { path: '/tmp/script.sh' })).toThrow(
      DeviceArgsError,
    )
    expect(() => actionOf('device_type', { text: 'a\u0000b' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_press_button', { button: 'power-off' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_set_location', { latitude: 91, longitude: 0 })).toThrow(
      DeviceArgsError,
    )
  })

  it('keeps apps, links and installs it can name', () => {
    expect(actionOf('device_launch_app', { app: 'com.example.app' })).toEqual({
      type: 'launch',
      app: 'com.example.app',
    })
    expect(actionOf('device_open_url', { url: 'myapp://settings/profile' })).toEqual({
      type: 'open_url',
      url: 'myapp://settings/profile',
    })
    expect(actionOf('device_install_app', { path: 'build/App.app' })).toEqual({
      type: 'install',
      path: 'build/App.app',
    })
  })
})

describe('device access', () => {
  it('asks once per session and device, then lets the session act', async () => {
    const { tools: subject, deps, calls } = tools('session')
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(deps.ask).toHaveBeenCalledWith('s1', SIM, 'iPhone 17 Pro')
    expect(calls.filter((call) => call.kind === 'action')).toHaveLength(2)
  })

  it("asks again after the session's allow is taken back, for that session and device only", async () => {
    const { tools: subject, deps, calls } = tools('session')
    const other = { sessionId: 's2', project: '/work/app' }
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    await subject.call(other, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(2)

    subject.revoke('s1', SIM)
    await subject.call(other, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(2)
    vi.mocked(deps.ask).mockResolvedValueOnce('deny')
    const refused = await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).toHaveBeenCalledTimes(3)
    expect(refused.structuredContent).toMatchObject({ code: 'not_allowed' })
    expect(calls.filter((call) => call.kind === 'action')).toHaveLength(3)
  })

  it('keeps an always-allowed device allowed when a session takes its allow back', async () => {
    const { tools: subject, deps } = tools('always')
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    subject.revoke('s1', SIM)
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(1)
  })

  it('does nothing on the device when the user denies or does not answer', async () => {
    for (const answer of ['deny', 'timeout'] as const) {
      const { tools: subject, calls } = tools(answer)
      const result = await subject.call(caller, 'device_open', { deviceId: SIM })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
      expect(calls.some((call) => call.kind !== 'list')).toBe(false)
    }
  })

  it('keeps an always-allowed device and skips the question for it', async () => {
    const first = tools('always')
    await first.tools.call(caller, 'device_open', { deviceId: SIM })
    expect(first.stored.has(SIM)).toBe(true)
    const second = tools('deny', [SIM])
    await second.tools.call(caller, 'device_open', { deviceId: SIM })
    expect(second.deps.ask).not.toHaveBeenCalled()
  })

  it('lets the agent use a simulator it connects itself without asking', async () => {
    const {
      tools: subject,
      deps,
      calls,
    } = tools('deny', [], { kind: 'simulator', sessionId: null })
    await subject.call(caller, 'device_open', { deviceId: SIM })
    await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.kind === 'open' || call.kind === 'action')).toHaveLength(2)
  })

  it('asks before a physical device, whoever connects it', async () => {
    const { tools: subject, deps } = tools('deny', [], { kind: 'physical', sessionId: null })
    const result = await subject.call(caller, 'device_open', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
  })

  it('asks nothing in full access, and the thread says it used the device', async () => {
    const used = vi.fn()
    const { tools: subject, deps } = tools('deny', [], undefined, {
      fullAccess: () => true,
      used,
    })
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).not.toHaveBeenCalled()
    expect(used).toHaveBeenCalledWith('s1', 'iPhone 17 Pro')
  })

  it('asks nothing for a device the user referenced in a message', async () => {
    const { tools: subject, deps } = tools('deny', [], undefined, { shared: () => true })
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).not.toHaveBeenCalled()
  })

  it('answers listing without asking', async () => {
    const { tools: subject, deps } = tools('deny')
    const result = await subject.call(caller, 'device_list', {})
    expect(result.isError).toBeUndefined()
    expect(deps.ask).not.toHaveBeenCalled()
  })
})

describe('always-allowed devices file', () => {
  it('keeps only device ids, once each', () => {
    expect(
      parseDeviceAccessFile({ allowed: [SIM, SIM, 'android:emulator-5554', '../etc', 7, 'x:y'] }),
    ).toEqual({ version: 1, allowed: [SIM, 'android:emulator-5554'] })
    expect(typeof parseDeviceAccessFile({ allowed: 'all' })).toBe('string')
  })
})

describe('the agent-device commands the tools pass on', () => {
  it('builds waits, finds, checks and reads from checked arguments', () => {
    expect(actionOf('device_wait', { text: 'Saved', timeoutMs: 5000 })).toEqual({
      type: 'wait',
      until: 'text',
      value: 'Saved',
      timeoutMs: 5000,
    })
    expect(actionOf('device_wait', { absent: 'label="Loading"' })).toEqual({
      type: 'wait',
      until: 'absent',
      value: 'label="Loading"',
    })
    expect(actionOf('device_wait', { stable: true, quietMs: 800 })).toEqual({
      type: 'wait',
      until: 'stable',
      quietMs: 800,
    })
    expect(actionOf('device_find', { query: 'Sign in' })).toEqual({
      type: 'find',
      locator: 'any',
      query: 'Sign in',
      action: 'exists',
    })
    expect(
      actionOf('device_find', {
        query: 'Email',
        locator: 'label',
        action: 'fill',
        value: 'a@b.c',
        pick: 'first',
        level: 'digest',
      }),
    ).toEqual({
      type: 'find',
      locator: 'label',
      query: 'Email',
      action: 'fill',
      value: 'a@b.c',
      pick: 'first',
      level: 'digest',
    })
    expect(
      actionOf('device_is', { predicate: 'text', selector: 'id="total"', value: '$42' }),
    ).toEqual({ type: 'is', predicate: 'text', selector: 'id="total"', value: '$42' })
    expect(actionOf('device_get', { format: 'text', ref: 'e4' })).toEqual({
      type: 'get',
      format: 'text',
      target: '@e4',
    })
    expect(actionOf('device_alert', {})).toEqual({ type: 'alert', action: 'get' })
    expect(actionOf('device_keyboard', { action: 'dismiss' })).toEqual({
      type: 'keyboard',
      action: 'dismiss',
    })
    expect(actionOf('device_snapshot', { level: 'digest' })).toEqual({
      type: 'snapshot',
      level: 'digest',
    })
  })

  it('refuses arguments that do not fit the command', () => {
    const refused: [Parameters<typeof actionOf>[0], Record<string, unknown>][] = [
      ['device_wait', {}],
      ['device_wait', { text: 'a', selector: 'label="b"' }],
      ['device_wait', { selector: '500' }],
      ['device_wait', { selector: '@e3' }],
      ['device_wait', { selector: 'stable' }],
      ['device_wait', { text: 'a', quietMs: 100 }],
      ['device_wait', { text: 'a', timeoutMs: 600_000 }],
      ['device_find', { query: 'label' }],
      ['device_find', { query: 'x', action: 'delete' }],
      ['device_find', { query: 'x', action: 'fill' }],
      ['device_find', { query: 'x', value: 'y' }],
      ['device_find', { query: 'x', timeoutMs: 1000 }],
      ['device_is', { predicate: 'gone', selector: 'label="x"' }],
      ['device_is', { predicate: 'text', selector: 'label="x"' }],
      ['device_get', { format: 'html', ref: 'e1' }],
      ['device_get', { format: 'text' }],
      ['device_get', { format: 'text', ref: 'e1', selector: 'label="x"' }],
      ['device_alert', { action: 'tap' }],
      ['device_alert', { action: 'accept', timeoutMs: 1000 }],
      ['device_keyboard', { action: 'type' }],
      ['device_snapshot', { level: 'full' }],
      ['device_is', { predicate: 'visible', selector: 'label="x"\u0007' }],
    ]
    for (const [tool, input] of refused) {
      expect(() => actionOf(tool, input), `${tool} ${JSON.stringify(input)}`).toThrow(
        DeviceArgsError,
      )
    }
  })

  it('rebuilds each batch step from the keys its command takes', () => {
    expect(
      actionOf('device_batch', {
        steps: [
          { command: 'press', input: { ref: 'e12', settle: true } },
          { command: 'fill', input: { selector: 'id="email"', text: 'qa@example.com' } },
          { command: 'fill', input: { ref: '@e3', text: '' } },
          { command: 'scroll', input: { direction: 'down', until: 'label="Privacy"' } },
          { command: 'wait', input: { text: 'Saved', timeoutMs: 3000 } },
          {
            command: 'find',
            input: { query: 'Done', locator: 'label', action: 'click', last: true },
          },
          { command: 'is', input: { predicate: 'visible', selector: 'label="Done"' } },
          { command: 'snapshot', input: { interactiveOnly: true } },
          { command: 'home' },
        ],
        level: 'digest',
      }),
    ).toEqual({
      type: 'batch',
      stopOnError: true,
      level: 'digest',
      steps: [
        { command: 'press', input: { ref: '@e12', settle: true } },
        { command: 'fill', input: { selector: 'id="email"', text: 'qa@example.com' } },
        { command: 'fill', input: { ref: '@e3', text: '' } },
        { command: 'scroll', input: { direction: 'down', until: 'label="Privacy"' } },
        { command: 'wait', input: { text: 'Saved', timeoutMs: 3000 } },
        {
          command: 'find',
          input: { query: 'Done', locator: 'label', action: 'click', last: true },
        },
        { command: 'is', input: { predicate: 'visible', selector: 'label="Done"' } },
        { command: 'snapshot', input: { interactiveOnly: true } },
        { command: 'home', input: {} },
      ],
    })
  })

  it('refuses batch steps outside what it runs', () => {
    const refused: unknown[] = [
      [],
      Array.from({ length: 21 }, () => ({ command: 'home' })),
      [{ command: 'install', input: { path: '/tmp/evil.app' } }],
      [{ command: 'open', input: { app: 'com.apple.Preferences' } }],
      [{ command: 'press', input: { ref: '@e1', session: 'other' } }],
      [{ command: 'press', input: { ref: '@e1', selector: 'label="x"' } }],
      [{ command: 'press', input: {} }],
      [{ command: 'type', input: { text: 'a', out: '/tmp/x' } }],
      [{ command: 'snapshot', input: { scope: 'a\u0000' } }],
      [{ command: 'wait', input: { text: 'a', stable: true } }],
      [{ command: 'home', input: {}, args: ['--help'] }],
      [{ command: 'press', input: 'ref=@e1' }],
      ['press @e1'],
    ]
    for (const steps of refused) {
      expect(() => actionOf('device_batch', { steps }), JSON.stringify(steps)).toThrow(
        DeviceArgsError,
      )
    }
  })

  it('builds recordings, comparisons and diagnostics from checked arguments', () => {
    expect(actionOf('device_record_start', {})).toEqual({ type: 'record_start' })
    expect(actionOf('device_record_start', { name: 'sign-in_flow.v2.mp4' })).toEqual({
      type: 'record_start',
      name: 'sign-in_flow.v2',
    })
    expect(
      actionOf('device_screenshot_compare', {
        baseline: 'tests\\screens\\主页.png',
        threshold: 0,
        update: true,
      }),
    ).toEqual({
      type: 'screenshot_compare',
      baseline: 'tests/screens/主页.png',
      threshold: 0,
      update: true,
    })
    expect(actionOf('device_network', {})).toEqual({
      type: 'network',
      limit: 20,
      include: 'summary',
    })
    expect(actionOf('device_logs', { crashes: false })).toEqual({
      type: 'logs',
      lines: 200,
      crashes: false,
    })
    expect(
      actionOf('device_set_permission', { app: 'com.example', permission: 'all', state: 'reset' }),
    ).toEqual({ type: 'permission', app: 'com.example', permission: 'all', state: 'reset' })
    // The form before reset.
    expect(
      actionOf('device_set_permission', { app: 'com.example', permission: 'camera', grant: false }),
    ).toMatchObject({ state: 'deny' })
    expect(
      actionOf('device_reset_app', { deviceId: SIM, app: 'com.example', keychain: true }),
    ).toEqual({ type: 'reset_app', app: 'com.example', keychain: true })
  })

  it('checks a push payload for the platform it goes to', () => {
    expect(
      actionOf('device_push', { deviceId: SIM, payload: { aps: { alert: 'Hi', badge: 1 } } }),
    ).toEqual({ type: 'push', payload: { aps: { alert: 'Hi', badge: 1 } } })
    expect(
      actionOf('device_push', {
        deviceId: 'android:emulator-5554',
        app: 'com.example',
        payload: {
          action: 'com.example.PUSH',
          receiver: 'com.example/.PushReceiver',
          extras: { title: 'Hi; rm -rf /', count: 2, silent: true },
        },
      }),
    ).toEqual({
      type: 'push',
      app: 'com.example',
      payload: {
        action: 'com.example.PUSH',
        receiver: 'com.example/.PushReceiver',
        extras: { title: 'Hi; rm -rf /', count: 2, silent: true },
      },
    })
  })

  it('refuses paths, names and payloads that could reach past the session folder or a flag', () => {
    const android = 'android:emulator-5554'
    const refused: [Parameters<typeof actionOf>[0], Record<string, unknown>][] = [
      ['device_record_start', { name: '../escape' }],
      ['device_record_start', { name: '--out=/tmp/x' }],
      ['device_record_start', { name: '.hidden' }],
      ['device_record_start', { name: 'a/b' }],
      ['device_screenshot_compare', { baseline: '/etc/passwd.png' }],
      ['device_screenshot_compare', { baseline: 'C:\\Windows\\x.png' }],
      ['device_screenshot_compare', { baseline: '~/x.png' }],
      ['device_screenshot_compare', { baseline: 'screens/../../x.png' }],
      ['device_screenshot_compare', { baseline: '\\\\server\\share\\x.png' }],
      ['device_screenshot_compare', { baseline: 'screens/-x.png' }],
      ['device_screenshot_compare', { baseline: 'screens/home.jpg' }],
      ['device_screenshot_compare', { baseline: 'screens/a:b.png' }],
      ['device_screenshot_compare', { threshold: 2 }],
      ['device_screenshot_compare', { update: true }],
      ['device_network', { limit: 0 }],
      ['device_network', { include: 'all' }],
      ['device_set_permission', { app: 'com.example', permission: 'camera', state: 'revoke' }],
      ['device_set_permission', { app: 'com.example', permission: 'siri', state: 'grant' }],
      [
        'device_set_permission',
        { app: 'com.example', permission: 'camera', state: 'grant', grant: true },
      ],
      ['device_reset_app', { deviceId: SIM, app: '--all' }],
      ['device_reset_app', { deviceId: android, app: 'com.example', keychain: true }],
      ['device_push', { deviceId: SIM, payload: { alert: 'no aps' } }],
      ['device_push', { deviceId: SIM, payload: [] }],
      ['device_push', { deviceId: SIM, payload: { aps: { alert: 'x'.repeat(5000) } } }],
      ['device_push', { deviceId: 'ios:00008110-0001', payload: { aps: {} } }],
      ['device_push', { deviceId: SIM, app: '-x', payload: { aps: {} } }],
      ['device_push', { deviceId: android, payload: { extras: { a: { nested: 1 } } } }],
      ['device_push', { deviceId: android, payload: { extras: { 'a b': 'x' } } }],
      ['device_push', { deviceId: android, payload: { action: '-n evil/.X' } }],
      ['device_push', { deviceId: android, payload: { receiver: 'evil' } }],
      ['device_push', { deviceId: android, payload: { component: 'x' } }],
    ]
    for (const [tool, input] of refused) {
      expect(() => actionOf(tool, input), `${tool} ${JSON.stringify(input)}`).toThrow(
        DeviceArgsError,
      )
    }
  })

  it('answers a malformed call with invalid_params, before the device sees it', async () => {
    const { tools: subject, calls } = tools('session')
    const result = await subject.call(caller, 'device_batch', {
      deviceId: SIM,
      steps: [{ command: 'install', input: {} }],
    })
    expect(result.structuredContent).toMatchObject({ code: 'invalid_params' })
    expect(calls.filter((call) => call.kind === 'action')).toHaveLength(0)
  })
})

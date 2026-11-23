import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ComputerApp, ComputerHold, ComputerUseSettings } from '@shared/computer-use'
import { COMPUTER_APP_WAIT_MS } from '@shared/computer-use'
import { CONTROL_WAIT_MS } from '@shared/control'
import {
  ComputerUse,
  PAUSE_POLL_MS,
  PAUSE_SETTLE_MS,
  type ComputerAsk,
  type ComputerUseDeps,
  type DriverLike,
  type ElevatedDriverLike,
} from './service'
import type { ComputerHelperLike } from './helper'

const APPS = [
  {
    pid: 10,
    name: 'TextEdit',
    bundle_id: 'com.apple.TextEdit',
    launch_path: '/System/Applications/TextEdit.app',
    running: true,
    active: false,
  },
  { pid: 11, name: 'Terminal', bundle_id: 'com.apple.Terminal', running: true, active: false },
  { pid: 12, name: 'Notes', bundle_id: 'com.apple.Notes', running: true, active: false },
  { pid: 13, name: 'Kettu', bundle_id: 'sh.kettu.app', running: true, active: true },
  { pid: 0, name: 'Pages', bundle_id: 'com.apple.iWork.Pages', running: false, active: false },
  {
    pid: 14,
    name: 'File Explorer',
    launch_path: 'C:\\Windows\\explorer.exe',
    running: true,
    active: false,
  },
]

class FakeDriver implements DriverLike {
  calls: { tool: string; args: Record<string, unknown> }[] = []
  /** Huli: what an action answers, when not plain success. */
  act: ((args: Record<string, unknown>) => CallToolResult) | null = null
  /** What `bring_to_front` answers, when not plain success. */
  front: CallToolResult | null = null
  /** The process of the app in front, as `list_apps` reports it. */
  frontPid = 13

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ tool, args })
    if (tool === 'bring_to_front' && this.front) return this.front
    if (tool === 'list_apps') {
      const apps = APPS.map((app) => ({ ...app, active: app.pid === this.frontPid }))
      return { content: [{ type: 'text', text: 'apps' }], structuredContent: { apps } }
    }
    if (tool === 'get_window_state') {
      return {
        content: [
          { type: 'text', text: '[1] button "Save"' },
          { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///tmp/x.png', name: 'x' },
        ],
        structuredContent: {
          snapshot_id: `s${String(args.pid).padStart(8, '0')}`,
          window_title: 'Notes.txt',
          window_bounds: { x: 100, y: 50, width: 400, height: 200 },
          screenshot_width: 800,
          screenshot_height: 400,
          elements: [{ element_index: 1, frame: { x: 140, y: 90, w: 20, h: 20 } }],
        },
      }
    }
    if (this.act && tool !== 'bring_to_front' && tool !== 'list_windows') return this.act(args)
    return { content: [{ type: 'text', text: `${tool} done` }] }
  }

  async stop(): Promise<void> {}

  acted(): string[] {
    return this.calls.map((call) => call.tool).filter((tool) => tool !== 'list_apps')
  }
}

interface Harness {
  service: ComputerUse
  driver: FakeDriver
  settings: ComputerUseSettings
  asked: { sessionId: string; requestId: number; app: ComputerApp; ask?: ComputerAsk }[]
  settled: [number, string][]
  always: ComputerApp[]
  holds: (ComputerHold | null)[]
  notes: string[]
}

function harness(extra: Partial<ComputerUseDeps> = {}): Harness {
  const driver = new FakeDriver()
  const h: Omit<Harness, 'service'> = {
    driver,
    settings: {
      enabled: true,
      allowedApps: [],
      pauseOnUse: true,
      stopShortcut: '',
      allowForeground: true,
      elevated: 'off',
    },
    asked: [],
    settled: [],
    always: [],
    holds: [],
    notes: [],
  }
  const deps: ComputerUseDeps = {
    platform: 'darwin',
    driver,
    self: { pids: [13], ids: ['sh.kettu.app'] },
    settings: () => h.settings,
    turnRefusal: () => null,
    sessionTitle: (sessionId) => `Title of ${sessionId}`,
    asked: (sessionId, requestId, app, ask) =>
      h.asked.push({ sessionId, requestId, app, ...(ask ? { ask } : {}) }),
    settled: (requestId, answer) => h.settled.push([requestId, answer]),
    allowAlways: (app) => h.always.push(app),
    using: () => {},
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    setupAsked: () => {},
    setupDone: () => {},
    setupSettled: () => {},
    stopped: () => {},
    handedBack: (sessionId) => h.notes.push(`${sessionId} handed back`),
    paused: (sessionId, app) => h.notes.push(`${sessionId} paused in ${app}`),
    agent: () => ({ id: 'claude-code', name: 'Claude Code' }),
    held: (hold) => h.holds.push(hold),
    log: () => {},
    ...extra,
  }
  return Object.assign(h, { service: new ComputerUse(deps) })
}

/** Runs a call that asks the user, answering the question once it shows. */
async function answered(
  h: Harness,
  sessionId: string,
  name: string,
  input: unknown,
  decision: 'session' | 'always' | 'deny',
): Promise<CallToolResult> {
  const before = h.asked.length
  const pending = h.service.call(sessionId, name, input)
  await vi.waitFor(() => expect(h.asked.length).toBeGreaterThan(before))
  expect(h.service.answer(h.asked[h.asked.length - 1]!.requestId, decision)).toBe(true)
  return pending
}

function code(result: CallToolResult): unknown {
  return (result.structuredContent as { code?: unknown } | undefined)?.code
}

const READ = { pid: 10, window_id: 1 }

afterEach(() => {
  vi.useRealTimers()
})

describe('approval', () => {
  it('asks on the first use of an app in a session, then not again', async () => {
    const h = harness()
    const first = await answered(h, 'a', 'computer_get_window_state', READ, 'session')
    expect(first.isError).toBeUndefined()
    // Only text and pictures pass; a link to a file of the driver's does not.
    expect(first.content.map((item) => item.type)).toEqual(['text', 'image'])
    expect(h.asked).toEqual([
      { sessionId: 'a', requestId: 1, app: { id: 'com.apple.textedit', name: 'TextEdit' } },
    ])
    expect(h.settled).toEqual([[1, 'session']])
    await h.service.call('a', 'computer_click', { ...READ, x: 5, y: 5 })
    expect(h.asked).toHaveLength(1)
    expect(h.driver.acted()).toEqual(['get_window_state', 'click'])
  })

  it('asks every other session again, and each app on its own', async () => {
    const h = harness()
    await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'session')
    h.service.turnEnded('a')
    await answered(h, 'b', 'computer_list_windows', { pid: 10 }, 'session')
    await answered(h, 'b', 'computer_list_windows', { pid: 12 }, 'session')
    expect(h.asked.map((ask) => [ask.sessionId, ask.app.id])).toEqual([
      ['a', 'com.apple.textedit'],
      ['b', 'com.apple.textedit'],
      ['b', 'com.apple.notes'],
    ])
  })

  it('keeps a denial for the rest of the turn without asking again', async () => {
    const h = harness()
    expect(code(await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'deny'))).toBe(
      'not_allowed',
    )
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 10 }))).toBe(
      'not_allowed',
    )
    expect(h.asked).toHaveLength(1)
    expect(h.driver.acted()).toEqual([])
    h.service.turnEnded('a')
    void h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(2))
  })

  it('hands Always allow to main and asks no more for an app the settings allow', async () => {
    const h = harness()
    await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'always')
    expect(h.always).toEqual([{ id: 'com.apple.textedit', name: 'TextEdit' }])
    h.settings.allowedApps = [{ id: 'com.apple.notes', name: 'Notes' }]
    await h.service.call('a', 'computer_list_windows', { pid: 12 })
    expect(h.asked).toHaveLength(1)
  })

  it('fails a question nobody answers in time', async () => {
    vi.useFakeTimers()
    const h = harness()
    const pending = h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(COMPUTER_APP_WAIT_MS)
    expect(code(await pending)).toBe('not_allowed')
    expect(h.settled).toEqual([[1, 'timeout']])
  })

  it('ends a question when its turn ends', async () => {
    const h = harness()
    const pending = h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.service.turnEnded('a')
    expect(code(await pending)).toBe('not_allowed')
    expect(h.service.answer(1, 'session')).toBe(false)
  })
})

describe('what is never touched', () => {
  it('blocks terminals and Kettu without asking', async () => {
    const h = harness()
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 11 }))).toBe('blocked')
    expect(
      code(await h.service.call('a', 'computer_click', { pid: 13, window_id: 1, x: 1, y: 1 })),
    ).toBe('blocked')
    expect(h.asked).toEqual([])
    expect(h.driver.acted()).toEqual([])
  })

  it('refuses shortcuts and menu items that quit', async () => {
    const h = harness()
    h.settings.allowedApps = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
    expect(
      code(await h.service.call('a', 'computer_hotkey', { ...READ, keys: ['cmd', 'q'] })),
    ).toBe('blocked')
    expect(
      code(
        await h.service.call('a', 'computer_invoke_menu', {
          ...READ,
          path: ['TextEdit', 'Quit TextEdit'],
        }),
      ),
    ).toBe('blocked')
    expect(h.driver.acted()).toEqual([])
  })

  it('takes an element token only from a read of the same app', async () => {
    const h = harness()
    h.settings.allowedApps = [
      { id: 'com.apple.textedit', name: 'TextEdit' },
      { id: 'com.apple.notes', name: 'Notes' },
    ]
    expect(
      code(await h.service.call('a', 'computer_click', { ...READ, element_token: 's00000010:1' })),
    ).toBe('invalid')
    await h.service.call('a', 'computer_get_window_state', READ)
    await h.service.call('a', 'computer_get_window_state', { pid: 12, window_id: 2 })
    expect(
      code(
        await h.service.call('a', 'computer_click', {
          pid: 12,
          window_id: 2,
          element_token: 's00000010:1',
        }),
      ),
    ).toBe('invalid')
    const ok = await h.service.call('a', 'computer_click', {
      ...READ,
      element_token: 's00000010:1',
    })
    expect(ok.isError).toBeUndefined()
  })

  it('does not trust a process id it cannot find', async () => {
    const h = harness()
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 99 }))).toBe('invalid')
    expect(h.asked).toEqual([])
  })
})

describe('who has the app', () => {
  const TEXTEDIT = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
  const last = (h: Harness) => h.holds[h.holds.length - 1]

  it('tells main the window it uses and where each action lands in it', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    const read = await h.service.call('a', 'computer_get_window_state', READ)
    // The frames Kettu asks for are its own; the agent gets the result it always had.
    expect(h.driver.calls.at(-1)?.args.tree_format).toBe('both')
    expect((read.structuredContent as Record<string, unknown>).elements).toBeUndefined()
    expect(last(h)).toMatchObject({
      sessionId: 'a',
      agentName: 'Claude Code',
      app: 'TextEdit',
      window: { pid: 10, id: 1, title: 'Notes.txt' },
      control: 'agent',
      act: null,
    })
    await h.service.call('a', 'computer_click', { ...READ, x: 200, y: 100 })
    expect(last(h)?.act).toEqual({ seq: 1, kind: 'click', x: 0.25, y: 0.25 })
    // An element's centre, from its frame in screen points.
    await h.service.call('a', 'computer_click', { ...READ, element_token: 's00000010:1' })
    expect(last(h)?.act).toEqual({ seq: 2, kind: 'click', x: 0.125, y: 0.25 })
    // A key has no point of its own: the pointer stays where it was.
    await h.service.call('a', 'computer_press_key', { ...READ, key: 'return' })
    expect(last(h)?.act).toEqual({ seq: 3, kind: 'key', x: 0.125, y: 0.25 })
  })

  it('shows the window when only the light above it keeps the driver from confirming', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    const unverified = (focused: number): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: 'bring_to_front: exact window was not verified' }],
      structuredContent: { process_activated: true, observed: { focused_window_id: focused } },
    })
    h.driver.front = unverified(1)
    await expect(h.service.show('a')).resolves.toBeUndefined()
    h.driver.front = unverified(2)
    await expect(h.service.show('a')).rejects.toThrow('not verified')
    await expect(h.service.show('b')).resolves.toBeUndefined()
    expect(h.driver.acted().filter((tool) => tool === 'bring_to_front')).toHaveLength(2)
  })

  it('holds the calls while the user has the app, and goes on when they hand it back', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    expect(last(h)?.control).toBe('you')
    let done = false
    const pending = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    void pending.then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    expect(h.driver.acted()).toEqual(['get_window_state'])
    h.service.handBack('a')
    expect((await pending).isError).toBeUndefined()
    expect(h.driver.acted()).toEqual(['get_window_state', 'click'])
    expect(last(h)?.control).toBe('agent')
    expect(h.notes).toEqual(['a handed back'])
  })

  it('answers a long wait before the harness gives up, without failing', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const pending = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(code(result)).toBe('user_has_control')
    expect(h.driver.acted()).toEqual(['get_window_state'])
    // Holding the app outlasts the hold's own idle limit.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(last(h)?.control).toBe('you')
  })

  it('ends the waiting calls as stopped on Stop and at the end of the turn', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const stopped = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.service.control('a', 'stop')
    expect(code(await stopped)).toBe('stopped')
    expect(last(h)).toBeNull()

    h.service.turnEnded('a')
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const ended = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.service.turnEnded('a')
    expect(code(await ended)).toBe('stopped')
    expect(h.driver.acted().filter((tool) => tool === 'click')).toEqual([])
  })

  it('pauses when the user brings the app it uses to the front, and only then', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.allowedApps = [...TEXTEDIT, { id: 'com.apple.notes', name: 'Notes' }]
    await h.service.call('a', 'computer_get_window_state', READ)
    await vi.advanceTimersByTimeAsync(PAUSE_SETTLE_MS + PAUSE_POLL_MS)
    // Another app in front leaves the agent alone.
    h.driver.frontPid = 12
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2)
    expect(last(h)?.control).toBe('agent')
    h.driver.frontPid = 10
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2)
    expect(last(h)?.control).toBe('you')
    expect(h.notes).toEqual(['a paused in TextEdit'])
    h.service.handBack('a')
    expect(last(h)?.control).toBe('agent')
    // Still in front after Hand back: the app has to leave the front and come back to pause again.
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 4)
    expect(last(h)?.control).toBe('agent')
  })

  it('watches the app again in the next turn, whose first read changes nothing', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.turnEnded('a')
    await h.service.call('a', 'computer_get_window_state', READ)
    await vi.advanceTimersByTimeAsync(PAUSE_SETTLE_MS + PAUSE_POLL_MS)
    h.driver.frontPid = 10
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2)
    expect(last(h)?.control).toBe('you')
  })

  it('does not pause for the app its own call or Show app brought forward, or with the setting off', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2)
    // The app comes forward right after the agent's click.
    await h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    h.driver.frontPid = 10
    await vi.advanceTimersByTimeAsync(PAUSE_SETTLE_MS + PAUSE_POLL_MS * 2)
    expect(last(h)?.control).toBe('agent')
    h.driver.frontPid = 13
    await vi.advanceTimersByTimeAsync(PAUSE_SETTLE_MS + PAUSE_POLL_MS * 2)
    await h.service.show('a')
    h.driver.frontPid = 10
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 2)
    expect(last(h)?.control).toBe('agent')
    h.driver.frontPid = 13
    h.settings.pauseOnUse = false
    h.service.settingsChanged()
    await vi.advanceTimersByTimeAsync(PAUSE_SETTLE_MS * 3)
    h.driver.frontPid = 10
    await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS * 4)
    expect(last(h)?.control).toBe('agent')
    expect(h.notes).toEqual([])
  })

  it('lets only the session holding the computer take it over or hand it back', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('b')
    expect(last(h)?.control).toBe('agent')
    h.service.takeOver('a')
    h.service.handBack('b')
    expect(last(h)?.control).toBe('you')
  })
})

describe('Huli: the foreground', () => {
  const dropped: CallToolResult = {
    isError: true,
    content: [{ type: 'text', text: 'Background delivery is not available' }],
    structuredContent: {
      code: 'background_unavailable',
      effect: 'refused',
      escalation: { recommended: 'foreground' },
    },
  }

  it('tries an action the app dropped once in the foreground, noting it once a turn', async () => {
    const noted: string[] = []
    const h = harness({ foreground: (sessionId, app) => noted.push(`${sessionId} ${app}`) })
    h.settings.allowedApps = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
    h.driver.act = (args) =>
      args.delivery_mode === 'foreground' ? { content: [{ type: 'text', text: 'done' }] } : dropped
    const result = await h.service.call('a', 'computer_scroll', {
      ...READ,
      x: 1,
      y: 1,
      direction: 'down',
    })
    expect(result.isError).toBeUndefined()
    const modes = h.driver.calls.filter((c) => c.tool === 'scroll').map((c) => c.args.delivery_mode)
    expect(modes).toEqual(['background', 'foreground'])
    await h.service.call('a', 'computer_scroll', { ...READ, x: 1, y: 1, direction: 'down' })
    expect(noted).toEqual(['a TextEdit'])
    expect(h.holds.at(-1)?.foreground).toBe(2)
  })

  it('keeps to the background when the setting is off', async () => {
    const h = harness()
    h.settings.allowedApps = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
    h.settings.allowForeground = false
    h.driver.act = () => dropped
    const result = await h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    expect(result.isError).toBe(true)
    expect(h.driver.calls.filter((c) => c.tool === 'click')).toHaveLength(1)
    const asked = await h.service.call('a', 'computer_click', {
      ...READ,
      x: 1,
      y: 1,
      delivery_mode: 'foreground',
    })
    expect(code(asked)).toBe('not_allowed')
    expect(h.driver.calls.filter((c) => c.tool === 'click')).toHaveLength(1)
  })
})

describe('Huli: apps run as administrator', () => {
  class FakeElevated implements ElevatedDriverLike {
    calls: { tool: string; args: Record<string, unknown> }[] = []
    running = true
    onClosed: (() => void) | null = null
    async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
      this.calls.push({ tool, args })
      return { content: [{ type: 'text', text: `${tool} as administrator` }] }
    }
    async stop(): Promise<void> {
      this.running = false
      this.onClosed?.()
    }
  }

  function elevatedHarness(declined = false, ready = { value: true }) {
    const elevated = new FakeElevated()
    const started: number[] = []
    const stops: string[] = []
    const helper: ComputerHelperLike = {
      whoami: async () => ({ sid: 'S-1-5-21-1-2-3-1001', pid: 1, integrity: 0x2000 }),
      elevation: async (pids) => ({
        self: 0x2000,
        pids: Object.fromEntries(
          pids.map((pid) => [
            pid,
            { integrity: pid === 12 || pid === 14 ? 0x3000 : 0x2000, elevated: pid === 12 },
          ]),
        ),
      }),
      ocr: async () => ({ languages: [], width: 1, height: 1, lines: [] }),
      process: async () => ({ image: null, started: null }),
      layout: async () => ({ installDir: 'C:\\x', state: 'current' }),
      install: async () => null,
      uninstall: async () => null,
      elevate: async () => null,
      stop: () => {},
    }
    const h = harness({
      platform: 'win32',
      helper,
      elevatedReady: async () => ready.value,
      elevate: async (pid) => {
        started.push(pid)
        return declined ? null : elevated
      },
      elevatedStopped: (sessionId, app) => stops.push(`${sessionId} ${app}`),
    })
    return { h, elevated, started, stops, helper }
  }

  const NOTES = { pid: 12, window_id: 5 }

  it('marks them in the list of apps', async () => {
    const { h } = elevatedHarness()
    const result = await h.service.call('a', 'computer_list_apps', {})
    const apps = (result.structuredContent as { apps: { pid: number; elevated?: boolean }[] }).apps
    expect(apps.find((app) => app.pid === 12)?.elevated).toBe(true)
    expect(apps.find((app) => app.pid === 10)?.elevated).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('管理员权限运行')
  })

  it('refuses to act in one up front while the setting is off, as without the helper', async () => {
    const { h, started, helper } = elevatedHarness()
    const refused = await h.service.call('a', 'computer_click', { ...NOTES, x: 1, y: 1 })
    expect(code(refused)).toBe('elevated')
    // Word for word as with no elevated helper at all: nothing points at the setting.
    const without = harness({ platform: 'win32', helper, elevate: null })
    const bare = await without.service.call('a', 'computer_click', { ...NOTES, x: 1, y: 1 })
    expect(refused.content).toEqual(bare.content)
    const listed = await h.service.call('a', 'computer_list_apps', {})
    expect(listed.content).toEqual(
      (await without.service.call('a', 'computer_list_apps', {})).content,
    )
    // A read goes on through the normal driver, as before.
    expect(
      (await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')).isError,
    ).toBeFalsy()
    expect(h.asked.map((a) => a.ask)).toEqual([undefined])
    expect(started).toEqual([])
  })

  it('counts always as on only while the helper is installed and current', async () => {
    const ready = { value: false }
    const { h, started, helper } = elevatedHarness(false, ready)
    h.settings.elevated = 'always'
    const refused = await h.service.call('a', 'computer_click', { ...NOTES, x: 1, y: 1 })
    const off = harness({ platform: 'win32', helper, elevate: null })
    const bare = await off.service.call('a', 'computer_click', { ...NOTES, x: 1, y: 1 })
    expect(refused.content).toEqual(bare.content)
    expect(h.asked).toEqual([])
    expect(started).toEqual([])
    ready.value = true
    await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    expect(started).toEqual([12])
  })

  it('checks the setting again once the card is answered, before the prompt', async () => {
    const { h, started } = elevatedHarness()
    h.settings.elevated = 'always'
    const pending = h.service.call('a', 'computer_get_window_state', NOTES)
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.settings.elevated = 'off'
    h.service.answer(h.asked[0]!.requestId, 'session')
    expect(code(await pending)).toBe('elevated')
    expect(started).toEqual([])
  })

  it('narrowed to off, ends a running helper', async () => {
    const { h, elevated } = elevatedHarness()
    h.settings.elevated = 'always'
    await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    h.settings.elevated = 'off'
    h.service.settingsChanged()
    await vi.waitFor(() => expect(elevated.running).toBe(false))
  })

  it('asks once, starts the helper and acts only through it', async () => {
    const { h, elevated, started } = elevatedHarness()
    h.settings.elevated = 'always'
    await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    expect(h.asked[0]?.ask).toEqual({ kind: 'elevated' })
    expect(started).toEqual([12])
    expect(h.holds.at(-1)?.elevated).toBe('Notes')
    // Risky steps are the broker's to confirm in its own window, not a card's.
    await h.service.call('a', 'computer_scroll', { ...NOTES, x: 1, y: 1, direction: 'down' })
    await h.service.call('a', 'computer_press_key', { ...NOTES, key: 'return' })
    expect(h.asked).toHaveLength(1)
    expect(elevated.calls.map((c) => c.tool)).toEqual(['get_window_state', 'scroll', 'press_key'])
    expect(elevated.calls[2]?.args.delivery_mode).toBe('background')
    expect(h.driver.acted()).toEqual([])
    // The helper acts in the background only.
    const front = { ...NOTES, x: 1, y: 1, delivery_mode: 'foreground' }
    expect(code(await h.service.call('a', 'computer_click', front))).toBe('elevated')
    expect(started).toEqual([12])
  })

  it('ends the helper on its Stop for the rest of the turn, and when the turn ends', async () => {
    const { h, elevated, started, stops } = elevatedHarness()
    h.settings.elevated = 'always'
    await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    h.service.stopElevated('a')
    expect(elevated.running).toBe(false)
    expect(stops).toEqual(['a Notes'])
    expect(h.holds.at(-1)?.elevated).toBeNull()
    expect(code(await h.service.call('a', 'computer_get_window_state', NOTES))).toBe('not_allowed')
    h.service.turnEnded('a')
    elevated.running = true
    await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    expect(started).toEqual([12, 12])
    h.service.turnEnded('a')
    expect(elevated.running).toBe(false)
  })

  it('fails when the user says no at the administrator prompt', async () => {
    const { h } = elevatedHarness(true)
    h.settings.elevated = 'always'
    const result = await answered(h, 'a', 'computer_get_window_state', NOTES, 'session')
    expect(code(result)).toBe('not_allowed')
    expect(h.holds.at(-1)?.elevated ?? null).toBeNull()
  })

  it('never drives a program that starts programs as administrator', async () => {
    const { h, started } = elevatedHarness()
    h.settings.elevated = 'always'
    const explorer = { pid: 14, window_id: 6 }
    expect(code(await h.service.call('a', 'computer_get_window_state', explorer))).toBe('blocked')
    expect(h.asked).toEqual([])
    expect(started).toEqual([])
  })

  it('keeps a no on the card for the rest of the turn', async () => {
    const { h, started } = elevatedHarness()
    h.settings.elevated = 'always'
    expect(code(await answered(h, 'a', 'computer_get_window_state', NOTES, 'deny'))).toBe(
      'not_allowed',
    )
    expect(code(await h.service.call('a', 'computer_get_window_state', NOTES))).toBe('not_allowed')
    expect(h.asked).toHaveLength(1)
    expect(started).toEqual([])
  })
})

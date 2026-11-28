import { EventEmitter } from 'node:events'
import type { IpcMainEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

// Each sender's window, a fresh one for any sender not listed.
const windows = vi.hoisted(() => new WeakMap<object, object>())
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const ipcListeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {
    fromWebContents: (contents: object) => windows.get(contents) ?? {},
    getAllWindows: () => [],
  },
  clipboard: {
    read: vi.fn(async () => []),
  },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, listener)
    },
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  },
  nativeTheme: {},
  Notification: class {},
  screen: {},
  shell: {},
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

const { browserTabId, isTrusted, mayUse, registerTrayIpc, whenSettled } = await import('./ipc')
const { watchSubframes } = await import('./subframes')
const { markOverlay, markOwnPage, markPanel } = await import('./window')

const ARTIFACT = 'kettu-artifact://0123456789abcdef0123456789/'

interface FakeFrame {
  parent: FakeFrame | null
  url: string
  origin?: string
  frames: FakeFrame[]
  framesInSubtree: FakeFrame[]
  frameTreeNodeId: number
  processId: number
  routingId: number
}

class FakeContents extends EventEmitter {
  id = 1
  mainFrame: FakeFrame = {
    parent: null,
    url: 'http://localhost:5173/',
    frames: [],
    framesInSubtree: [],
    frameTreeNodeId: 1,
    processId: 1,
    routingId: 1,
  }

  isDestroyed(): boolean {
    return false
  }

  addFrame(): FakeFrame {
    const frame = { ...this.mainFrame, parent: this.mainFrame, url: '', frames: [] }
    frame.frameTreeNodeId = frame.routingId = 2
    this.mainFrame.frames.push(frame)
    this.mainFrame.framesInSubtree = [this.mainFrame, frame]
    this.emit('frame-created', {}, { frame })
    return frame
  }

  commit(frame: FakeFrame, url: string): void {
    frame.origin = url.startsWith(ARTIFACT) ? ARTIFACT.slice(0, -1) : 'http://localhost:5173'
    this.emit('did-frame-navigate', {}, url, 200, 'OK', false, frame.processId, frame.routingId)
  }
}

function eventFrom(contents: FakeContents): IpcMainEvent {
  return { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent
}

function watch(contents: FakeContents): void {
  watchSubframes(contents as unknown as WebContents, {
    isOpenedArtifact: (origin) => origin === ARTIFACT.slice(0, -1),
    onRevoked: () => {},
  })
}

describe('isTrusted', () => {
  it("refuses the app's own page once a frame of it was refused, until it loads again", () => {
    const contents = new FakeContents()
    watch(contents)
    expect(isTrusted(eventFrom(contents))).toBe(true)

    contents.commit(contents.addFrame(), 'about:srcdoc')
    expect(isTrusted(eventFrom(contents))).toBe(false)

    contents.mainFrame.frames = []
    contents.emit('did-navigate', {}, contents.mainFrame.url, -1, '')
    expect(isTrusted(eventFrom(contents))).toBe(true)
  })
})

describe('isTrusted for the page overlay', () => {
  it("refuses a page overlay's page, whatever URL it shows", () => {
    const contents = new FakeContents()
    watch(contents)
    contents.mainFrame.url = 'http://localhost:5173/overlay.html'
    expect(isTrusted(eventFrom(contents))).toBe(false)
    // history.pushState can give it the window page's URL; the contents still tells it apart.
    const moved = new FakeContents()
    watch(moved)
    markOverlay(moved as unknown as WebContents)
    expect(isTrusted(eventFrom(moved))).toBe(false)
  })
})

describe('mayUse', () => {
  it("takes every channel from the window's page and only its own from the panel's", () => {
    const contents = new FakeContents()
    expect(mayUse(eventFrom(contents), 'settings:update')).toBe(true)
    contents.mainFrame.url = 'http://localhost:5173/tray.html'
    for (const channel of [
      'settings:get',
      'remote:status',
      'agent-host:connect',
      'tray:open',
      'tray:host-agents',
    ]) {
      expect(mayUse(eventFrom(contents), channel)).toBe(true)
    }
    for (const channel of [
      'settings:update',
      'shell:open-file',
      'terminal-host:connect',
      'host-sessions:connect',
      'hosts:status',
      'app:get-info',
      'remote:discovery-answer',
      'hosts:pair-discovered',
    ]) {
      expect(mayUse(eventFrom(contents), channel)).toBe(false)
    }
  })

  it("takes no channel from computer use's overlay page", () => {
    const contents = new FakeContents()
    contents.mainFrame.url = 'http://localhost:5173/computer-overlay.html#label'
    for (const channel of [
      'settings:get',
      'agent-host:connect',
      'tray:open',
      'tray:host-agents',
      'app:get-info',
    ]) {
      expect(mayUse(eventFrom(contents), channel)).toBe(false)
    }
  })

  it("takes only the panel's channels from its window, whatever URL its page shows", () => {
    const contents = new FakeContents()
    const window = {}
    windows.set(contents, window)
    markPanel(window as never)
    // history.pushState can give the panel's page the window page's URL.
    expect(mayUse(eventFrom(contents), 'tray:resize')).toBe(true)
    expect(mayUse(eventFrom(contents), 'tray:host-agents')).toBe(true)
    expect(mayUse(eventFrom(contents), 'host-sessions:connect')).toBe(false)
    expect(mayUse(eventFrom(contents), 'hosts:status')).toBe(false)
    expect(mayUse(eventFrom(contents), 'settings:update')).toBe(false)
  })
})

describe('registerTrayIpc', () => {
  it('serves tray:host-agents only to the panel own webContents', async () => {
    const panelContents = new FakeContents()
    panelContents.mainFrame.url = 'http://localhost:5173/tray.html'
    const panelWindow = {}
    windows.set(panelContents, panelWindow)
    markPanel(panelWindow as never)

    const otherContents = new FakeContents()
    const snapshot = vi.fn(() => [{ hostId: 'host-a', agents: [] }])
    const panel = {
      owns: (sender: WebContents) => sender === (panelContents as unknown as WebContents),
      open: vi.fn(),
      quit: vi.fn(),
      hide: vi.fn(),
      resize: vi.fn(),
    }

    registerTrayIpc(panel as never, { snapshot } as never)
    const handler = ipcHandlers.get('tray:host-agents')
    expect(handler).toBeTypeOf('function')

    await expect(handler!(eventFrom(panelContents))).resolves.toEqual([
      { hostId: 'host-a', agents: [] },
    ])
    expect(snapshot).toHaveBeenCalledTimes(1)

    await expect(handler!(eventFrom(otherContents))).rejects.toThrow(/Rejected "tray:host-agents"/)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })
})

describe('whenSettled', () => {
  it('runs at once, with whether the sender is trusted, while no frame is pending', () => {
    const contents = new FakeContents()
    watch(contents)
    expect(whenSettled(eventFrom(contents), (trusted) => trusted)).toBe(true)
  })

  it("holds a call while a frame is pending and runs it once the frame is an artifact's", async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    let answer: boolean | null = null
    const call = whenSettled(eventFrom(contents), (trusted) => (answer = trusted))
    await Promise.resolve()
    expect(answer).toBeNull()
    contents.commit(frame, ARTIFACT)
    await call
    expect(answer).toBe(true)
  })

  it('refuses a held call once the frame turns out to be something else', async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    const call = whenSettled(eventFrom(contents), (trusted) => trusted)
    contents.commit(frame, 'http://localhost:5173/')
    expect(await call).toBe(false)
  })

  it('runs held calls and messages in the order they came', async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    const order: string[] = []
    const call = whenSettled(eventFrom(contents), async () => {
      order.push('call')
      await Promise.resolve()
      order.push('call answered')
    })
    void whenSettled(eventFrom(contents), () => order.push('message'))
    contents.commit(frame, ARTIFACT)
    await call
    expect(order).toEqual(['call', 'message', 'call answered'])
  })
})

describe('browserTabId', () => {
  it('takes the ids main names its tabs', () => {
    expect(browserTabId('t1')).toBe('t1')
    expect(browserTabId('t123456')).toBe('t123456')
  })

  it.each([undefined, null, 1, '', 't', 'x1', 't1 ', 't-1', '../t1', 't1\0', 't'.padEnd(20, '1')])(
    'refuses %j',
    (value) => {
      expect(() => browserTabId(value)).toThrow()
    },
  )
})

describe("Huli: the mini window's and the screenshot overlay's pages", () => {
  const MINI = [
    'settings:get',
    'themes:get',
    'agent-host:connect',
    'mini:show-session',
    'mini:close',
  ]
  const OTHERS = [
    'settings:update',
    'app:get-info',
    'terminal-host:connect',
    'session:export',
    'mini:open',
    'capture:done',
    'tray:open',
  ]

  it('takes only its own channels from the mini window, by its URL or its window', () => {
    const contents = new FakeContents()
    contents.mainFrame.url = 'http://localhost:5173/mini.html'
    for (const channel of MINI) expect(mayUse(eventFrom(contents), channel)).toBe(true)
    for (const channel of OTHERS) expect(mayUse(eventFrom(contents), channel)).toBe(false)
    // history.pushState can give its page the window page's URL; its window still tells it apart.
    const moved = new FakeContents()
    const window = {}
    windows.set(moved, window)
    markOwnPage(window as never, 'mini')
    expect(mayUse(eventFrom(moved), 'mini:close')).toBe(true)
    expect(mayUse(eventFrom(moved), 'settings:update')).toBe(false)
  })

  it('takes only the region or Cancel from the screenshot overlay', () => {
    const contents = new FakeContents()
    const window = {}
    windows.set(contents, window)
    markOwnPage(window as never, 'capture')
    expect(mayUse(eventFrom(contents), 'capture:done')).toBe(true)
    expect(mayUse(eventFrom(contents), 'capture:cancel')).toBe(true)
    for (const channel of [...MINI, ...OTHERS.filter((c) => c !== 'capture:done')]) {
      expect(mayUse(eventFrom(contents), channel)).toBe(false)
    }
  })

  it("lets the window open the mini window, but never send those pages' own calls", () => {
    const contents = new FakeContents()
    expect(mayUse(eventFrom(contents), 'mini:open')).toBe(true)
    for (const channel of ['mini:show-session', 'mini:close', 'capture:done', 'capture:cancel']) {
      expect(mayUse(eventFrom(contents), channel)).toBe(false)
    }
    contents.mainFrame.url = 'http://localhost:5173/tray.html'
    expect(mayUse(eventFrom(contents), 'mini:open')).toBe(false)
  })
})

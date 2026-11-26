import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import type { BrowserToolName } from '@shared/browser'
import { SurfaceControls } from '@shared/control'
import { BrowserCdp } from './cdp'

/** A tab's debugger that records the commands it was sent and answers `{}`. */
class FakeDebugger extends EventEmitter {
  readonly sent: { method: string; params: Record<string, unknown> }[] = []

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    return {}
  }
}

/** The browser's main process side, where `allowed` names the origins pages open unasked. */
function harness(allowed: string[] = ['http://localhost:5173']) {
  const debug = new FakeDebugger()
  const contents = {
    debugger: debug,
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => 'http://localhost:5173/',
    getTitle: () => 'App',
  } as unknown as WebContents
  const cdp = new BrowserCdp({
    tab: () => 't1',
    tabContents: () => contents,
    load: async (_, url) => ({ url, title: 'App' }),
    back: async () => ({ url: '', title: null }),
    reload: async () => ({ url: '', title: null }),
    tabs: async () => ({ text: '', value: {} }),
    resize: async (_, size) => size,
    controls: new SurfaceControls({ changed: () => {} }),
    log: () => {},
    uploadFiles: async () => [],
    askUpload: async () => 'deny',
    mayOpen: (_, url) => allowed.includes(new URL(url).origin),
  })
  cdp.watch('t1', contents, 's1')
  const call = (tool: BrowserToolName, args: Record<string, unknown> = {}) =>
    cdp.call('s1', tool, args, { deadline: Date.now() + 5_000 })
  /** A request the tab paused, and the command that answered it. */
  const pause = async (url: string, resourceType: string) => {
    const requestId = `i${debug.sent.length}`
    debug.emit('message', {}, 'Fetch.requestPaused', {
      requestId,
      networkId: `n${requestId}`,
      resourceType,
      request: { url, method: 'GET', headers: {} },
    })
    await new Promise((done) => setTimeout(done, 10))
    return debug.sent.find((sent) => sent.params.requestId === requestId)?.method
  }
  return { debug, call, pause }
}

describe('network mocking', () => {
  it('pauses requests only while the session has a rule', async () => {
    const { debug, call } = harness()
    await call('browser_route', { action: 'add', url: '/api/', status: 200, body: '{}' })
    expect(debug.sent.filter((s) => s.method === 'Fetch.enable')).toEqual([
      {
        method: 'Fetch.enable',
        params: { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] },
      },
    ])
    await call('browser_route', { action: 'clear' })
    expect(debug.sent.at(-1)?.method).toBe('Fetch.disable')
  })

  it('never serves a page of a site that needs the user’s allow', async () => {
    const { call, pause } = harness(['http://localhost:5173'])
    await call('browser_route', { action: 'add', url: '*', status: 200, body: 'fake sign-in page' })
    expect(await pause('https://bank.example/login', 'Document')).toBe('Fetch.continueRequest')
    expect(await pause('http://localhost:5173/', 'Document')).toBe('Fetch.fulfillRequest')
    // A request the page itself makes is the page's own business.
    expect(await pause('https://api.example/data', 'Fetch')).toBe('Fetch.fulfillRequest')
  })

  it('lets every request it does not mock go on', async () => {
    const { call, pause } = harness()
    await call('browser_route', { action: 'add', url: '/api/users', abort: 'failed' })
    expect(await pause('http://localhost:5173/api/users', 'XHR')).toBe('Fetch.failRequest')
    expect(await pause('http://localhost:5173/app.js', 'Script')).toBe('Fetch.continueRequest')
  })
})

describe('the second batch’s arguments in main', () => {
  it('are checked again before anything reaches the page', async () => {
    const { debug, call } = harness()
    const before = debug.sent.length
    await expect(
      call('browser_route', { action: 'add', url: '/x', headers: { 'X-A': 'a\r\nSet-Cookie: b' } }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(call('browser_emulate', { timezone: '../etc' })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(call('browser_click_at', { x: 1, y: 1 })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(call('browser_storage_state', { action: 'save', name: '' })).rejects.toMatchObject(
      { code: 'invalid' },
    )
    expect(debug.sent.slice(before)).toEqual([])
  })
})

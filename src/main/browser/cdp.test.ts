import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserToolName } from '@shared/browser'
import { SurfaceControls } from '@shared/control'
import { BrowserCdp } from './cdp'
import { REDACTED } from './network'

type Handler = (params: Record<string, unknown>) => unknown

/** A tab's debugger, answering the commands a test names and `{}` to the rest. */
class FakeDebugger extends EventEmitter {
  readonly sent: { method: string; params: Record<string, unknown> }[] = []
  constructor(readonly handlers: Record<string, Handler> = {}) {
    super()
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    const handler = this.handlers[method]
    return handler ? handler(params) : {}
  }
}

function harness(handlers: Record<string, Handler> = {}) {
  const debug = new FakeDebugger({
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
    'Accessibility.getFullAXTree': () => ({ nodes: [] }),
    ...handlers,
  })
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
  })
  cdp.watch('t1', contents)
  const emit = (method: string, params: Record<string, unknown>): void => {
    debug.emit('message', {}, method, params)
  }
  const call = (tool: BrowserToolName, args: Record<string, unknown> = {}) =>
    cdp.call('s1', tool, args, { deadline: Date.now() + 5_000 })
  return { cdp, debug, emit, call }
}

const APP = 'http://localhost:5173/app.js'

describe('the console tool', () => {
  it('reports errors the page threw or left rejected, with their stack', async () => {
    const { emit, call } = harness()
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'ready' }] })
    emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        url: APP,
        lineNumber: 2,
        exception: {
          type: 'object',
          subtype: 'error',
          description: `TypeError: x is not a function\n    at render (${APP}:3:5)`,
        },
        stackTrace: {
          callFrames: [{ functionName: 'render', url: APP, lineNumber: 2, columnNumber: 4 }],
        },
      },
    })
    emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { type: 'string', value: 'offline' },
      },
    })
    const errors = await call('browser_console_messages', { level: 'error' })
    expect(errors.value.messages).toEqual([
      {
        level: 'error',
        text: 'Uncaught TypeError: x is not a function',
        url: APP,
        line: 3,
        stack: `render (${APP}:3:5)`,
      },
      { level: 'error', text: 'Uncaught (in promise) offline', url: '', line: 1 },
    ])
    const all = await call('browser_console_messages')
    expect(all.value.messages).toHaveLength(3)
  })

  it('refuses a level it does not know', async () => {
    const { call } = harness()
    await expect(call('browser_console_messages', { level: 'verbose' })).rejects.toThrow(/level/)
  })
})

describe('the network tools', () => {
  function loaded(
    emit: (method: string, params: Record<string, unknown>) => void,
    request: { id: string; url: string; type: string; status: number; mimeType?: string },
    headers: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ): void {
    emit('Network.requestWillBeSent', {
      requestId: request.id,
      type: request.type,
      timestamp: 10,
      wallTime: 1_700_000_000,
      request: { method: 'POST', url: request.url, headers, ...extra },
    })
    emit('Network.responseReceived', {
      requestId: request.id,
      type: request.type,
      response: {
        status: request.status,
        statusText: 'OK',
        mimeType: request.mimeType ?? 'application/json',
        headers: { 'Set-Cookie': 'sid=s3cr3t; HttpOnly', 'Content-Type': 'application/json' },
      },
    })
    emit('Network.loadingFinished', {
      requestId: request.id,
      encodedDataLength: 120,
      timestamp: 10.2,
    })
  }

  it('lists requests by address, leaving out static resources that loaded', async () => {
    const { emit, call } = harness()
    loaded(emit, { id: '1', url: 'http://localhost:5173/api/login', type: 'Fetch', status: 200 })
    loaded(emit, { id: '2', url: 'http://localhost:5173/logo.png', type: 'Image', status: 200 })
    loaded(emit, { id: '3', url: 'http://localhost:5173/api/cart', type: 'XHR', status: 500 })
    const listed = await call('browser_network_requests')
    expect((listed.value.requests as { id: string }[]).map((request) => request.id)).toEqual([
      '1',
      '3',
    ])
    expect(listed.text).toMatch(/1 loaded image.*left out/)
    const everything = await call('browser_network_requests', { include_static: true })
    expect(everything.value.requests).toHaveLength(3)
    const cart = await call('browser_network_requests', { url: 'API/CART' })
    expect(cart.value.requests).toEqual([
      expect.objectContaining({ id: '3', status: 500, url: 'http://localhost:5173/api/cart' }),
    ])
  })

  it('gives one request with its credentials and secret fields replaced', async () => {
    const { emit, call } = harness({
      'Network.getResponseBody': () => ({
        body: JSON.stringify({ user: 'ann', access_token: 'tok-9f8e' }),
        base64Encoded: false,
      }),
    })
    loaded(
      emit,
      { id: '7', url: 'http://localhost:5173/api/login', type: 'Fetch', status: 200 },
      { Authorization: 'Bearer abc.def', 'Content-Type': 'application/json' },
      { postData: JSON.stringify({ user: 'ann', password: 'hunter2' }), hasPostData: true },
    )
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: '7',
      headers: { Cookie: 'sid=s3cr3t' },
    })
    const result = await call('browser_network_request', { id: '7' })
    expect(result.value).toMatchObject({
      method: 'POST',
      status: 200,
      request_headers: {
        Authorization: `Bearer ${REDACTED}`,
        Cookie: `sid=${REDACTED}`,
        'Content-Type': 'application/json',
      },
      response_headers: { 'Set-Cookie': `sid=${REDACTED}; HttpOnly` },
      timing: expect.objectContaining({ total_ms: 200 }),
    })
    expect(JSON.parse(result.value.request_body as string)).toEqual({
      user: 'ann',
      password: REDACTED,
    })
    expect(JSON.parse(result.value.response_body as string)).toEqual({
      user: 'ann',
      access_token: REDACTED,
    })
    expect(JSON.stringify(result)).not.toMatch(/hunter2|tok-9f8e|s3cr3t|abc\.def/)
  })

  it('says when a request is unknown', async () => {
    const { call } = harness()
    await expect(call('browser_network_request', { id: '404' })).rejects.toThrow(/No request/)
  })
})

/** A page of a main region holding a button and the given lines of text, as the tree reports it. */
function page(texts: string[], buttons = ['Pay']) {
  const nodes: Record<string, unknown>[] = [
    { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'App' }, childIds: ['main'] },
  ]
  const kids: string[] = []
  buttons.forEach((name, i) => {
    kids.push(`b${i}`)
    nodes.push({
      nodeId: `b${i}`,
      parentId: 'main',
      role: { value: 'button' },
      name: { value: name },
      backendDOMNodeId: 100 + i,
    })
  })
  texts.forEach((text, i) => {
    kids.push(`p${i}`, `t${i}`)
    nodes.push(
      { nodeId: `p${i}`, parentId: 'main', role: { value: 'paragraph' }, childIds: [`s${i}`] },
      { nodeId: `s${i}`, parentId: `p${i}`, role: { value: 'StaticText' }, name: { value: text } },
    )
  })
  nodes.push({
    nodeId: 'main',
    parentId: 'root',
    role: { value: 'main' },
    backendDOMNodeId: 10,
    childIds: kids,
  })
  return { nodes }
}

describe('snapshots', () => {
  function pageHarness() {
    let tree = page(['Ready'])
    const harnessed = harness({ 'Accessibility.getFullAXTree': () => tree })
    return { ...harnessed, show: (next: ReturnType<typeof page>) => (tree = next) }
  }

  it('answer an action with what changed since the last one', async () => {
    const { call, show } = pageHarness()
    const items = Array.from({ length: 30 }, (_, i) => `Order ${i} shipped`)
    show(page(items))
    const first = await call('browser_snapshot')
    expect((first.value.snapshot as string).split('\n').slice(0, 4)).toEqual([
      '- Page: App (http://localhost:5173/)',
      '- main [ref=e1]:',
      '  - button "Pay" [ref=e2]',
      '  - paragraph: Order 0 shipped',
    ])
    show(page([...items, 'Card declined']))
    const pressed = await call('browser_press_key', { key: 'Enter' })
    expect(pressed.text).toMatch(/shows what changed/)
    const lines = (pressed.value.snapshot as string).split('\n')
    expect(lines[0]).toBe('- Page: App (http://localhost:5173/)')
    expect(lines[1]).toMatch(/^Changes since your last snapshot/)
    expect(lines.slice(2)).toEqual(['  - main [ref=e1]:', '+   - paragraph: Card declined'])
    const again = await call('browser_press_key', { key: 'Enter' })
    expect(again.value.snapshot).toMatch(/Nothing changed since your last snapshot/)
    // The whole page again, with the refs it had.
    const whole = await call('browser_snapshot')
    expect(whole.value.snapshot).toMatch(/\[ref=e2\]/)
    expect(whole.value.snapshot).toMatch(/- paragraph: Card declined$/)
  })

  it('tell a change on a long page from a line its cap pushed out', async () => {
    const { call, show } = pageHarness()
    const items = Array.from({ length: 2_100 }, (_, i) => `Order ${i}`)
    show(page(items))
    expect((await call('browser_snapshot')).value.snapshot).toMatch(/more lines$/)
    show(page(['Card declined', ...items]))
    const pressed = await call('browser_press_key', { key: 'Enter' })
    const lines = (pressed.value.snapshot as string).split('\n')
    expect(lines.slice(2)).toEqual(['  - main [ref=e1]:', '+   - paragraph: Card declined'])
  })

  it('answer with the whole page when it is as short as the changes', async () => {
    const { call, show } = pageHarness()
    await call('browser_snapshot')
    show(page(['Paid']))
    const pressed = await call('browser_press_key', { key: 'Enter' })
    expect(pressed.value.snapshot).toMatch(/^- Page: .*\n- main \[ref=e1\]:/)
  })

  it('give a new document whole, and its refs anew', async () => {
    const { call, emit, show } = pageHarness()
    await call('browser_snapshot')
    emit('Page.frameNavigated', { frame: { id: 'main' } })
    await expect(call('browser_click', { ref: 'e2' })).rejects.toMatchObject({ code: 'stale_ref' })
    show(page(['Welcome'], ['Start']))
    const pressed = await call('browser_press_key', { key: 'Tab' })
    expect(pressed.value.snapshot).not.toMatch(/Changes since/)
    expect(pressed.value.snapshot).toMatch(/- button "Start" \[ref=e2\]/)
  })

  it('show one element alone, to a depth', async () => {
    const { call } = pageHarness()
    await call('browser_snapshot')
    const scoped = await call('browser_snapshot', { ref: 'e1', depth: 0 })
    expect(scoped.value.snapshot).toBe('- Page: App (http://localhost:5173/)\n- main [ref=e1]: …')
    await expect(call('browser_snapshot', { ref: 'e9' })).rejects.toMatchObject({
      code: 'stale_ref',
    })
  })
})

describe('acting on an element', () => {
  /** A page with the button "Pay" (e2), whose probe answers come from `probes` in turn. */
  function buttonHarness(probes: Record<string, unknown>[]) {
    let next = 0
    const harnessed = harness({
      'Accessibility.getFullAXTree': () => page(['Ready']),
      'DOM.resolveNode': () => ({ object: { objectId: 'button' } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: probes[Math.min(next++, probes.length - 1)] },
      }),
    })
    return { ...harnessed, probed: () => next }
  }

  const ready = {
    connected: true,
    visible: true,
    enabled: true,
    editable: true,
    inside: true,
    covered: null,
    x: 40,
    y: 60,
  }

  it('waits until the element can be clicked, then clicks its centre', async () => {
    const { call, debug, probed } = buttonHarness([
      { ...ready, visible: false },
      { ...ready, covered: 'div#spinner' },
      ready,
    ])
    await call('browser_snapshot')
    const clicked = await call('browser_click', { ref: 'e2', element: 'Pay' })
    expect(clicked.text).toMatch(/^Clicked "Pay"\./)
    expect(probed()).toBe(3)
    const presses = debug.sent.filter(
      (sent) => sent.method === 'Input.dispatchMouseEvent' && sent.params.type === 'mousePressed',
    )
    expect(presses).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ x: 40, y: 60 }) }),
    ])
  })

  it('fails at once on an element the page removed', async () => {
    const { call, debug } = buttonHarness([{ ...ready, connected: false }])
    await call('browser_snapshot')
    await expect(call('browser_click', { ref: 'e2' })).rejects.toMatchObject({
      code: 'stale_ref',
      message: expect.stringMatching(/no longer on the page/),
    })
    expect(debug.sent.some((sent) => sent.method.startsWith('Input.'))).toBe(false)
  })

  it('gives up on one that stays disabled, saying why', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const { call, debug } = buttonHarness([{ ...ready, enabled: false }])
      await call('browser_snapshot')
      const clicking = call('browser_click', { ref: 'e2' })
      const failed = expect(clicking).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringMatching(/ref e2 is disabled\. It still was after 5 s\./),
      })
      await vi.advanceTimersByTimeAsync(6_000)
      await failed
      expect(debug.sent.some((sent) => sent.method.startsWith('Input.'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waiting for the page', () => {
  it('waits for a selector in every frame, each in an isolated world', async () => {
    let polls = 0
    const { call, debug } = harness({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] },
      }),
      'Page.createIsolatedWorld': (params) => ({
        executionContextId: params.frameId === 'main' ? 1 : 2,
      }),
      'Runtime.evaluate': (params) => {
        if (params.contextId === 1) return { result: { value: { matched: 0, visible: 0 } } }
        polls += 1
        return { result: { value: { matched: 1, visible: polls >= 3 ? 1 : 0 } } }
      },
    })
    const waited = await call('browser_wait_for', { selector: '[role=alert]', time: 5 })
    expect(waited.text).toMatch(/^An element matching "\[role=alert\]" is visible\./)
    expect(polls).toBe(3)
    const worlds = debug.sent.filter((sent) => sent.method === 'Page.createIsolatedWorld')
    expect(worlds.map((sent) => sent.params.frameId)).toEqual(['main', 'child'])
    const searched = debug.sent.find((sent) => sent.method === 'Runtime.evaluate')
    expect(searched?.params.expression).toContain('"selector":"[role=alert]"')
  })

  it('finds text in a frame and fails on a selector the page cannot read', async () => {
    const { call } = harness({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] },
      }),
      'Page.createIsolatedWorld': (params) => ({
        executionContextId: params.frameId === 'main' ? 1 : 2,
      }),
      'Runtime.evaluate': (params) => {
        const expression = String(params.expression)
        if (expression.includes('"selector"'))
          return { result: { value: { error: 'bad selector' } } }
        return { result: { value: { found: params.contextId === 2 } } }
      },
    })
    expect((await call('browser_wait_for', { text: 'Inside frame' })).text).toMatch(/appeared/)
    await expect(call('browser_wait_for', { selector: 'a[' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/could not use the selector: bad selector/),
    })
  })

  it('waits for a ref’s element to go', async () => {
    let shown = 2
    const { call } = harness({
      'Accessibility.getFullAXTree': () => page(['Loading']),
      'DOM.resolveNode': () => ({ object: { objectId: 'spinner' } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: { connected: shown-- > 0, visible: true } },
      }),
    })
    await call('browser_snapshot')
    const waited = await call('browser_wait_for', { ref: 'e2', state: 'detached' })
    expect(waited.text).toMatch(/^ref e2 is detached\./)
  })
})

import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
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

// Drives a session's page over the DevTools protocol, on the debugger that BrowserViews attaches
// to every page for its dialogs. The page's snapshot is its accessibility tree; every action is a
// real input event, so a framework that listens for one behaves as it would for the user.

import type { WebContents } from 'electron'
import {
  BROWSER_CONSOLE_LEVELS,
  MAX_SNAPSHOT_DEPTH,
  siteOf,
  type BrowserCallResult,
  type BrowserToolName,
  type UploadAnswer,
} from '@shared/browser'
import {
  ControlWait,
  isControlStep,
  type ControlWaitOptions,
  type SurfaceControls,
  type UploadConsent,
} from '@shared/control'
import {
  consoleCall,
  exceptionEntry,
  logEntry,
  shownAt,
  type ConsoleEntry,
  type ConsoleLevel,
} from './console'
import {
  bodyText,
  isStaticResource,
  isTextType,
  MAX_POST_DATA,
  redactHeaders,
  requestTiming,
  type BodyText,
  type ResourceTiming,
} from './network'
import { buildOutline, mergeFrames, outlineText, RefRegistry, type AXNode } from './outline'
import { isNeverOpened } from './policy'
import { diffOutline } from './snapshot-diff'
import { UploadRefused, type UploadFile } from './upload'

/** How long the network stays quiet before a page counts as settled. */
export const QUIET_MS = 500
/** The longest a page is waited for after an action. */
export const SETTLE_MAX_MS = 5_000
/** A full-page screenshot stops at this height. */
export const MAX_PAGE_HEIGHT = 8_000
/** A screenshot's longer side, in pixels. */
export const MAX_SHOT_SIDE = 2_000
export const MAX_CONSOLE = 200
export const MAX_REQUESTS = 300
/** The longest JSON value browser_evaluate returns. */
export const MAX_VALUE_BYTES = 64 * 1024

const POLL_MS = 50

/** What an action that opened a file chooser adds to its result. */
const CHOOSER_OPENED =
  'It opened a file chooser, which waits for files: give them with browser_upload_file, which ' +
  'asks the user first.'

/** A refused call, with the code an agent reads and text that says what to do. */
export class ToolFailure extends Error {
  constructor(
    readonly code:
      | 'user_has_control'
      | 'stopped'
      | 'not_allowed'
      | 'stale_ref'
      | 'timeout'
      | 'navigation_failed'
      | 'no_page'
      | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'ToolFailure'
  }
}

/** What a navigation ended as. */
export interface LoadOutcome {
  url: string
  title: string | null
}

export interface BrowserCdpDeps {
  /** The agent's tab in the session's browser, which its calls act on; null when none is open. */
  tab(sessionId: string): string | null
  /** A tab's web contents, or null when it has none now. */
  tabContents(tabId: string): WebContents | null
  /** Loads a URL in the agent's tab, making a tab when the browser has none. */
  load(sessionId: string, url: string): Promise<LoadOutcome>
  back(sessionId: string): Promise<LoadOutcome>
  reload(sessionId: string): Promise<LoadOutcome>
  /** `browser_tabs`: lists, opens, selects or closes the session's tabs. */
  tabs(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult>
  /** Who uses each session's page; a call waits there while the user holds it. */
  controls: SurfaceControls
  /** The agent acts on the page, at a point for a click or a field, for its pointer and light. */
  acted?(sessionId: string, at: { x: number; y: number } | null, click: boolean): void
  log(level: 'warn' | 'error', message: string): void
  /** The files a `browser_upload_file` call names, checked; UploadRefused for any other. */
  uploadFiles(paths: unknown): Promise<UploadFile[]>
  /**
   * Asks the user whether the files may go into the session's page at `site`, and settles with
   * their answer, or `timeout` at the call's deadline.
   */
  askUpload(
    sessionId: string,
    ask: Omit<UploadConsent, 'id'>,
    wait: ControlWaitOptions,
  ): Promise<UploadAnswer>
}

interface ConsoleMessage extends ConsoleEntry {
  /** The page's document it was logged under, so `since_navigation` can leave earlier ones out. */
  nav: number
  /** Its place among everything the page logged, for the errors an action reports. */
  seq: number
}

interface NetworkRequest {
  id: string
  method: string
  url: string
  status: number | null
  type: string
  size: number | null
  nav: number
  statusText: string
  mimeType: string
  requestHeaders: Record<string, unknown>
  responseHeaders: Record<string, unknown> | null
  /** The body the page sent, when short enough to come with the event; `hasPostData` says one went. */
  postData: string | null
  hasPostData: boolean
  /** Why it failed, such as net::ERR_CONNECTION_REFUSED; null when it did not. */
  error: string | null
  /** The earlier addresses it was redirected from, each with its status. */
  redirects: string[]
  /** The protocol's monotonic seconds when it was sent and when it ended, and the clock then. */
  sent: number | null
  ended: number | null
  wallTime: number | null
  timing: ResourceTiming | null
  fromCache: boolean
}

/** The last whole outline the agent read of a document, which the next one's changes are from. */
interface Snapshot {
  nav: number
  lines: string[]
}

/** A diff is worth reading over the whole outline only when it is this much shorter. */
const DIFF_SHARE = 0.7

interface PageState {
  nav: number
  loading: boolean
  inFlight: Set<string>
  console: ConsoleMessage[]
  /** How many messages the page logged, and of them the last the agent was told about. */
  logged: number
  reported: number
  requests: NetworkRequest[]
  /** The same requests by id, and headers whose request came after them. */
  requestsById: Map<string, NetworkRequest>
  extraHeaders: Map<
    string,
    { request?: Record<string, unknown>; response?: Record<string, unknown> }
  >
  snapshot: Snapshot | null
  /** The refs of the document's elements, which keep from one snapshot to the next. */
  refs: RefRegistry
  dialogs: string[]
  /** Input events injected right now; the page reports them as it reports the user's. */
  injecting: number
  /** The HTTP status of the main document, as the network saw it. */
  status: number | null
  frameId: string | null
  /** The file chooser the agent's last action opened, which waits for files; null when none. */
  chooser: FileChooser | null
}

interface FileChooser {
  /** The file input's backend node id. */
  backend: number
  multiple: boolean
  /** The document it opened in; one from an earlier document is gone. */
  nav: number
  /** Not yet reported to the agent. */
  fresh: boolean
}

/** Whether a page has settled: nothing loading, nothing in flight, and a quiet network. */
export function hasSettled(
  state: { loading: boolean; inFlight: number; idleSince: number | null },
  now: number,
  quietMs = QUIET_MS,
): boolean {
  if (state.loading || state.inFlight > 0) return false
  return state.idleSince !== null && now - state.idleSince >= quietMs
}

export interface KeyStroke {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  modifiers: number
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
}

const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  enter: { code: 'Enter', vk: 13, text: '\r' },
  return: { code: 'Enter', vk: 13, text: '\r' },
  tab: { code: 'Tab', vk: 9, text: '\t' },
  escape: { code: 'Escape', vk: 27 },
  esc: { code: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', vk: 8 },
  delete: { code: 'Delete', vk: 46 },
  arrowup: { code: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', vk: 39 },
  up: { code: 'ArrowUp', vk: 38 },
  down: { code: 'ArrowDown', vk: 40 },
  left: { code: 'ArrowLeft', vk: 37 },
  right: { code: 'ArrowRight', vk: 39 },
  home: { code: 'Home', vk: 36 },
  end: { code: 'End', vk: 35 },
  pageup: { code: 'PageUp', vk: 33 },
  pagedown: { code: 'PageDown', vk: 34 },
  space: { code: 'Space', vk: 32, text: ' ' },
}

const PUNCTUATION: Record<string, string> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
}

/**
 * A key name or a combination such as `Control+A`, `Shift+Enter` or `Meta+ArrowLeft`, as Chromium's
 * input event takes it. A key that is not one of these is refused, so a typo cannot type text.
 */
export function parseKey(input: string): KeyStroke {
  const parts = input.split('+')
  const last = parts.pop() ?? ''
  let modifiers = 0
  for (const raw of parts) {
    const modifier = MODIFIERS[raw.trim().toLowerCase()]
    if (modifier === undefined) throw new ToolFailure('invalid', `Unknown modifier "${raw}".`)
    modifiers |= modifier
  }
  const key = last.trim()
  if (key === '') throw new ToolFailure('invalid', 'The key is empty.')
  const named = NAMED[key.toLowerCase()]
  if (named) {
    return {
      key: named.code === 'Space' ? ' ' : named.code,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      // A control key sends no text; Enter and Tab do, so the page acts on them.
      ...(named.text !== undefined && (modifiers & 2) === 0 ? { text: named.text } : {}),
      modifiers,
    }
  }
  if (/^f([1-9]|1[0-2])$/i.test(key)) {
    const n = Number(key.slice(1))
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n, modifiers }
  }
  if ([...key].length === 1) {
    const char = key
    const upper = char.toUpperCase()
    const code = /[a-z]/i.test(char)
      ? `Key${upper}`
      : /[0-9]/.test(char)
        ? `Digit${char}`
        : PUNCTUATION[char]
    if (!code) throw new ToolFailure('invalid', `Unknown key "${input}".`)
    const shift = (modifiers & 8) !== 0
    const typed = shift && /[a-z]/i.test(char) ? upper : char
    const vk = /[a-z]/i.test(char)
      ? upper.charCodeAt(0)
      : /[0-9]/.test(char)
        ? char.charCodeAt(0)
        : 0
    return {
      key: typed,
      code,
      windowsVirtualKeyCode: vk,
      ...((modifiers & (2 | 4)) === 0 ? { text: typed } : {}),
      modifiers,
    }
  }
  throw new ToolFailure('invalid', `Unknown key "${input}". Use a key name or a combination.`)
}

/**
 * A navigation an agent asked for: an http(s) address or the empty document. Whether its origin
 * may open is main's to decide, which asks the user for one they have not allowed yet.
 */
export function checkAgentNavigation(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ToolFailure('invalid', `"${url}" is not an absolute URL.`)
  }
  if (parsed.href === 'about:blank') return parsed.href
  if (isNeverOpened(parsed)) {
    throw new ToolFailure('not_allowed', `${parsed.protocol} pages never open in Kettu.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolFailure('not_allowed', `${parsed.protocol} pages never open in Kettu.`)
  }
  return parsed.href
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function failure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) return error
  if (error instanceof ControlWait) return waitFailure(error)
  return new ToolFailure('invalid', (error as Error)?.message ?? String(error))
}

/** What a call that waited on the user says when it returns without acting. */
export function waitFailure(wait: ControlWait): ToolFailure {
  switch (wait.reason) {
    case 'held':
      return new ToolFailure(
        'user_has_control',
        'The user still has control of the browser; call again to keep waiting.',
      )
    case 'asking':
      return new ToolFailure(
        'user_has_control',
        'The user is still doing the step you asked for in the browser; call browser_ask_user again to keep waiting.',
      )
    case 'stopped':
      return new ToolFailure('stopped', 'The user stopped.')
    case 'gone':
      return new ToolFailure(
        'no_page',
        'The page closed. Open one again with browser_navigate if you still need it.',
      )
  }
}

export class BrowserCdp {
  private readonly pages = new Map<string, PageState>()
  /** Each session's calls in flight, by the function that fails one at once. */
  private readonly running = new Map<string, Set<(failure: ToolFailure) => void>>()
  /** How each session's latest call waits on the user, for its steps after the first. */
  private readonly waits = new Map<string, ControlWaitOptions>()
  /**
   * The tab each session's running call acts on, held for the call so that a popup its click
   * opens takes over only once the action is done.
   */
  private readonly acting = new Map<string, string>()

  constructor(private readonly deps: BrowserCdpDeps) {}

  /** A tab's debugger starts handing its events here; the debugger stays attached as it was. */
  watch(tabId: string, contents: WebContents): void {
    if (this.pages.has(tabId)) return
    const page: PageState = {
      nav: 0,
      loading: false,
      inFlight: new Set(),
      console: [],
      logged: 0,
      reported: 0,
      requests: [],
      requestsById: new Map(),
      extraHeaders: new Map(),
      snapshot: null,
      refs: new RefRegistry(),
      dialogs: [],
      injecting: 0,
      status: null,
      frameId: null,
      chooser: null,
    }
    this.pages.set(tabId, page)
    for (const method of [
      'DOM.enable',
      'Runtime.enable',
      'Log.enable',
      'Network.enable',
      'Accessibility.enable',
    ]) {
      void contents.debugger.sendCommand(method).catch(() => {})
    }
    void contents.debugger
      .sendCommand('Page.getFrameTree')
      .then((tree: { frameTree?: { frame?: { id?: string } } }) => {
        page.frameId = tree.frameTree?.frame?.id ?? null
        return tree
      })
      .catch(() => {})
    contents.debugger.on('message', (_event, method, params) => {
      this.event(page, method, params as Record<string, unknown>)
    })
  }

  /** A tab's page is gone. */
  forget(tabId: string): void {
    this.pages.delete(tabId)
  }

  /** The ids of the page's frames, the main one first, then its same-origin children. */
  private async frameIds(sessionId: string): Promise<string[]> {
    const ids: string[] = []
    const visit = (tree: { frame?: { id?: string }; childFrames?: unknown[] }): void => {
      if (typeof tree.frame?.id === 'string') ids.push(tree.frame.id)
      for (const child of (tree.childFrames ?? []) as (typeof tree)[]) visit(child)
    }
    try {
      const tree = await this.send<{
        frameTree?: { frame?: { id?: string }; childFrames?: unknown[] }
      }>(sessionId, 'Page.getFrameTree')
      if (tree.frameTree) visit(tree.frameTree)
    } catch {
      // Without a frame tree the page's own nodes are all there is.
    }
    return ids.length > 0 ? ids : ['']
  }

  /** A dialog a tab's page opened, which views.ts answered at once. */
  dialogOpened(tabId: string, type: string, accepted: boolean): void {
    const page = this.pages.get(tabId)
    if (!page) return
    const noun = type === 'alert' ? 'An alert' : `A ${type}`
    page.dialogs.push(`${noun} dialog was ${accepted ? 'accepted' : 'dismissed'}.`)
  }

  /**
   * Runs a tool call on the session's page and answers its result or throws a ToolFailure. The
   * turn uses the page from the call on; while the user holds it, the call waits as `wait` says.
   */
  async call(
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
    wait: ControlWaitOptions,
  ): Promise<BrowserCallResult> {
    if (tool === 'browser_ask_user') return this.askUser(sessionId, args, wait)
    if (tool !== 'browser_navigate' && tool !== 'browser_tabs') this.pageOf(sessionId)
    let end: () => void
    try {
      end = await this.deps.controls.begin(sessionId, wait)
    } catch (error) {
      throw failure(error)
    }
    this.waits.set(sessionId, wait)
    const tab = this.deps.tab(sessionId)
    const pinned = !this.acting.has(sessionId) && tab !== null
    if (pinned) this.acting.set(sessionId, tab)
    let stop!: (failure: ToolFailure) => void
    const stopped = new Promise<never>((_, reject) => (stop = reject))
    const running = this.running.get(sessionId) ?? new Set()
    this.running.set(sessionId, running)
    running.add(stop)
    try {
      return await Promise.race([this.dispatch(sessionId, tool, args), stopped])
    } catch (error) {
      throw failure(error)
    } finally {
      if (pinned) this.acting.delete(sessionId)
      running.delete(stop)
      if (running.size === 0 && this.running.get(sessionId) === running) {
        this.running.delete(sessionId)
        if (this.waits.get(sessionId) === wait) this.waits.delete(sessionId)
      }
      end()
    }
  }

  /**
   * Asks the user to do a step on the page that only a person can, and waits for Done or Skip.
   * After Done the agent reads the page as the user left it.
   */
  private async askUser(
    sessionId: string,
    args: Record<string, unknown>,
    wait: ControlWaitOptions,
  ): Promise<BrowserCallResult> {
    const contents = this.contentsOf(sessionId)
    const step = isControlStep(args.step) ? args.step : 'other'
    const reason = typeof args.reason === 'string' ? args.reason : ''
    const target = siteOf(contents.getURL())
    let outcome
    try {
      outcome = await this.deps.controls.ask(sessionId, { step, target, reason }, wait)
    } catch (error) {
      throw failure(error)
    }
    if (outcome === 'skipped') {
      return {
        text: 'The user skipped this step. Go on without it, or say in your reply what you need.',
        value: { outcome, url: contents.getURL(), title: contents.getTitle() },
      }
    }
    const result = await this.call(sessionId, 'browser_snapshot', {}, wait)
    return {
      text: `The user did the step and pressed Done. ${result.text}`,
      value: { outcome, ...result.value },
    }
  }

  /**
   * The session's page crashed or stopped responding: its calls in flight fail now, as a command
   * sent to it may never answer and would only end at the call's time limit.
   */
  pageFailed(sessionId: string, kind: 'crashed' | 'unresponsive', message: string): void {
    const code = kind === 'crashed' ? 'no_page' : 'timeout'
    const text = `${message} Reload it with browser_reload, or open another with browser_navigate.`
    for (const stop of this.running.get(sessionId) ?? []) stop(new ToolFailure(code, text))
  }

  private async dispatch(
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    switch (tool) {
      case 'browser_navigate':
        return this.navigate(sessionId, args)
      case 'browser_navigate_back':
        return this.navigateBack(sessionId)
      case 'browser_reload':
        return this.reload(sessionId)
      case 'browser_snapshot':
        return this.snapshotResult(sessionId, args)
      case 'browser_click':
        return this.click(sessionId, args)
      case 'browser_type':
        return this.type(sessionId, args)
      case 'browser_press_key':
        return this.press(sessionId, args)
      case 'browser_scroll':
        return this.scroll(sessionId, args)
      case 'browser_select_option':
        return this.select(sessionId, args)
      case 'browser_take_screenshot':
        return this.screenshot(sessionId, args)
      case 'browser_wait_for':
        return this.waitFor(sessionId, args)
      case 'browser_console_messages':
        return this.consoleMessages(sessionId, args)
      case 'browser_network_requests':
        return this.networkRequests(sessionId, args)
      case 'browser_network_request':
        return this.networkRequest(sessionId, args)
      case 'browser_evaluate':
        return this.evaluate(sessionId, args)
      case 'browser_tabs':
        return this.deps.tabs(sessionId, args)
      case 'browser_upload_file':
        return this.upload(sessionId, args)
      case 'browser_ask_user':
        throw new ToolFailure('invalid', 'browser_ask_user does not run as a page action.')
    }
  }

  /** The state of the agent's tab. */
  private pageOf(sessionId: string): PageState {
    const tab = this.tabOf(sessionId)
    const page = tab === null ? undefined : this.pages.get(tab)
    if (!page) {
      throw new ToolFailure(
        'no_page',
        'This session has no page yet. Use browser_navigate to open one.',
      )
    }
    return page
  }

  private contentsOf(sessionId: string): WebContents {
    this.pageOf(sessionId)
    const tab = this.tabOf(sessionId)
    const contents = tab === null ? null : this.deps.tabContents(tab)
    if (!contents || contents.isDestroyed()) {
      throw new ToolFailure(
        'no_page',
        'This session has no page yet. Use browser_navigate to open one.',
      )
    }
    if (contents.isCrashed()) {
      throw new ToolFailure(
        'no_page',
        'The page crashed. Reload it with browser_reload, or open another with browser_navigate.',
      )
    }
    return contents
  }

  /** The tab the session's call acts on: the one held for the running call, else the agent's. */
  private tabOf(sessionId: string): string | null {
    return this.acting.get(sessionId) ?? this.deps.tab(sessionId)
  }

  /** Waits while the user holds the page, as the session's call in flight waits. */
  private async gate(sessionId: string): Promise<void> {
    const wait = this.waits.get(sessionId)
    if (!wait) return
    await this.deps.controls.gate(sessionId, wait)
  }

  /** Runs one CDP command, once the page is the agent's: the user may hold it meanwhile. */
  private async send<T = Record<string, unknown>>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.gate(sessionId)
    const contents = this.contentsOf(sessionId)
    // Chromium reports an injected input event as it reports the user's, so the pane's input
    // watch must know this one is the agent's.
    const injecting = method.startsWith('Input.')
    const tab = this.tabOf(sessionId)
    const state = tab === null ? undefined : this.pages.get(tab)
    if (injecting && state) state.injecting += 1
    try {
      return (await contents.debugger.sendCommand(method, params)) as T
    } finally {
      if (injecting && state) state.injecting -= 1
    }
  }

  /** Whether an input event a tab's page reports right now is the agent's own. */
  isInjecting(tabId: string): boolean {
    return (this.pages.get(tabId)?.injecting ?? 0) > 0
  }

  private event(page: PageState, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.pushConsole(page, consoleCall(params))
        break
      case 'Log.entryAdded':
        this.pushConsole(page, logEntry(params))
        break
      case 'Runtime.exceptionThrown':
        this.pushConsole(page, exceptionEntry(params))
        break
      case 'Network.requestWillBeSent': {
        const request = (params.request ?? {}) as Record<string, unknown>
        const id = String(params.requestId ?? '')
        if (!id) break
        page.inFlight.add(id)
        const existing = page.requestsById.get(id)
        const redirect = params.redirectResponse as Record<string, unknown> | undefined
        if (existing) {
          // A redirect goes on under the same id, to the address it was sent to.
          if (redirect) {
            existing.redirects.push(`${Number(redirect.status ?? 0)} ${existing.url}`)
            existing.url = String(request.url ?? existing.url)
            existing.method = String(request.method ?? existing.method)
            existing.requestHeaders = objectOf(request.headers)
          }
          break
        }
        const entry: NetworkRequest = {
          id,
          method: String(request.method ?? 'GET'),
          url: String(request.url ?? ''),
          status: null,
          type: String(params.type ?? ''),
          size: null,
          nav: page.nav,
          statusText: '',
          mimeType: '',
          requestHeaders: objectOf(request.headers),
          responseHeaders: null,
          postData:
            typeof request.postData === 'string' && request.postData.length <= MAX_POST_DATA
              ? request.postData
              : null,
          hasPostData: request.hasPostData === true || typeof request.postData === 'string',
          error: null,
          redirects: [],
          sent: numberOr(params.timestamp),
          ended: null,
          wallTime: numberOr(params.wallTime),
          timing: null,
          fromCache: false,
        }
        page.requests.push(entry)
        page.requestsById.set(id, entry)
        const extra = page.extraHeaders.get(id)
        if (extra) {
          page.extraHeaders.delete(id)
          if (extra.request) entry.requestHeaders = { ...entry.requestHeaders, ...extra.request }
          if (extra.response) entry.responseHeaders = extra.response
        }
        this.trimRequests(page)
        break
      }
      case 'Network.requestWillBeSentExtraInfo':
      case 'Network.responseReceivedExtraInfo': {
        // The headers as they went on the wire, cookies too, which may come before the request.
        const id = String(params.requestId ?? '')
        const headers = objectOf(params.headers)
        const side = method === 'Network.requestWillBeSentExtraInfo' ? 'request' : 'response'
        const entry = page.requestsById.get(id)
        if (entry && side === 'request')
          entry.requestHeaders = { ...entry.requestHeaders, ...headers }
        else if (entry) entry.responseHeaders = { ...(entry.responseHeaders ?? {}), ...headers }
        else if (id) {
          page.extraHeaders.set(id, { ...page.extraHeaders.get(id), [side]: headers })
          if (page.extraHeaders.size > MAX_REQUESTS) {
            page.extraHeaders.delete(page.extraHeaders.keys().next().value!)
          }
        }
        break
      }
      case 'Network.responseReceived': {
        const id = String(params.requestId ?? '')
        const response = (params.response ?? {}) as Record<string, unknown>
        const entry = page.requestsById.get(id)
        if (entry) {
          entry.status = Number(response.status ?? 0) || null
          if (!entry.type) entry.type = String(params.type ?? '')
          entry.statusText = String(response.statusText ?? '')
          entry.mimeType = String(response.mimeType ?? '')
          entry.responseHeaders = {
            ...objectOf(response.headers),
            ...(entry.responseHeaders ?? {}),
          }
          entry.timing = (response.timing as ResourceTiming | undefined) ?? null
          entry.fromCache =
            response.fromDiskCache === true ||
            response.fromServiceWorker === true ||
            response.fromPrefetchCache === true
        }
        if (entry?.type === 'Document' && page.status === null) {
          page.status = Number(response.status ?? 0) || null
        }
        break
      }
      case 'Network.loadingFinished': {
        const id = String(params.requestId ?? '')
        page.inFlight.delete(id)
        const entry = page.requestsById.get(id)
        if (entry) {
          entry.size = Number(params.encodedDataLength ?? 0)
          entry.ended = numberOr(params.timestamp)
        }
        break
      }
      case 'Network.loadingFailed': {
        const id = String(params.requestId ?? '')
        page.inFlight.delete(id)
        const entry = page.requestsById.get(id)
        if (entry) {
          entry.ended = numberOr(params.timestamp)
          entry.error =
            params.canceled === true
              ? 'canceled'
              : String(params.blockedReason ?? params.errorText ?? 'failed')
        }
        break
      }
      case 'Page.frameStartedLoading': {
        if (this.isMainFrame(page, params.frameId)) {
          page.loading = true
          page.status = null
        }
        break
      }
      case 'Page.frameStoppedLoading': {
        if (!this.isMainFrame(page, params.frameId)) break
        page.loading = false
        // A popup's document request shows on both pages and ends on one only; once the page
        // stopped loading, no document of its own is still on its way.
        for (const entry of page.requests) {
          if (entry.type === 'Document') page.inFlight.delete(entry.id)
        }
        break
      }
      case 'Page.frameNavigated': {
        const frame = (params.frame ?? {}) as Record<string, unknown>
        if (frame.parentId !== undefined) break
        if (typeof frame.id === 'string') page.frameId = frame.id
        page.nav += 1
        page.snapshot = null
        page.refs = new RefRegistry()
        page.status = null
        page.chooser = null
        break
      }
      case 'Page.fileChooserOpened': {
        // Reported only while views.ts intercepts choosers, that is while the agent holds the tab.
        const backend = params.backendNodeId
        if (typeof backend !== 'number') break
        page.chooser = {
          backend,
          multiple: params.mode === 'selectMultiple',
          nav: page.nav,
          fresh: true,
        }
        break
      }
      default:
        break
    }
  }

  private isMainFrame(page: PageState, frameId: unknown): boolean {
    if (page.frameId === null) return true
    return frameId === undefined || frameId === page.frameId
  }

  private pushConsole(page: PageState, entry: ConsoleEntry): void {
    page.logged += 1
    page.console.push({ ...entry, nav: page.nav, seq: page.logged })
    if (page.console.length > MAX_CONSOLE) page.console.splice(0, page.console.length - MAX_CONSOLE)
  }

  private trimRequests(page: PageState): void {
    while (page.requests.length > MAX_REQUESTS) {
      const dropped = page.requests.shift()
      if (!dropped) continue
      page.inFlight.delete(dropped.id)
      if (page.requestsById.get(dropped.id) === dropped) page.requestsById.delete(dropped.id)
    }
  }

  private async settle(sessionId: string, page: PageState, stop?: () => boolean): Promise<void> {
    const start = Date.now()
    let idleSince: number | null = null
    for (;;) {
      await this.gate(sessionId)
      if (stop?.()) return
      if (
        hasSettled({ loading: page.loading, inFlight: page.inFlight.size, idleSince }, Date.now())
      )
        return
      if (Date.now() - start >= SETTLE_MAX_MS) return
      idleSince = page.loading || page.inFlight.size > 0 ? null : (idleSince ?? Date.now())
      await sleep(POLL_MS)
    }
  }

  /**
   * The page's outline: the whole of it, which the agent's next snapshot of the document is told
   * apart from, or one element's (`root`) to `depth` levels.
   */
  private async capture(
    sessionId: string,
    page: PageState,
    scope: { root?: number; depth?: number } = {},
  ): Promise<{ outline: string; lines: string[]; found: boolean }> {
    // Each frame has a tree of its own, which goes under the element of the frame that holds it.
    let main: AXNode[] | null = null
    const frames: { owner: number | null; nodes: AXNode[] }[] = []
    for (const frameId of await this.frameIds(sessionId)) {
      const tree = await this.send<{ nodes: AXNode[] }>(
        sessionId,
        'Accessibility.getFullAXTree',
        frameId === '' ? {} : { frameId },
      ).catch(() => null)
      if (!tree) continue
      if (main === null) {
        main = tree.nodes
        continue
      }
      const owner = await this.send<{ backendNodeId?: number }>(sessionId, 'DOM.getFrameOwner', {
        frameId,
      }).catch(() => null)
      frames.push({ owner: owner?.backendNodeId ?? null, nodes: tree.nodes })
    }
    const nodes = mergeFrames(main ?? [], frames)
    const contents = this.contentsOf(sessionId)
    const refs = page.refs
    const built = buildOutline(nodes, { refFor: (backend) => refs.refFor(backend), ...scope })
    const url = contents.getURL()
    const title = contents.getTitle() || null
    const text = outlineText({ title, url }, built)
    // The page's line first, then the outline and its "more" line, as the agent read them.
    const lines = text.split('\n')
    if (scope.root === undefined && scope.depth === undefined) {
      page.snapshot = { nav: page.nav, lines }
    }
    return { outline: text, lines, found: built.found }
  }

  /**
   * The outline an action answers with: what changed since the agent's last snapshot of this
   * document when that is much shorter, else the whole of it.
   */
  private async changedOutline(
    sessionId: string,
    page: PageState,
  ): Promise<{ outline: string; diff: boolean }> {
    const before = page.snapshot?.nav === page.nav ? page.snapshot : null
    const { outline, lines } = await this.capture(sessionId, page)
    if (!before) return { outline, diff: false }
    const changes = diffOutline(before.lines.slice(1), lines.slice(1))
    if (changes === null) return { outline, diff: false }
    if (changes.length === 0) {
      return {
        outline: `${lines[0]}\nNothing changed since your last snapshot (browser_snapshot gives the whole page).`,
        diff: true,
      }
    }
    const diff = [
      lines[0]!,
      'Changes since your last snapshot: + added, - removed, under the unchanged elements that ' +
        'hold them; the rest is as it was (browser_snapshot gives the whole page).',
      ...changes,
    ].join('\n')
    if (diff.length > outline.length * DIFF_SHARE) return { outline, diff: false }
    return { outline: diff, diff: true }
  }

  private async snapshotResult(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const contents = this.contentsOf(sessionId)
    const scope: { root?: number; depth?: number } = {}
    if (args.ref !== undefined) scope.root = this.resolveRef(page, String(args.ref))
    if (args.depth !== undefined) {
      const depth = Number(args.depth)
      if (!Number.isInteger(depth) || depth < 0 || depth > MAX_SNAPSHOT_DEPTH) {
        throw new ToolFailure(
          'invalid',
          `depth must be a whole number from 0 to ${MAX_SNAPSHOT_DEPTH}.`,
        )
      }
      scope.depth = depth
    }
    const { outline, found } = await this.capture(sessionId, page, scope)
    if (!found) {
      throw new ToolFailure(
        'stale_ref',
        `${describe(args, 'That element')} is no longer on the page. Take a new snapshot.`,
      )
    }
    const url = contents.getURL()
    const title = contents.getTitle()
    const part = scope.root !== undefined ? ` ${describe(args, 'the element')} of` : ''
    return {
      text: `Snapshotted${part} the page at ${url || 'about:blank'}${title ? `, "${title}"` : ''}${scope.depth === undefined ? '' : `, ${scope.depth} level${scope.depth === 1 ? '' : 's'} deep`}.`,
      value: { url, title, snapshot: outline },
    }
  }

  /** The snapshot every acting tool answers with, after the page settles. */
  private async afterAction(
    sessionId: string,
    page: PageState,
    text: string,
  ): Promise<BrowserCallResult> {
    // A popup the action opened becomes the agent's tab, and the result is that tab's. Its first
    // request shows on the opener too and never ends there, so the opener is not waited for.
    const held = this.acting.get(sessionId)
    const moved = (): string | null => {
      const now = this.deps.tab(sessionId)
      return held !== undefined && now !== null && now !== held ? now : null
    }
    await this.settle(sessionId, page, () => moved() !== null)
    const now = moved()
    const switched = now !== null
    if (switched) this.acting.set(sessionId, now)
    const current = this.pageOf(sessionId)
    if (switched) await this.settle(sessionId, current)
    const contents = this.contentsOf(sessionId)
    // Another tab's outline is new to the agent, so it reads the whole of it.
    const { outline, diff } = switched
      ? { ...(await this.capture(sessionId, current)), diff: false }
      : await this.changedOutline(sessionId, current)
    const url = contents.getURL()
    const title = contents.getTitle()
    const dialogs = page.dialogs.splice(0)
    const chooser = page.chooser?.fresh ? [CHOOSER_OPENED] : []
    if (page.chooser) page.chooser.fresh = false
    // A popup that closed itself is gone; its opener is the agent's tab again.
    const opened = !switched
      ? []
      : held !== undefined && this.pages.has(held)
        ? ['It opened a new tab, which is now your current tab.']
        : ['The page closed itself, and the tab that opened it is your current tab again.']
    return {
      text: [
        text,
        ...dialogs,
        ...chooser,
        ...opened,
        ...newErrors(current),
        ...(diff ? ['The snapshot shows what changed since your last one.'] : []),
      ].join(' '),
      value: { url, title, snapshot: outline },
    }
  }

  private async navigate(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const url = checkAgentNavigation(String(args.url ?? ''))
    let outcome: LoadOutcome
    try {
      outcome = await this.deps.load(sessionId, url)
    } catch (error) {
      const failed = failure(error)
      // A site the user refused keeps its own code; anything else is the page failing to load.
      if (failed.code === 'navigation_failed' || failed.code === 'not_allowed') throw failed
      throw new ToolFailure('navigation_failed', failed.message)
    }
    const page = this.pageOf(sessionId)
    const status = page.status
    await this.settle(sessionId, page)
    const { outline } = await this.capture(sessionId, page)
    const contents = this.contentsOf(sessionId)
    const title = contents.getTitle() || outcome.title
    const shown = contents.getURL() || outcome.url
    const dialogs = page.dialogs.splice(0)
    return {
      text: [
        `Opened ${shown}${title ? `, "${title}"` : ''}${status === null ? '' : ` (HTTP ${status})`}.`,
        ...dialogs,
        ...newErrors(page),
      ].join(' '),
      value: { url: shown, title, status, snapshot: outline },
    }
  }

  private async navigateBack(sessionId: string): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    try {
      await this.deps.back(sessionId)
    } catch (error) {
      throw failure(error)
    }
    return this.afterAction(sessionId, page, 'Went back one page.')
  }

  private async reload(sessionId: string): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    try {
      await this.deps.reload(sessionId)
    } catch (error) {
      throw failure(error)
    }
    return this.afterAction(sessionId, page, 'Reloaded the page.')
  }

  /** The backend id of a snapshot's ref; a ref from an earlier document is stale. */
  private resolveRef(page: PageState, ref: string): number {
    const match = /^e(\d+)$/.exec(ref)
    if (!match) throw new ToolFailure('invalid', `"${ref}" is not a ref such as e12.`)
    const backend = page.refs.backendOf(ref)
    if (backend === undefined) {
      throw new ToolFailure(
        'stale_ref',
        `Ref ${ref} is no longer on the page. Take a new snapshot.`,
      )
    }
    return backend
  }

  /** Runs a function with the element as `this`, which answers by value. */
  private async onElement<T>(
    sessionId: string,
    backend: number,
    source: string,
    args: unknown[] = [],
  ): Promise<T> {
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (!object?.objectId) {
      throw new ToolFailure(
        'stale_ref',
        'That element is no longer on the page. Take a new snapshot.',
      )
    }
    const result = await this.send<{
      result?: { value?: T; objectId?: string }
      exceptionDetails?: { exception?: { description?: string } }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: source,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new ToolFailure(
        'invalid',
        result.exceptionDetails.exception?.description ?? 'The page refused the call.',
      )
    }
    return result.result?.value as T
  }

  private async click(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const double = args.double === true
    const button = clickButton(args.button)
    await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
      () => {},
    )
    // The centre in the top frame's viewport, and what covers it there; a shadow root or a frame
    // is the page's own answer, not a guess from the outline.
    const spot = await this.onElement<{
      x: number
      y: number
      covered: string | null
      inside: boolean
    }>(
      sessionId,
      backend,
      `function () {
        const rect = this.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, covered: null, inside: false }
        let x = rect.x + rect.width / 2
        let y = rect.y + rect.height / 2
        let view = window
        for (let depth = 0; depth < 8 && view !== window.top; depth++) {
          const frame = view.frameElement
          if (!frame) break
          const box = frame.getBoundingClientRect()
          x += box.x
          y += box.y
          view = frame.ownerDocument.defaultView
        }
        const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        let covered = null
        if (at && at !== this && !this.contains(at)) {
          const name = at.tagName ? at.tagName.toLowerCase() : 'element'
          const id = at.id ? '#' + at.id : ''
          const text = (at.innerText || at.textContent || '').trim().slice(0, 60)
          covered = text ? name + id + ' "' + text + '"' : name + id
        }
        const inside =
          x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight
        return { x, y, covered, inside }
      }`,
    )
    if (!spot.inside) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The element')} is not visible on the page. Scroll it into view, then click again.`,
      )
    }
    if (spot.covered !== null) {
      throw new ToolFailure(
        'invalid',
        `The centre of ${describe(args, 'the element')} is covered by ${spot.covered}. Scroll it or close what covers it, then click again.`,
      )
    }
    const { x, y } = spot
    this.deps.acted?.(sessionId, { x, y }, true)
    await this.send(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const clicks = double ? 2 : 1
    for (let count = 1; count <= clicks; count++) {
      await this.send(sessionId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons: buttonMask(button),
        clickCount: count,
      })
      await this.send(sessionId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount: count,
      })
    }
    return this.afterAction(
      sessionId,
      page,
      `Clicked ${describe(args, 'the element')}${double ? ' twice' : ''}.`,
    )
  }

  /** Where an element's centre is in the page's viewport, for the agent's pointer; null if unknown. */
  private async centre(
    sessionId: string,
    backend: number,
  ): Promise<{ x: number; y: number } | null> {
    try {
      const spot = await this.onElement<{ x: number; y: number } | null>(
        sessionId,
        backend,
        `function () {
          const rect = this.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return null
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        }`,
      )
      return spot && Number.isFinite(spot.x) && Number.isFinite(spot.y) ? spot : null
    } catch {
      return null
    }
  }

  private async type(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const text = String(args.text ?? '')
    const slowly = args.slowly === true
    this.deps.acted?.(sessionId, await this.centre(sessionId, backend), false)
    await this.send(sessionId, 'DOM.focus', { backendNodeId: backend })
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (object?.objectId) {
      await this.send(sessionId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          if (typeof this.focus === 'function') this.focus()
          if (typeof this.select === 'function') this.select()
          else if (this.isContentEditable) {
            const range = document.createRange()
            range.selectNodeContents(this)
            const selection = getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }`,
        returnByValue: true,
      }).catch(() => {})
    }
    if (slowly) {
      for (const char of text) {
        await this.send(sessionId, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: char,
          text: char,
        })
        await this.send(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char })
      }
    } else {
      await this.send(sessionId, 'Input.insertText', { text })
    }
    if (args.submit === true) await this.pressKey(sessionId, 'Enter')
    return this.afterAction(
      sessionId,
      page,
      `Typed ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)} into ${describe(args, 'the element')}${args.submit === true ? ' and pressed Enter' : ''}.`,
    )
  }

  private async press(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const key = String(args.key ?? '')
    this.deps.acted?.(sessionId, null, false)
    await this.pressKey(sessionId, key)
    return this.afterAction(sessionId, page, `Pressed ${key}.`)
  }

  private async pressKey(sessionId: string, input: string): Promise<void> {
    const stroke = parseKey(input)
    const base = {
      key: stroke.key,
      code: stroke.code,
      windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
      nativeVirtualKeyCode: stroke.windowsVirtualKeyCode,
      modifiers: stroke.modifiers,
    }
    await this.send(sessionId, 'Input.dispatchKeyEvent', {
      type: stroke.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(stroke.text === undefined ? {} : { text: stroke.text, unmodifiedText: stroke.text }),
    })
    await this.send(sessionId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private async scroll(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const direction = String(args.direction ?? '')
    const amount = args.amount === undefined ? 1 : Number(args.amount)
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new ToolFailure('invalid', 'direction must be up, down, left or right.')
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50) {
      throw new ToolFailure('invalid', 'amount must be a number of screens from 0 to 50.')
    }
    this.deps.acted?.(sessionId, null, false)
    const viewport = await this.viewport(sessionId)
    let x = viewport.width / 2
    let y = viewport.height / 2
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
        () => {},
      )
      const spot = await this.onElement<{ x: number; y: number }>(
        sessionId,
        backend,
        `function () {
          const rect = this.getBoundingClientRect()
          let x = rect.x + rect.width / 2
          let y = rect.y + rect.height / 2
          let view = window
          for (let depth = 0; depth < 8 && view !== window.top; depth++) {
            const frame = view.frameElement
            if (!frame) break
            const box = frame.getBoundingClientRect()
            x += box.x
            y += box.y
            view = frame.ownerDocument.defaultView
          }
          return { x, y }
        }`,
      )
      x = spot.x
      y = spot.y
    }
    const step = amount
    const deltaX =
      direction === 'left'
        ? -step * viewport.width
        : direction === 'right'
          ? step * viewport.width
          : 0
    const deltaY =
      direction === 'up'
        ? -step * viewport.height
        : direction === 'down'
          ? step * viewport.height
          : 0
    await this.send(sessionId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    })
    return this.afterAction(sessionId, page, `Scrolled ${direction} ${amount} screen(s).`)
  }

  private async viewport(sessionId: string): Promise<{ width: number; height: number }> {
    const metrics = await this.send<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
    }>(sessionId, 'Page.getLayoutMetrics')
    const view = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? {}
    return { width: view.clientWidth ?? 1280, height: view.clientHeight ?? 800 }
  }

  private async select(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const values = Array.isArray(args.values) ? args.values.map(String) : []
    if (values.length === 0)
      throw new ToolFailure('invalid', 'values must list at least one option.')
    this.deps.acted?.(sessionId, await this.centre(sessionId, backend), true)
    const { object } = await this.send<{ object: { objectId?: string } }>(
      sessionId,
      'DOM.resolveNode',
      { backendNodeId: backend },
    )
    if (!object?.objectId) {
      throw new ToolFailure(
        'stale_ref',
        'That element is no longer on the page. Take a new snapshot.',
      )
    }
    const result = await this.send<{
      result?: { value?: string | null }
      exceptionDetails?: { exception?: { description?: string } }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function (wanted) {
        if (this.tagName !== 'SELECT') return 'not a select element'
        const options = [...this.options]
        const chosen = options.filter((option) => wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes(option.text))
        if (chosen.length === 0) return 'no option matches ' + wanted.join(', ') + '; the options are: ' + options.map((option) => option.value).join(', ')
        if (!this.multiple) {
          this.value = chosen[0].value
        } else {
          for (const option of options) option.selected = chosen.includes(option)
        }
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return null
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    })
    const refusal = result.result?.value
    if (refusal) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The element')} could not take those values: ${refusal}.`,
      )
    }
    return this.afterAction(
      sessionId,
      page,
      `Selected ${values.map((value) => JSON.stringify(value)).join(', ')} in ${describe(args, 'the element')}.`,
    )
  }

  /**
   * Puts local files into a file input: the one a ref names, or the chooser the agent's last
   * action opened. The user is asked every time, on the page, with the files' names and the
   * page's site; without their Allow nothing reaches the page.
   */
  private async upload(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const contents = this.contentsOf(sessionId)
    const site = siteOf(contents.getURL())
    if (!site) {
      throw new ToolFailure('invalid', 'Files go only into a web page. Open one first.')
    }
    let files: UploadFile[]
    try {
      files = await this.deps.uploadFiles(args.paths)
    } catch (error) {
      if (error instanceof UploadRefused) throw new ToolFailure('invalid', error.message)
      throw error
    }
    const target = await this.uploadTarget(sessionId, page, args)
    if (files.length > 1 && !target.multiple) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The file input')} takes one file. Give one path.`,
      )
    }
    const wait = this.waits.get(sessionId)
    if (!wait) throw new ToolFailure('stopped', 'The call ended before the user was asked.')
    const nav = page.nav
    const names = files.map((file) => JSON.stringify(file.name)).join(', ')
    this.deps.acted?.(sessionId, null, false)
    const answer = await this.deps.askUpload(
      sessionId,
      { site, files: files.map(({ name, size }) => ({ name, size })) },
      wait,
    )
    if (answer !== 'allow') {
      throw new ToolFailure(
        'not_allowed',
        answer === 'deny'
          ? `The user did not allow uploading ${names} to ${site}. Nothing was uploaded; do not ask again unless they say so.`
          : `The user did not answer whether to upload ${names} to ${site}, so nothing was uploaded.`,
      )
    }
    // The answer was for this document; one the page moved to while the user read it gets none.
    await this.gate(sessionId)
    if (page.nav !== nav || siteOf(contents.getURL()) !== site) {
      throw new ToolFailure(
        'not_allowed',
        'The page changed while the user was asked, so nothing was uploaded.',
      )
    }
    await this.send(sessionId, 'DOM.setFileInputFiles', {
      files: files.map((file) => file.path),
      backendNodeId: target.backend,
    })
    if (page.chooser?.backend === target.backend) page.chooser = null
    return this.afterAction(
      sessionId,
      page,
      `Uploaded ${names} into ${describe(args, 'the file chooser')}.`,
    )
  }

  /** The file input an upload goes to, and whether it takes several files. */
  private async uploadTarget(
    sessionId: string,
    page: PageState,
    args: Record<string, unknown>,
  ): Promise<{ backend: number; multiple: boolean }> {
    if (args.ref === undefined) {
      const chooser = page.chooser
      if (!chooser || chooser.nav !== page.nav) {
        throw new ToolFailure(
          'invalid',
          'No file chooser is open. Click the page’s upload button with browser_click first, ' +
            'or give the ref of a file input from the snapshot.',
        )
      }
      return { backend: chooser.backend, multiple: chooser.multiple }
    }
    const backend = this.resolveRef(page, String(args.ref))
    const input = await this.onElement<{ file: boolean; multiple: boolean; disabled: boolean }>(
      sessionId,
      backend,
      `function () {
        const file = String(this.localName).toLowerCase() === 'input' && this.type === 'file'
        return { file, multiple: file && this.multiple, disabled: file && this.disabled }
      }`,
    )
    if (!input?.file) {
      throw new ToolFailure(
        'invalid',
        `${describe(args, 'The element')} is not a file input. Click the page’s upload button ` +
          'with browser_click, then call browser_upload_file without a ref.',
      )
    }
    if (input.disabled) {
      throw new ToolFailure('invalid', `${describe(args, 'The file input')} is disabled.`)
    }
    return { backend, multiple: input.multiple }
  }

  private async screenshot(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const fullPage = args.full_page === true
    let clip: { x: number; y: number; width: number; height: number } | null = null
    let what = 'the page'
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
        () => {},
      )
      // The element's box in the top document, so a capture clips where the element shows.
      const box = await this.onElement<{
        x: number
        y: number
        width: number
        height: number
      }>(
        sessionId,
        backend,
        `function () {
          const rect = this.getBoundingClientRect()
          let x = rect.x
          let y = rect.y
          let view = window
          for (let depth = 0; depth < 8 && view !== window.top; depth++) {
            const frame = view.frameElement
            if (!frame) break
            const outer = frame.getBoundingClientRect()
            x += outer.x
            y += outer.y
            view = frame.ownerDocument.defaultView
          }
          return { x: x + window.scrollX, y: y + window.scrollY, width: rect.width, height: rect.height }
        }`,
      )
      if (box.width <= 0 || box.height <= 0) {
        throw new ToolFailure('invalid', 'That element has no box to capture.')
      }
      clip = box
      what = describe(args, 'the element')
    } else if (fullPage) {
      const metrics = await this.send<{ cssContentSize?: { width?: number; height?: number } }>(
        sessionId,
        'Page.getLayoutMetrics',
      )
      const width = Math.max(1, Math.round(metrics.cssContentSize?.width ?? 0))
      const height = Math.min(
        MAX_PAGE_HEIGHT,
        Math.max(1, Math.round(metrics.cssContentSize?.height ?? 0)),
      )
      clip = { x: 0, y: 0, width, height }
      what = 'the whole page'
    }
    const ratio = await this.devicePixelRatio(sessionId)
    if (!clip) {
      // The viewport is the clip when none was asked for, so its longer side caps too.
      const view = await this.viewport(sessionId)
      const longest = Math.max(view.width, view.height) * ratio
      if (longest > MAX_SHOT_SIDE) {
        clip = { x: 0, y: 0, width: view.width, height: view.height }
      }
    }
    const longest = clip ? Math.max(clip.width, clip.height) * ratio : 0
    const scale = clip && longest > MAX_SHOT_SIDE ? MAX_SHOT_SIDE / longest : 1
    const captured = await this.send<{ data: string }>(sessionId, 'Page.captureScreenshot', {
      format: 'png',
      ...(clip
        ? {
            clip: { ...clip, scale },
            // The viewport clip stays as the user sees it; the others reach past it.
            captureBeyondViewport: args.ref !== undefined || fullPage,
          }
        : { captureBeyondViewport: false }),
    })
    const contents = this.contentsOf(sessionId)
    return {
      text: `Took a screenshot of ${what} at ${contents.getURL() || 'about:blank'}.`,
      value: { url: contents.getURL(), title: contents.getTitle() },
      image: captured.data,
    }
  }

  private async devicePixelRatio(sessionId: string): Promise<number> {
    try {
      const result = await this.send<{ result?: { value?: number } }>(
        sessionId,
        'Runtime.evaluate',
        { expression: 'window.devicePixelRatio', returnByValue: true },
      )
      const ratio = result.result?.value
      return typeof ratio === 'number' && ratio > 0 ? ratio : 1
    } catch {
      return 1
    }
  }

  private async waitFor(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const text = args.text === undefined ? undefined : String(args.text)
    const gone = args.text_gone === undefined ? undefined : String(args.text_gone)
    const seconds = args.time === undefined ? undefined : Number(args.time)
    if (text === undefined && gone === undefined && seconds === undefined) {
      throw new ToolFailure('invalid', 'Give text, text_gone or time to wait for.')
    }
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)) {
      throw new ToolFailure('invalid', 'time must be 0 to 30 seconds.')
    }
    const deadline = Date.now() + (seconds ?? 30) * 1000
    if (text !== undefined || gone !== undefined) {
      let seen: boolean
      for (;;) {
        const body = await this.pageText(sessionId)
        seen = text !== undefined ? body.includes(text) : !body.includes(gone!)
        if (seen || Date.now() >= deadline) break
        await this.gate(sessionId)
        await sleep(100)
      }
      if (!seen) {
        throw new ToolFailure(
          'timeout',
          text !== undefined
            ? `"${text}" did not appear within ${seconds ?? 30} s.`
            : `"${gone}" was still on the page after ${seconds ?? 30} s.`,
        )
      }
    } else {
      const until = Date.now() + (seconds ?? 0) * 1000
      while (Date.now() < until) {
        await this.gate(sessionId)
        await sleep(Math.min(100, Math.max(1, until - Date.now())))
      }
    }
    const contents = this.contentsOf(sessionId)
    const { outline } = await this.capture(sessionId, page)
    return {
      text:
        text !== undefined
          ? `"${text}" appeared.`
          : gone !== undefined
            ? `"${gone}" left the page.`
            : `Waited ${seconds ?? 0} s.`,
      value: { url: contents.getURL(), title: contents.getTitle(), snapshot: outline },
    }
  }

  private async pageText(sessionId: string): Promise<string> {
    const result = await this.send<{ result?: { value?: string } }>(sessionId, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    })
    return result.result?.value ?? ''
  }

  private async consoleMessages(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const since = args.since_navigation === true
    const level = consoleFilter(args.level)
    const messages = page.console
      .filter((message) => (!since || message.nav === page.nav) && shownAt(message.level, level))
      .map(({ level, text, url, line, stack }) => ({
        level,
        text,
        url,
        line,
        ...(stack.length > 0 ? { stack: stack.join('\n') } : {}),
      }))
    page.reported = page.logged
    const which = level === 'all' ? 'console message' : `${level} message`
    return {
      text:
        messages.length === 0
          ? `No ${which}s.`
          : `${messages.length} ${which}${messages.length === 1 ? '' : 's'}, oldest first.`,
      value: { messages },
    }
  }

  private async networkRequests(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const since = args.since_navigation === true
    const wanted = typeof args.url === 'string' ? args.url.toLowerCase() : ''
    const statics = args.include_static === true
    let left = 0
    const requests = page.requests
      .filter((request) => {
        if (since && request.nav !== page.nav) return false
        if (wanted !== '' && !request.url.toLowerCase().includes(wanted)) return false
        if (!statics && isStaticResource(request)) {
          left += 1
          return false
        }
        return true
      })
      .map(({ id, method, url, status, type, size, error }) => ({
        id,
        method,
        url,
        status,
        type,
        size,
        ...(error === null ? {} : { error }),
      }))
    const count =
      requests.length === 0
        ? 'No network requests'
        : `${requests.length} network request${requests.length === 1 ? '' : 's'}, oldest first`
    const statement =
      left === 0
        ? `${count}.`
        : `${count}; ${left} loaded image${left === 1 ? '' : 's'}, script${left === 1 ? '' : 's'} and other static resources left out (include_static shows them).`
    return {
      text: `${statement}${requests.length > 0 ? ' browser_network_request gives one by its id.' : ''}`,
      value: { requests },
    }
  }

  /** One request's headers, status, timing and text bodies, with credentials replaced. */
  private async networkRequest(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const id = String(args.id ?? '')
    const entry = page.requestsById.get(id)
    if (!entry) {
      throw new ToolFailure(
        'invalid',
        `No request ${JSON.stringify(id)} on this page; browser_network_requests lists their ids.`,
      )
    }
    const notes: string[] = []
    const requestType = headerOf(entry.requestHeaders, 'content-type')
    let requestBody: BodyText | null = null
    if (entry.hasPostData) {
      let sent = entry.postData
      if (sent === null) {
        const fetched = await this.send<{ postData?: string }>(
          sessionId,
          'Network.getRequestPostData',
          { requestId: id },
        ).catch(() => null)
        sent = fetched?.postData ?? null
      }
      requestBody =
        sent === null
          ? { text: null, note: 'The browser no longer holds it.' }
          : bodyText(sent, requestType)
      if (requestBody.note) notes.push(`Request body: ${requestBody.note}`)
    }
    let responseBody: BodyText | null = null
    if (entry.error !== null) notes.push(`It failed: ${entry.error}.`)
    else if (entry.ended === null) notes.push('It is still loading, so its body is not here yet.')
    else if (entry.status !== null && entry.status >= 300 && entry.status < 400) {
      // A redirect has no body of its own.
    } else {
      const type = entry.mimeType || headerOf(entry.responseHeaders ?? {}, 'content-type')
      const got = await this.send<{ body?: string; base64Encoded?: boolean }>(
        sessionId,
        'Network.getResponseBody',
        { requestId: id },
      ).catch(() => null)
      if (!got || typeof got.body !== 'string') {
        responseBody = { text: null, note: 'The browser no longer holds it.' }
      } else if (got.base64Encoded) {
        responseBody = isTextType(type)
          ? bodyText(Buffer.from(got.body, 'base64').toString('utf8'), type)
          : bodyText(got.body, type, true)
      } else responseBody = bodyText(got.body, type)
      if (responseBody.note) notes.push(`Response body: ${responseBody.note}`)
    }
    const status = entry.status === null ? 'no response yet' : `HTTP ${entry.status}`
    return {
      text: `${entry.method} ${entry.url}: ${entry.error ?? status}.`,
      value: {
        id,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        status_text: entry.statusText,
        type: entry.type,
        mime_type: entry.mimeType,
        size: entry.size,
        from_cache: entry.fromCache,
        error: entry.error,
        redirects: entry.redirects,
        request_headers: redactHeaders(entry.requestHeaders),
        response_headers:
          entry.responseHeaders === null ? null : redactHeaders(entry.responseHeaders),
        timing: requestTiming(entry),
        request_body: requestBody?.text ?? null,
        response_body: responseBody?.text ?? null,
        notes,
      },
    }
  }

  private async evaluate(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const source = String(args.function ?? '')
    if (source.trim() === '') throw new ToolFailure('invalid', 'function must be JavaScript.')
    let objectId: string | undefined
    if (args.ref !== undefined) {
      const backend = this.resolveRef(page, String(args.ref))
      const resolved = await this.send<{ object: { objectId?: string } }>(
        sessionId,
        'DOM.resolveNode',
        { backendNodeId: backend },
      )
      objectId = resolved.object.objectId
      if (!objectId) {
        throw new ToolFailure(
          'stale_ref',
          'That element is no longer on the page. Take a new snapshot.',
        )
      }
    } else {
      const global = await this.send<{ result?: { objectId?: string } }>(
        sessionId,
        'Runtime.evaluate',
        { expression: 'globalThis' },
      )
      objectId = global.result?.objectId
      if (!objectId) throw new ToolFailure('invalid', 'The page did not answer.')
    }
    const result = await this.send<{
      result?: { value?: unknown; unserializableValue?: string; description?: string }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }>(sessionId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: source,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Error'
      throw new ToolFailure('invalid', `The function failed: ${detail}`)
    }
    const raw = result.result?.value
    let json: string
    try {
      json = JSON.stringify(raw ?? null) ?? 'null'
    } catch {
      json = String(raw)
    }
    if (!json) json = 'null'
    if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
      json = `${json.slice(0, MAX_VALUE_BYTES)}\n… the value was longer than 64 KB`
    }
    const contents = this.contentsOf(sessionId)
    return {
      text: `Ran the function on ${contents.getURL() || 'about:blank'}.`,
      value: { value: json },
    }
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function headerOf(headers: Record<string, unknown>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return String(value)
  }
  return ''
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function consoleFilter(value: unknown): ConsoleLevel {
  if (value === undefined) return 'all'
  if ((BROWSER_CONSOLE_LEVELS as readonly unknown[]).includes(value)) return value as ConsoleLevel
  throw new ToolFailure('invalid', 'level must be error, warn, info or all.')
}

/** The errors the page logged since the agent was last told, for an action's result. */
function newErrors(page: PageState): string[] {
  const errors = page.console.filter(
    (message) =>
      message.seq > page.reported && message.nav === page.nav && message.level === 'error',
  )
  page.reported = page.logged
  if (errors.length === 0) return []
  const first = errors[0]!.text.split('\n')[0]!.slice(0, 200)
  return [
    errors.length === 1
      ? `The page logged an error: ${first}.`
      : `The page logged ${errors.length} errors, the first: ${first}.`,
    'browser_console_messages shows them.',
  ]
}

function describe(args: Record<string, unknown>, fallback: string): string {
  const element = args.element
  if (typeof element === 'string' && element.trim() !== '') return `"${element.trim()}"`
  const ref = args.ref
  return typeof ref === 'string' ? `ref ${ref}` : fallback
}

function clickButton(value: unknown): string {
  if (value === undefined) return 'left'
  if (value === 'left' || value === 'right' || value === 'middle') return value
  throw new ToolFailure('invalid', 'button must be left, right or middle.')
}

function buttonMask(button: string): number {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1
}

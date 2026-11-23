// Drives a session's page over the DevTools protocol, on the debugger that BrowserViews attaches
// to every page for its dialogs. The page's snapshot is its accessibility tree; every action is a
// real input event, so a framework that listens for one behaves as it would for the user.

import type { WebContents } from 'electron'
import {
  BROWSER_CONSOLE_LEVELS,
  BROWSER_WAIT_STATES,
  MAX_SNAPSHOT_DEPTH,
  siteOf,
  type BrowserWaitState,
  type BrowserCallResult,
  type BrowserToolName,
  type UploadAnswer,
} from '@shared/browser'
import {
  BROWSER_ARGS,
  BrowserArgsInvalid,
  clickAtArgs,
  dragArgs,
  emulateArgs,
  isArgsTool,
  pdfArgs,
  routeArgs,
  storageStateArgs,
  traceArgs,
  type BrowserEmulation,
  type EmulationChange,
} from '@shared/browser-args'
import {
  ControlWait,
  isControlStep,
  type ControlWaitOptions,
  type SurfaceControls,
  type UploadConsent,
} from '@shared/control'
import {
  actionProblem,
  AUTO_WAIT_MS,
  pauseBefore,
  PROBE,
  waitedFailure,
  type ActionKind,
  type Probe,
} from './actionability'
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
import { elementMet, SEARCH, selectorMet, type FrameSearch } from './page-wait'
import { diffOutline } from './snapshot-diff'
import { UploadRefused, type UploadFile } from './upload'
import { emulationText, emulationValue } from './emulation'
import { answerFor, mockedLabel, RouteBook, ruleText } from './routes'
import { summarizeTrace, TRACE_CATEGORIES, traceEvents, traceText } from './trace'

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
  /** The scale a tab's page draws at in its view, once the page has its latest size. */
  pointScale?(tabId: string): Promise<number>
  /** Runs a screenshot of a tab's page, which the pane goes on showing as it was meanwhile. */
  steady?<T>(tabId: string, capture: () => Promise<T>): Promise<T>
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
  /** Huli: changes what a tab emulates, and answers what it emulates then. */
  emulate?(tabId: string, change: EmulationChange): Promise<BrowserEmulation>
  /**
   * Huli: whether a page of the session may show `url` without asking the user; a document of a
   * site that needs their allow is never mocked, so a rule cannot make a page pass for that site.
   */
  mayOpen?(sessionId: string, url: string): boolean
  /** Huli: the files the session's pages downloaded. */
  downloads?(sessionId: string): DownloadInfo[]
  /** Huli: writes a file into the session's downloads; null when it has no folder here. */
  saveFile?(sessionId: string, name: string, data: Buffer): Promise<string | null>
  /** Huli: saved sign-in states (browser_storage_state). */
  states?: SavedStateTools
}

/** Huli: a download of the session's pages, as `browser_downloads` lists it. */
export interface DownloadInfo {
  name: string
  path: string | null
  bytes: number
  state: 'waiting' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

/** Huli: what `browser_storage_state` asks of the saved states. */
export interface SavedStateTools {
  save(
    sessionId: string,
    tabId: string,
    name: string,
  ): Promise<{ sites: string[]; cookies: number }>
  restore(
    sessionId: string,
    tabId: string | null,
    name: string,
  ): Promise<{ sites: string[]; cookies: number; storage: number }>
  list(): Promise<{ name: string; sites: string[]; savedAt: number }[]>
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

/**
 * The last whole outline the agent read of a document, which the next one's changes are from: all
 * its lines, past the cap too, so a line the cap pushes out does not read as removed.
 */
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
  /** Huli: the tab's page, whose debugger the rules' paused requests are answered on. */
  contents: WebContents
  /** Huli: the session the tab is in, and whether the agent used it, so its rules apply. */
  session: string | null
  agentUsed: boolean
  /** Huli: the Fetch patterns the tab pauses requests by now, joined; '' while it pauses none. */
  fetchKey: string
  /** Huli: the requests a rule answered, by their network id, with what it did. */
  mocked: Map<string, string>
  /** Huli: settles with the stream of the trace that ended, or null for none. */
  trace: ((stream: string | null) => void) | null
  /** Huli: the data of a drag the page started while drags are intercepted. */
  drag: Record<string, unknown> | null
  /**
   * Huli: the page's frames of other sites, each a target of its own in another process, by the
   * debugger session flattened auto-attach gave it, and by the slot its nodes' ids are kept in.
   */
  children: Map<string, ChildFrame>
  slots: Map<number, ChildFrame>
  nextSlot: number
  /** Huli: whether the tab attaches its frames of other sites, from its first snapshot on. */
  attaching: boolean
  /** Huli: the frame target each element object of such a frame belongs to. */
  objects: Map<string, string>
}

/** Huli: a frame of another site, which Chromium runs in a process of its own. */
interface ChildFrame {
  /** Its flattened debugger session. */
  session: string
  /** Its target's id, which is its frame's id too. */
  targetId: string
  /** The session of the frame that holds it; null for the page itself. */
  parent: string | null
  slot: number
}

/**
 * Huli: a node of a frame of another site is known by its backend id there, which may be any
 * other target's too, plus its frame's slot times this: one number, as refs keep it.
 */
const SLOT = 2 ** 32

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

/** Huli: the tools that need no page, since they read or change the session's own state. */
const PAGELESS = new Set<BrowserToolName>([
  'browser_navigate',
  'browser_tabs',
  'browser_route',
  'browser_downloads',
  'browser_storage_state',
])

/** Huli: the most of a trace read back, past which it is cut rather than held in memory. */
const MAX_TRACE_BYTES = 200 * 1024 * 1024

/** Huli: a PDF's file name, from the page's title or its address. */
export function pdfName(title: string, url: string): string {
  const from = title.trim() || siteOf(url) || 'page'
  const name = from
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  return `${name || 'page'}.pdf`
}

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
  /** Huli: each session's network mocking rules. */
  private readonly routes = new RouteBook()
  /** Huli: what each session's downloads said since the agent's last action, for its result. */
  private readonly downloadNotes = new Map<string, string[]>()

  constructor(private readonly deps: BrowserCdpDeps) {}

  /** A tab's debugger starts handing its events here; the debugger stays attached as it was. */
  watch(tabId: string, contents: WebContents, sessionId: string | null = null): void {
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
      contents,
      session: sessionId,
      // A tab made for the agent, or a popup of its call, takes the session's rules at once.
      agentUsed: sessionId !== null && this.deps.tab(sessionId) === tabId,
      fetchKey: '',
      mocked: new Map(),
      trace: null,
      drag: null,
      children: new Map(),
      slots: new Map(),
      nextSlot: 0,
      attaching: false,
      objects: new Map(),
    }
    this.pages.set(tabId, page)
    if (page.agentUsed) void this.syncRoutes(page)
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
    contents.debugger.on('message', (_event, method, params, session?: string) => {
      this.event(page, method, params as Record<string, unknown>, session || null)
    })
  }

  /**
   * Huli: from the tab's first snapshot on, its frames of other sites attach as targets of their
   * own (`Target.setAutoAttach` with flatten), so their elements read and act as the page's do.
   */
  private async attachFrames(page: PageState): Promise<void> {
    if (page.attaching) return
    page.attaching = true
    await page.contents.debugger
      .sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {
        page.attaching = false
      })
  }

  /** Huli: a frame of another site attached, under the frame whose session `parent` is. */
  private frameAttached(
    page: PageState,
    params: Record<string, unknown>,
    parent: string | null,
  ): void {
    const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string }
    const session = typeof params.sessionId === 'string' ? params.sessionId : null
    if (!session) return
    const command = (method: string, extra: Record<string, unknown> = {}): void => {
      void page.contents.debugger.sendCommand(method, extra, session).catch(() => {})
    }
    if (info.type === 'iframe' && typeof info.targetId === 'string') {
      const frame: ChildFrame = { session, targetId: info.targetId, parent, slot: ++page.nextSlot }
      page.children.set(session, frame)
      page.slots.set(frame.slot, frame)
      // Its own frames of yet other sites attach under it.
      command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    }
    if (params.waitingForDebugger === true) command('Runtime.runIfWaitingForDebugger')
  }

  /** Huli: a frame target went with its frame. */
  private frameDetached(page: PageState, params: Record<string, unknown>): void {
    const frame = typeof params.sessionId === 'string' ? page.children.get(params.sessionId) : null
    if (!frame) return
    page.children.delete(frame.session)
    page.slots.delete(frame.slot)
    for (const [object, session] of page.objects) {
      if (session === frame.session) page.objects.delete(object)
    }
  }

  /** Huli: the frame target a node id names, and its id there; the page's own has none. */
  private nodeTarget(
    page: PageState,
    backend: number,
  ): { target: string | null; backend: number } | null {
    if (backend < SLOT) return { target: null, backend }
    const frame = page.slots.get(Math.floor(backend / SLOT))
    return frame ? { target: frame.session, backend: backend % SLOT } : null
  }

  /**
   * Huli: where a frame of another site's viewport starts in the page's, in CSS pixels: its
   * element's content box in the frame holding it, added up to the page.
   */
  private async frameOffset(
    sessionId: string,
    page: PageState,
    backend: number,
  ): Promise<{ x: number; y: number }> {
    let x = 0
    let y = 0
    let frame = backend < SLOT ? undefined : page.slots.get(Math.floor(backend / SLOT))
    for (let depth = 0; frame && depth < 8; depth++) {
      const holder = frame.parent ?? ''
      const owner = await this.send<{ backendNodeId?: number }>(
        sessionId,
        'DOM.getFrameOwner',
        { frameId: frame.targetId },
        holder,
      )
      if (typeof owner.backendNodeId !== 'number') break
      const box = await this.send<{ model?: { content?: number[] } }>(
        sessionId,
        'DOM.getBoxModel',
        { backendNodeId: owner.backendNodeId },
        holder,
      )
      const content = box.model?.content
      if (!content || content.length < 2) break
      x += content[0]!
      y += content[1]!
      frame = frame.parent ? page.children.get(frame.parent) : undefined
    }
    return { x, y }
  }

  /**
   * Huli: PROBE for an element of a frame of another site gives its centre in that frame's
   * viewport, which the frame's place in the page moves into the page's.
   */
  private async inPage(sessionId: string, backend: number, probe: Probe): Promise<Probe> {
    if (backend < SLOT || !probe.connected) return probe
    const page = this.pageOf(sessionId)
    const offset = await this.frameOffset(sessionId, page, backend)
    const view = await this.viewport(sessionId)
    const x = probe.x + offset.x
    const y = probe.y + offset.y
    return { ...probe, x, y, inside: x >= 0 && y >= 0 && x <= view.width && y <= view.height }
  }

  /** A tab's page is gone. */
  forget(tabId: string): void {
    this.pages.get(tabId)?.trace?.(null)
    this.pages.delete(tabId)
  }

  /** Huli: the session's browser is gone, and its rules with it. */
  forgetSession(sessionId: string): void {
    this.downloadNotes.delete(sessionId)
    if (this.routes.clear(sessionId) > 0) void this.routesChanged(sessionId)
  }

  /** Huli: a download of the session's page started or ended; the agent's next result says so. */
  downloadNote(sessionId: string, note: string): void {
    const notes = this.downloadNotes.get(sessionId) ?? []
    notes.push(note)
    this.downloadNotes.set(sessionId, notes.slice(-10))
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
    // Huli: a frame of another site is read through its own target.
    const tab = this.tabOf(sessionId)
    const page = tab === null ? undefined : this.pages.get(tab)
    const remote = new Set([...(page?.children.values() ?? [])].map((frame) => frame.targetId))
    const local = ids.filter((id, index) => index === 0 || !remote.has(id))
    return local.length > 0 ? local : ['']
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
    // Huli: main checks the second batch's arguments itself, as another computer's host sends
    // calls too; each tool reads them again through its parser.
    if (isArgsTool(tool)) {
      try {
        BROWSER_ARGS[tool](args)
      } catch (error) {
        if (error instanceof BrowserArgsInvalid) throw new ToolFailure('invalid', error.message)
        throw error
      }
    }
    if (!PAGELESS.has(tool)) this.pageOf(sessionId)
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
    // Huli: a tab the agent acts on takes the session's rules from now on.
    const acted = tab === null ? undefined : this.pages.get(tab)
    if (acted && (!acted.agentUsed || acted.session !== sessionId)) {
      acted.agentUsed = true
      acted.session = sessionId
      await this.syncRoutes(acted)
    }
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
      case 'browser_hover':
        return this.hover(sessionId, args)
      case 'browser_drag':
        return this.drag(sessionId, args)
      case 'browser_click_at':
        return this.clickAt(sessionId, args)
      case 'browser_emulate':
        return this.emulate(sessionId, args)
      case 'browser_route':
        return this.route(sessionId, args)
      case 'browser_downloads':
        return this.downloadsResult(sessionId)
      case 'browser_pdf':
        return this.pdf(sessionId, args)
      case 'browser_trace':
        return this.trace(sessionId, args)
      case 'browser_storage_state':
        return this.storageState(sessionId, args)
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

  /**
   * Runs one CDP command, once the page is the agent's: the user may hold it meanwhile. Huli: a
   * command on a node or an object of a frame of another site goes to that frame's target, and
   * `target` names one outright ('' for the page itself).
   */
  private async send<T = Record<string, unknown>>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
    target?: string,
  ): Promise<T> {
    await this.gate(sessionId)
    const contents = this.contentsOf(sessionId)
    const routed = this.routed(sessionId, params, target)
    if (routed.target !== null) {
      const answer = (await contents.debugger.sendCommand(
        method,
        routed.params,
        routed.target,
      )) as T
      const object = (answer as { object?: { objectId?: string } } | null)?.object?.objectId
      const page = this.pageOf(sessionId)
      if (method === 'DOM.resolveNode' && object) {
        page.objects.set(object, routed.target)
        if (page.objects.size > 2_000) page.objects.delete(page.objects.keys().next().value!)
      }
      return answer
    }
    params = routed.params
    // Chromium reports an injected input event as it reports the user's, so the pane's input
    // watch must know this one is the agent's.
    const injecting = method.startsWith('Input.')
    const tab = this.tabOf(sessionId)
    const state = tab === null ? undefined : this.pages.get(tab)
    // A drag event's point is in the page's own CSS pixels, which Chromium scales itself.
    if (method === 'Input.dispatchMouseEvent' && tab !== null && this.deps.pointScale) {
      // The debugger takes the point in the view's pixels, and a page of a fixed size draws
      // scaled there. Nothing runs between reading the scale and sending the event.
      const scale = await this.deps.pointScale(tab)
      if (scale !== 1) {
        params = { ...params, x: Number(params.x) * scale, y: Number(params.y) * scale }
      }
    }
    if (injecting && state) state.injecting += 1
    try {
      return (await contents.debugger.sendCommand(method, params)) as T
    } finally {
      if (injecting && state) state.injecting -= 1
    }
  }

  /** Huli: the frame target a command goes to, and its parameters there; null for the page. */
  private routed(
    sessionId: string,
    params: Record<string, unknown>,
    target: string | undefined,
  ): { target: string | null; params: Record<string, unknown> } {
    if (target !== undefined) return { target: target === '' ? null : target, params }
    const tab = this.tabOf(sessionId)
    const page = tab === null ? undefined : this.pages.get(tab)
    if (!page) return { target: null, params }
    if (typeof params.backendNodeId === 'number' && params.backendNodeId >= SLOT) {
      const node = this.nodeTarget(page, params.backendNodeId)
      if (!node) {
        throw new ToolFailure(
          'stale_ref',
          'That element’s frame is no longer on the page. Take a new snapshot.',
        )
      }
      return { target: node.target, params: { ...params, backendNodeId: node.backend } }
    }
    const object = typeof params.objectId === 'string' ? page.objects.get(params.objectId) : null
    return object ? { target: object, params } : { target: null, params }
  }

  /** Whether an input event a tab's page reports right now is the agent's own. */
  isInjecting(tabId: string): boolean {
    return (this.pages.get(tabId)?.injecting ?? 0) > 0
  }

  private event(
    page: PageState,
    method: string,
    params: Record<string, unknown>,
    child: string | null = null,
  ): void {
    // Huli: frames of other sites attach and go; their own events are not the page's.
    if (method === 'Target.attachedToTarget') return this.frameAttached(page, params, child)
    if (method === 'Target.detachedFromTarget') return this.frameDetached(page, params)
    if (child !== null) return
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
      case 'Fetch.requestPaused':
        void this.paused(page, params)
        break
      case 'Tracing.tracingComplete':
        page.trace?.(typeof params.stream === 'string' ? params.stream : null)
        break
      case 'Input.dragIntercepted':
        page.drag = (params.data as Record<string, unknown> | undefined) ?? null
        break
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
  ): Promise<{ outline: string; head: string; all: string[]; found: boolean }> {
    // Each frame has a tree of its own, which goes under the element of the frame that holds it.
    await this.attachFrames(page)
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
    // Huli: each frame of another site through its own target, its nodes' ids in its slot; a
    // frame holding another comes first, as it attached first.
    for (const frame of page.children.values()) {
      const tree = await this.send<{ nodes: AXNode[] }>(
        sessionId,
        'Accessibility.getFullAXTree',
        {},
        frame.session,
      ).catch(() => null)
      if (!tree) continue
      const owner = await this.send<{ backendNodeId?: number }>(
        sessionId,
        'DOM.getFrameOwner',
        { frameId: frame.targetId },
        frame.parent ?? '',
      ).catch(() => null)
      const holder = frame.parent ? (page.children.get(frame.parent)?.slot ?? 0) : 0
      frames.push({
        owner:
          typeof owner?.backendNodeId === 'number' ? holder * SLOT + owner.backendNodeId : null,
        nodes: tree.nodes.map((node) =>
          node.backendDOMNodeId === undefined
            ? node
            : { ...node, backendDOMNodeId: frame.slot * SLOT + node.backendDOMNodeId },
        ),
      })
    }
    const nodes = mergeFrames(main ?? [], frames)
    const contents = this.contentsOf(sessionId)
    const refs = page.refs
    const built = buildOutline(nodes, { refFor: (backend) => refs.refFor(backend), ...scope })
    const url = contents.getURL()
    const title = contents.getTitle() || null
    const text = outlineText({ title, url }, built)
    if (scope.root === undefined && scope.depth === undefined) {
      page.snapshot = { nav: page.nav, lines: built.all }
    }
    const end = text.indexOf('\n')
    const head = end < 0 ? text : text.slice(0, end)
    return { outline: text, head, all: built.all, found: built.found }
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
    const { outline, head, all } = await this.capture(sessionId, page)
    if (!before) return { outline, diff: false }
    const changes = diffOutline(before.lines, all)
    if (changes === null) return { outline, diff: false }
    if (changes.length === 0) {
      return {
        outline: `${head}\nNothing changed since your last snapshot (browser_snapshot gives the whole page).`,
        diff: true,
      }
    }
    const diff = [
      head,
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
        ...this.takeDownloadNotes(sessionId),
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
    // The centre in the top frame's viewport, once nothing covers it there; a shadow root or a
    // frame is the page's own answer, not a guess from the outline.
    const spot = await this.actionable(sessionId, backend, args, 'click')
    const { x, y } = spot
    this.deps.acted?.(sessionId, { x, y }, true)
    await this.clickPoint(sessionId, x, y, button, double)
    return this.afterAction(
      sessionId,
      page,
      `Clicked ${describe(args, 'the element')}${double ? ' twice' : ''}.`,
    )
  }

  /** Moves to a point and clicks there, once or twice. */
  private async clickPoint(
    sessionId: string,
    x: number,
    y: number,
    button: string,
    double: boolean,
  ): Promise<void> {
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
  }

  /**
   * Waits up to AUTO_WAIT_MS for the element to take the action: on the page, visible, enabled,
   * editable to type, and to click inside the window with nothing over its centre, scrolling it
   * into view on each try.
   */
  private async actionable(
    sessionId: string,
    backend: number,
    args: Record<string, unknown>,
    action: ActionKind,
  ): Promise<Probe> {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      const pause = pauseBefore(attempt)
      if (pause > 0) {
        await this.gate(sessionId)
        await sleep(pause)
      }
      await this.send(sessionId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }).catch(
        () => {},
      )
      // An element the page dropped may be gone from the protocol too.
      const probe = await this.onElement<Probe | null>(sessionId, backend, PROBE, [action]).catch(
        (error: unknown) => {
          if (error instanceof ToolFailure || error instanceof ControlWait) throw error
          return null
        },
      )
      const placed = probe ? await this.inPage(sessionId, backend, probe) : null
      const problem = placed
        ? actionProblem(placed, action)
        : actionProblem({ connected: false } as Probe, action)
      if (!problem) return placed!
      if (!problem.retry || Date.now() - started >= AUTO_WAIT_MS) {
        throw new ToolFailure(
          problem.code,
          waitedFailure(describe(args, 'The element'), problem, attempt > 0),
        )
      }
    }
  }

  private async type(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const text = String(args.text ?? '')
    const slowly = args.slowly === true
    const spot = await this.actionable(sessionId, backend, args, 'type')
    this.deps.acted?.(sessionId, { x: spot.x, y: spot.y }, false)
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
      // Huli: a field of a frame of another site takes its text through that frame's target.
      const node = this.nodeTarget(page, backend)
      await this.send(sessionId, 'Input.insertText', { text }, node?.target ?? '')
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
    const spot = await this.actionable(sessionId, backend, args, 'select')
    this.deps.acted?.(sessionId, { x: spot.x, y: spot.y }, true)
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
    const capture = (): Promise<{ data: string }> =>
      this.send<{ data: string }>(sessionId, 'Page.captureScreenshot', {
        format: 'png',
        ...(clip
          ? {
              clip: { ...clip, scale },
              // The viewport clip stays as the user sees it; the others reach past it.
              captureBeyondViewport: args.ref !== undefined || fullPage,
            }
          : { captureBeyondViewport: false }),
      })
    const tab = this.tabOf(sessionId)
    const captured =
      tab !== null && this.deps.steady ? await this.deps.steady(tab, capture) : await capture()
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
    const selector = args.selector === undefined ? undefined : String(args.selector)
    const ref = args.ref === undefined ? undefined : String(args.ref)
    const seconds = args.time === undefined ? undefined : Number(args.time)
    const state = waitState(args.state)
    const conditions = [text, gone, selector, ref].filter((given) => given !== undefined)
    if (conditions.length === 0 && seconds === undefined) {
      throw new ToolFailure('invalid', 'Give text, text_gone, selector, ref or time to wait for.')
    }
    if (conditions.length > 1) {
      throw new ToolFailure('invalid', 'Give one of text, text_gone, selector and ref.')
    }
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)) {
      throw new ToolFailure('invalid', 'time must be 0 to 30 seconds.')
    }
    const backend = ref === undefined ? undefined : this.resolveRef(page, ref)
    const limit = seconds ?? 30
    const deadline = Date.now() + limit * 1000
    let said: string
    if (conditions.length > 0) {
      // Each frame's own isolated world, which the page's scripts cannot change.
      const worlds = new Map<string, number | null>()
      let met: boolean
      for (;;) {
        if (backend !== undefined) {
          const shown = await this.onElement<{ connected: boolean; visible: boolean } | null>(
            sessionId,
            backend,
            `function () {
              if (!this.isConnected || this.nodeType !== 1) return { connected: false, visible: false }
              const rect = this.getBoundingClientRect()
              const visible = rect.width > 0 && rect.height > 0 &&
                getComputedStyle(this).visibility !== 'hidden' &&
                (typeof this.checkVisibility !== 'function' || this.checkVisibility({ visibilityProperty: true }))
              return { connected: true, visible }
            }`,
          ).catch(() => null)
          met = elementMet(state, shown?.connected ?? false, shown?.visible ?? false)
        } else {
          const query = selector !== undefined ? { selector } : { text: text ?? gone }
          const frames = await this.searchFrames(sessionId, worlds, query)
          const failed = frames.find((frame): frame is { error: string } => 'error' in frame)
          if (failed) {
            throw new ToolFailure('invalid', `The page could not use the selector: ${failed.error}`)
          }
          if (selector !== undefined) {
            let matched = 0
            let visible = 0
            for (const frame of frames) {
              if ('matched' in frame) {
                matched += frame.matched
                visible += frame.visible
              }
            }
            met = selectorMet(state, matched, visible)
          } else {
            const found = frames.some((frame) => 'found' in frame && frame.found)
            met = text !== undefined ? found : !found
          }
        }
        if (met || Date.now() >= deadline) break
        await this.gate(sessionId)
        await sleep(100)
      }
      const what =
        text !== undefined
          ? `"${text}"`
          : gone !== undefined
            ? `"${gone}"`
            : selector !== undefined
              ? `An element matching ${JSON.stringify(selector)}`
              : describe(args, 'The element')
      if (!met) {
        throw new ToolFailure(
          'timeout',
          text !== undefined
            ? `${what} did not appear within ${limit} s.`
            : gone !== undefined
              ? `${what} was still on the page after ${limit} s.`
              : `${what} was not ${state} within ${limit} s.`,
        )
      }
      said =
        text !== undefined
          ? `${what} appeared.`
          : gone !== undefined
            ? `${what} left the page.`
            : `${what} is ${state}.`
    } else {
      const until = Date.now() + (seconds ?? 0) * 1000
      while (Date.now() < until) {
        await this.gate(sessionId)
        await sleep(Math.min(100, Math.max(1, until - Date.now())))
      }
      said = `Waited ${seconds ?? 0} s.`
    }
    const contents = this.contentsOf(sessionId)
    const { outline, diff } = await this.changedOutline(sessionId, page)
    return {
      text: [
        said,
        ...newErrors(page),
        ...(diff ? ['The snapshot shows what changed since your last one.'] : []),
      ].join(' '),
      value: { url: contents.getURL(), title: contents.getTitle(), snapshot: outline },
    }
  }

  /**
   * SEARCH in every frame of the page that answers, each in an isolated world of its own, which
   * `worlds` keeps for the wait; a frame without one is searched in its page's own world.
   */
  private async searchFrames(
    sessionId: string,
    worlds: Map<string, number | null>,
    query: { text?: string; selector?: string },
  ): Promise<FrameSearch[]> {
    const expression = `(${SEARCH})(${JSON.stringify(query)})`
    const results: FrameSearch[] = []
    for (const frameId of await this.frameIds(sessionId)) {
      let context = worlds.get(frameId)
      if (context === undefined) {
        const world =
          frameId === ''
            ? null
            : await this.send<{ executionContextId?: number }>(
                sessionId,
                'Page.createIsolatedWorld',
                { frameId, worldName: 'kite-wait' },
              ).catch(() => null)
        context = world?.executionContextId ?? null
        worlds.set(frameId, context)
      }
      const answer = await this.send<{ result?: { value?: FrameSearch } }>(
        sessionId,
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          ...(context === null ? {} : { contextId: context }),
        },
      ).catch(() => {
        // A world goes with its document; the next try makes the frame a new one.
        worlds.delete(frameId)
        return null
      })
      const value = answer?.result?.value
      if (value && typeof value === 'object') results.push(value)
    }
    return results
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
      .map(({ id, method, url, status, type, size, error }) => {
        const mocked = page.mocked.get(id)
        return {
          id,
          method,
          url,
          status,
          type,
          size,
          ...(error === null ? {} : { error }),
          ...(mocked === undefined ? {} : { mocked }),
        }
      })
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
        notes: page.mocked.has(id) ? [`It was ${page.mocked.get(id)!}.`, ...notes] : notes,
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

  // --- Huli: the second batch ---------------------------------------------------------------------

  private takeDownloadNotes(sessionId: string): string[] {
    const notes = this.downloadNotes.get(sessionId) ?? []
    this.downloadNotes.delete(sessionId)
    return notes
  }

  /** What the page says of an element now, without scrolling it; a gone one is not connected. */
  private async probe(sessionId: string, backend: number, action: ActionKind): Promise<Probe> {
    const probe = await this.onElement<Probe | null>(sessionId, backend, PROBE, [action]).catch(
      (error: unknown) => {
        if (error instanceof ToolFailure || error instanceof ControlWait) throw error
        return null
      },
    )
    return probe ? this.inPage(sessionId, backend, probe) : ({ connected: false } as Probe)
  }

  private async hover(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const page = this.pageOf(sessionId)
    const backend = this.resolveRef(page, String(args.ref ?? ''))
    const { x, y } = await this.actionable(sessionId, backend, args, 'click')
    this.deps.acted?.(sessionId, { x, y }, false)
    await this.send(sessionId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    return this.afterAction(sessionId, page, `Hovered over ${describe(args, 'the element')}.`)
  }

  /**
   * Drags one element onto another with the mouse held down. A page's own HTML drag and drop is
   * a drag Chromium starts itself, which the protocol hands back as data to drop; a page that
   * drags on pointer events alone follows the moves.
   */
  private async drag(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    const given = dragArgs(args)
    const page = this.pageOf(sessionId)
    const from = { ref: given.start_ref, element: given.start_element }
    const to = { ref: given.end_ref, element: given.end_element }
    const start = this.resolveRef(page, given.start_ref)
    const end = this.resolveRef(page, given.end_ref)
    let source = await this.actionable(sessionId, start, from, 'click')
    let target = await this.probe(sessionId, end, 'select')
    if (!target.connected) {
      throw new ToolFailure('stale_ref', `${describe(to, 'The element')} is no longer on the page.`)
    }
    if (!target.inside) {
      target = await this.actionable(sessionId, end, to, 'select')
      source = await this.probe(sessionId, start, 'select')
      if (!source.inside) {
        throw new ToolFailure(
          'invalid',
          `${describe(from, 'The element')} and ${describe(to, 'the element')} do not show on the screen at once, so one cannot be dragged onto the other.`,
        )
      }
    }
    this.deps.acted?.(sessionId, { x: source.x, y: source.y }, true)
    const mouse = (type: string, at: { x: number; y: number }, extra = {}): Promise<unknown> =>
      this.send(sessionId, 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, ...extra })
    page.drag = null
    const intercepting = await this.send(sessionId, 'Input.setInterceptDrags', { enabled: true })
      .then(() => true)
      .catch(() => false)
    let dropped = false
    try {
      await mouse('mouseMoved', source)
      await mouse('mousePressed', source, { button: 'left', buttons: 1, clickCount: 1 })
      const steps = 10
      for (let step = 1; step <= steps && !page.drag; step++) {
        const at = {
          x: source.x + ((target.x - source.x) * step) / steps,
          y: source.y + ((target.y - source.y) * step) / steps,
        }
        await mouse('mouseMoved', at, { button: 'left', buttons: 1 })
        await sleep(16)
      }
      const data = page.drag
      if (data) {
        dropped = true
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await this.send(sessionId, 'Input.dispatchDragEvent', {
            type,
            x: target.x,
            y: target.y,
            data,
          })
        }
      }
      await mouse('mouseReleased', target, { button: 'left', buttons: 0, clickCount: 1 })
    } finally {
      page.drag = null
      if (intercepting) {
        await this.send(sessionId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {})
      }
    }
    return this.afterAction(
      sessionId,
      page,
      `Dragged ${describe(from, 'the element')} onto ${describe(to, 'the element')}${dropped ? ', as a drag and drop the page started' : ''}.`,
    )
  }

  /** Clicks at a point inside the visible page, for what no ref names. */
  private async clickAt(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const { x, y, reason, button, double } = clickAtArgs(args)
    const page = this.pageOf(sessionId)
    const view = await this.viewport(sessionId)
    if (x >= view.width || y >= view.height) {
      throw new ToolFailure(
        'invalid',
        `(${x}, ${y}) lies outside the visible page, which is ${Math.round(view.width)} by ${Math.round(view.height)} CSS pixels. Scroll first, or give a point inside it.`,
      )
    }
    this.deps.acted?.(sessionId, { x, y }, true)
    await this.clickPoint(sessionId, x, y, button, double)
    return this.afterAction(
      sessionId,
      page,
      `Clicked${double ? ' twice' : ''} at (${x}, ${y}): ${reason.replace(/[.\s]+$/, '')}.`,
    )
  }

  private async emulate(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const change = emulateArgs(args)
    const tab = this.tabOf(sessionId)
    if (tab === null || !this.deps.emulate) {
      throw new ToolFailure('no_page', 'This session has no page yet. Use browser_navigate first.')
    }
    const now = await this.deps.emulate(tab, change)
    const reload =
      change.set.device !== undefined ||
      change.set.locale !== undefined ||
      change.off.includes('device') ||
      change.off.includes('locale')
    return {
      text: `Your tab emulates ${emulationText(now)}.${reload ? ' Reload the page for what it already loaded to follow.' : ''}`,
      value: { emulation: emulationValue(now) },
    }
  }

  /** Points the tab's Fetch domain at the session's rules, or turns it off without any. */
  private async syncRoutes(page: PageState): Promise<void> {
    const patterns = page.session && page.agentUsed ? this.routes.patterns(page.session) : []
    const key = patterns.join('\n')
    if (key === page.fetchKey) return
    page.fetchKey = key
    const command =
      patterns.length === 0
        ? page.contents.debugger.sendCommand('Fetch.disable')
        : page.contents.debugger.sendCommand('Fetch.enable', {
            patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })),
          })
    await command.catch((error: unknown) => {
      this.deps.log('warn', `Could not set a tab's network rules: ${(error as Error).message}`)
    })
  }

  private async routesChanged(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.pages.values()]
        .filter((page) => page.session === sessionId)
        .map((page) => this.syncRoutes(page)),
    )
  }

  /**
   * A request a tab paused: the first rule that matches answers it, after its delay; any other
   * goes on. Every paused request is answered, so a page never hangs on one.
   */
  private async paused(page: PageState, params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '')
    const request = (params.request ?? {}) as Record<string, unknown>
    const url = String(request.url ?? '')
    const answer = (method: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
      page.contents.debugger.sendCommand(method, { requestId, ...extra }).catch(() => {})
    const sessionId = page.session
    let decided =
      sessionId === null
        ? null
        : answerFor(this.routes.rules(sessionId), {
            url,
            method: String(request.method ?? 'GET'),
            headers: objectOf(request.headers) as Record<string, string>,
            resourceType: String(params.resourceType ?? ''),
          })
    if (
      decided?.rule &&
      params.resourceType === 'Document' &&
      sessionId !== null &&
      this.deps.mayOpen?.(sessionId, url) === false
    ) {
      decided = null
    }
    if (!decided?.rule || sessionId === null) {
      await answer('Fetch.continueRequest')
      return
    }
    const rule = decided.rule
    if (this.routes.used(sessionId, rule)) void this.routesChanged(sessionId)
    const label = mockedLabel(decided)
    const networkId = typeof params.networkId === 'string' ? params.networkId : null
    if (label && networkId) {
      page.mocked.set(networkId, label)
      if (page.mocked.size > MAX_REQUESTS) page.mocked.delete(page.mocked.keys().next().value!)
    }
    if (rule.delayMs > 0) await sleep(rule.delayMs)
    switch (decided.kind) {
      case 'continue':
        await answer('Fetch.continueRequest')
        break
      case 'fail':
        await answer('Fetch.failRequest', { errorReason: decided.reason })
        break
      case 'fulfill':
        await answer('Fetch.fulfillRequest', {
          responseCode: decided.status,
          responseHeaders: decided.headers,
          body: Buffer.from(decided.body, 'utf8').toString('base64'),
        })
        break
    }
  }

  private async route(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const call = routeArgs(args)
    let done: string
    switch (call.action) {
      case 'add': {
        let rule
        try {
          rule = this.routes.add(sessionId, call.rule)
        } catch (error) {
          throw new ToolFailure('invalid', (error as Error).message)
        }
        await this.routesChanged(sessionId)
        done = `Added rule ${rule.id}: ${rule.method ?? 'any'} ${rule.pattern} ${ruleText(rule)}.`
        break
      }
      case 'remove':
        if (!this.routes.remove(sessionId, call.id)) {
          throw new ToolFailure(
            'invalid',
            `There is no rule ${call.id}; list the rules to see theirs.`,
          )
        }
        await this.routesChanged(sessionId)
        done = `Removed rule ${call.id}.`
        break
      case 'clear': {
        const count = this.routes.clear(sessionId)
        await this.routesChanged(sessionId)
        done =
          count === 0 ? 'There were no rules.' : `Cleared ${count} rule${count === 1 ? '' : 's'}.`
        break
      }
      case 'list':
        done = 'The rules, the first that matches answering:'
        break
    }
    const rules = this.routes.rules(sessionId).map((rule) => ({
      id: rule.id,
      url: rule.pattern,
      method: rule.method,
      does: ruleText(rule),
      used: rule.used,
    }))
    const lines = rules.map(
      (rule) => `- ${rule.id}: ${rule.method ?? 'any'} ${rule.url} ${rule.does}; used ${rule.used}`,
    )
    return {
      text: [done, ...(rules.length === 0 ? ['No rules now.'] : lines)].join('\n'),
      value: { rules },
    }
  }

  private downloadsResult(sessionId: string): BrowserCallResult {
    const downloads = this.deps.downloads?.(sessionId) ?? []
    return {
      text:
        downloads.length === 0
          ? 'No downloads in this session.'
          : downloads
              .map(
                (d) => `- ${d.name}: ${d.state}, ${d.bytes} bytes${d.path ? `, at ${d.path}` : ''}`,
              )
              .join('\n'),
      value: { downloads },
    }
  }

  private async pdf(sessionId: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    const { landscape, background } = pdfArgs(args)
    await this.gate(sessionId)
    const contents = this.contentsOf(sessionId)
    // Electron prints through its own printing, which the debugger's Page.printToPDF lacks.
    const data = await contents
      .printToPDF({ landscape, printBackground: background, preferCSSPageSize: true })
      .catch((error: unknown) => {
        throw new ToolFailure(
          'invalid',
          `The page could not be printed: ${(error as Error).message}`,
        )
      })
    const path = await this.deps.saveFile?.(
      sessionId,
      pdfName(contents.getTitle(), contents.getURL()),
      data,
    )
    if (!path) {
      throw new ToolFailure(
        'invalid',
        'This session has no folder on this computer to save the PDF into.',
      )
    }
    return {
      text: `Saved the page as a PDF of ${Math.max(1, Math.round(data.length / 1024))} KB at ${path}.`,
      value: { path, bytes: data.length },
    }
  }

  /** Records the page for a few seconds over the Tracing domain and sums up what it did. */
  private async trace(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const { seconds, reload } = traceArgs(args)
    const page = this.pageOf(sessionId)
    if (page.trace) throw new ToolFailure('invalid', 'A trace of this tab is already running.')
    let settle!: (stream: string | null) => void
    const complete = new Promise<string | null>((resolve) => (settle = resolve))
    page.trace = settle
    let stream: string | null
    try {
      await this.send(sessionId, 'Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATEGORIES },
      })
      try {
        if (reload) await this.deps.reload(sessionId)
        const until = Date.now() + seconds * 1000
        while (Date.now() < until) {
          await this.gate(sessionId)
          await sleep(Math.min(100, Math.max(1, until - Date.now())))
        }
      } finally {
        await this.send(sessionId, 'Tracing.end').catch(() => settle(null))
      }
      stream = await Promise.race([complete, sleep(15_000).then(() => null)])
    } finally {
      page.trace = null
    }
    if (!stream) throw new ToolFailure('timeout', 'The trace did not finish. Try again.')
    const chunks: Buffer[] = []
    let read = 0
    try {
      for (;;) {
        const chunk = await this.send<{ data?: string; eof?: boolean; base64Encoded?: boolean }>(
          sessionId,
          'IO.read',
          { handle: stream, size: 4 * 1024 * 1024 },
        )
        const bytes = Buffer.from(chunk.data ?? '', chunk.base64Encoded ? 'base64' : 'utf8')
        read += bytes.length
        if (read > MAX_TRACE_BYTES)
          throw new ToolFailure('invalid', 'The trace was too large to read.')
        chunks.push(bytes)
        if (chunk.eof) break
      }
    } finally {
      await this.send(sessionId, 'IO.close', { handle: stream }).catch(() => {})
    }
    let events
    try {
      events = traceEvents(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      throw new ToolFailure('invalid', 'The trace could not be read.')
    }
    const paints = await this.pagePaints(sessionId)
    const summary = summarizeTrace(events, paints.lcp, paints.fcp)
    return { text: traceText(summary), value: { summary } }
  }

  /** The page's own paints, as it reports them: its largest and its first contentful paint. */
  private async pagePaints(
    sessionId: string,
  ): Promise<{ lcp: { ms: number; element: string | null } | null; fcp: number | null }> {
    const answer = await this.send<{ result?: { value?: unknown } }>(
      sessionId,
      'Runtime.evaluate',
      {
        expression: `new Promise((resolve) => {
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]
        let last = null
        try {
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries()
            last = entries[entries.length - 1] || last
          })
          observer.observe({ type: 'largest-contentful-paint', buffered: true })
          setTimeout(() => {
            observer.disconnect()
            resolve({
              fcp: fcp ? fcp.startTime : null,
              lcp: last ? { ms: last.startTime, element: last.element ? last.element.localName : null } : null,
            })
          }, 100)
        } catch (error) {
          resolve({ fcp: fcp ? fcp.startTime : null, lcp: null })
        }
      })`,
        awaitPromise: true,
        returnByValue: true,
      },
    ).catch(() => null)
    const value = answer?.result?.value as
      { fcp?: unknown; lcp?: { ms?: unknown; element?: unknown } | null } | undefined
    const lcp =
      value?.lcp && typeof value.lcp.ms === 'number'
        ? {
            ms: value.lcp.ms,
            element: typeof value.lcp.element === 'string' ? value.lcp.element : null,
          }
        : null
    return { lcp, fcp: typeof value?.fcp === 'number' ? value.fcp : null }
  }

  private async storageState(
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<BrowserCallResult> {
    const call = storageStateArgs(args)
    const states = this.deps.states
    if (!states) throw new ToolFailure('invalid', 'Saved sign-in states are not available here.')
    const listed = async (): Promise<Record<string, unknown>[]> =>
      (await states.list()).map((state) => ({
        name: state.name,
        sites: state.sites,
        saved_at: new Date(state.savedAt).toISOString(),
      }))
    try {
      if (call.action === 'list') {
        const all = await listed()
        return {
          text:
            all.length === 0
              ? 'No saved sign-in states.'
              : all
                  .map((s) => `- ${String(s.name)}: ${(s.sites as string[]).join(', ')}`)
                  .join('\n'),
          value: { states: all },
        }
      }
      if (call.action === 'save') {
        const tab = this.tabOf(sessionId)
        this.contentsOf(sessionId)
        const saved = await states.save(sessionId, tab!, call.name)
        return {
          text: `Saved the sign-in state of ${saved.sites.join(', ')} as "${call.name}": ${saved.cookies} cookie${saved.cookies === 1 ? '' : 's'} and the site's local storage, encrypted.`,
          value: { states: await listed() },
        }
      }
      const restored = await states.restore(sessionId, this.tabOf(sessionId), call.name)
      return {
        text: `Restored "${call.name}" into this session's browser: ${restored.cookies} cookie${restored.cookies === 1 ? '' : 's'} for ${restored.sites.join(', ')}${restored.storage > 0 ? ` and the local storage of ${restored.storage} site${restored.storage === 1 ? '' : 's'}` : ''}. Open or reload the site to use it.`,
        value: { states: await listed() },
      }
    } catch (error) {
      if (error instanceof ToolFailure) throw error
      throw new ToolFailure('invalid', (error as Error).message)
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

function waitState(value: unknown): BrowserWaitState {
  if (value === undefined) return 'visible'
  if ((BROWSER_WAIT_STATES as readonly unknown[]).includes(value)) return value as BrowserWaitState
  throw new ToolFailure('invalid', 'state must be visible, hidden, attached or detached.')
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

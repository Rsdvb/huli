// The browser tools of the `kettu` MCP server: what agents are told, the schemas, the
// checks, and the forwarding to main, which drives the calling session's page.

import { isAbsolute } from 'node:path'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type {
  BrowserCallAnswer,
  BrowserCallRequest,
  BrowserToolErrorCode,
  BrowserToolName,
} from '@shared/browser'
import {
  BROWSER_CONSOLE_LEVELS,
  BROWSER_TAB_ACTIONS,
  BROWSER_WAIT_STATES,
  BROWSER_TOOL_NAMES,
  isBrowserForwardPort,
  loopbackForward,
  MAX_COMPANION_FORWARDS,
  MAX_PAGE_SIDE,
  MAX_SESSION_TABS,
  MAX_SNAPSHOT_DEPTH,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MIN_PAGE_SIDE,
  ORIGIN_WAIT_MS,
  PAGE_SIZE_NAMES,
  PAGE_SIZES,
  pageSizeOf,
} from '@shared/browser'
import {
  BROWSER_ARGS,
  BrowserArgsInvalid,
  DEVICE_PRESETS,
  EMULATION_ITEMS,
  MAX_CLICK_REASON,
  MAX_ROUTE_BODY,
  MAX_ROUTE_DELAY_MS,
  MAX_STATE_NAME,
  MAX_TRACE_SECONDS,
  NETWORK_PRESETS,
  ROUTE_ABORTS,
  ROUTE_ACTIONS,
  STORAGE_ACTIONS,
  isArgsTool,
} from '@shared/browser-args'
import {
  CONTROL_STEPS,
  CONTROL_WAIT_MS,
  isControlStep,
  type SurfaceAccessAnswer,
} from '@shared/control'
import type { Caller } from './tools'

/** A navigation and everything that waits on one. */
export const NAVIGATION_TIMEOUT_MS = 30_000
/** The other acting tools, which wait up to 5 s for their element and 5 s for the page. */
export const ACTION_TIMEOUT_MS = 20_000
/** Above `browser_wait_for`'s own time, so the page answers it before this does. */
export const WAIT_EXTRA_MS = 5_000
export const MAX_WAIT_SECONDS = 30
const MAX_TEXT_CHARS = 20_000
const MAX_SCRIPT_CHARS = 20_000
const MAX_VALUES = 50
const MAX_REASON_CHARS = 500
const MAX_PATH_CHARS = 4_096
const MAX_URL_FILTER_CHARS = 2_000
const MAX_SELECTOR_CHARS = 1_000
const MAX_REQUEST_ID_CHARS = 200
/** As main's MAX_BODY_CHARS, in round kilobytes for the description. */
const MAX_BODY_KB = 32

export type BrowserToolDeps = {
  /** Runs a call on main, which drives the session's page; `caller` is the calling session. */
  call(request: BrowserCallRequest, caller: string): Promise<BrowserCallAnswer>
  /** The session whose page a call drives: a subagent's calls use the session it runs under. */
  pageOf(sessionId: string): string | null
  /** The project of the session whose page a call drives; '' when it has none to name. */
  projectOf(sessionId: string): string
  /** Huli: the folder that session works in, its worktree's or its project's; null for none. */
  folderOf?(sessionId: string): string | null
  /** How a tab the user opened is allowed; without it every such tab is refused. */
  access?: BrowserAccessDeps
}

/** What lets the agent use a tab the user opened in the session's browser. */
export interface BrowserAccessDeps {
  /** Full access uses a tab of the user's without asking. */
  fullAccess(sessionId: string): boolean
  /** Asks the user in the thread whether the agent may use their tab. */
  ask(sessionId: string, tab: { id: string; title: string }): Promise<SurfaceAccessAnswer>
  /** Full access let the agent use a tab of the user's without asking. */
  used(sessionId: string, title: string): void
  /** The user referenced the tab in a message to the session, which allows it. */
  shared(sessionId: string, tabId: string): boolean
}

// The longest page title a card shows of a tab the browser named.
const MAX_TAB_TITLE = 200

type Schema = Record<string, unknown>

interface ObjectSchema {
  [key: string]: unknown
  type: 'object'
  properties: Record<string, Schema>
  required: string[]
}

const REF: Schema = {
  type: 'string',
  pattern: '^e[0-9]+$',
  description: 'The ref a snapshot gave an element, such as e12.',
}
const ELEMENT: Schema = {
  type: 'string',
  maxLength: 200,
  description: 'What the ref points at in words, such as "Sign in button"; the ref decides.',
}
const SINCE: Schema = {
  type: 'boolean',
  default: false,
  description: 'Only what this document has logged, not what earlier ones did.',
}

function object(properties: Record<string, Schema>, required: string[] = []): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const ERROR_CODES: BrowserToolErrorCode[] = [
  'user_has_control',
  'stopped',
  'not_allowed',
  'needs_allow',
  'stale_ref',
  'timeout',
  'navigation_failed',
  'no_page',
  'invalid',
  'unavailable',
]

// The message too, since the agents give the model the structured value rather than the text.
const ERROR = object({ code: { type: 'string', enum: ERROR_CODES }, message: { type: 'string' } }, [
  'code',
  'message',
])

const PAGE = {
  url: { type: 'string', description: 'The address the page shows.' },
  title: { type: ['string', 'null'], description: "The page's title." },
  snapshot: {
    type: 'string',
    description:
      'The page outline after the action settled; after an action on the same page, only what ' +
      'changed since your last snapshot when that is shorter, as it says.',
  },
}

function output(properties: Record<string, Schema>): Tool['outputSchema'] {
  return { type: 'object', anyOf: [object(properties, Object.keys(properties)), ERROR] }
}

const READ_ONLY = { readOnlyHint: true } as const

function sizeText(name: keyof typeof PAGE_SIZES): string {
  return `${PAGE_SIZES[name].width} × ${PAGE_SIZES[name].height}`
}

/**
 * The tools that only read a page, which run without the agent's own permission prompt: they read
 * the agent's own tabs, and on a tab the user opened Kettu asks them in its own card instead.
 */
export const BROWSER_READ_TOOLS: readonly BrowserToolName[] = [
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_downloads',
]

/** 仅在 Auto 模式下自动放行的本地浏览器调试工具（导航仅限本地开发服务，用户标签页另由 Kettu 授权卡把关）。 */
export const BROWSER_AUTO_MODE_TOOLS: readonly BrowserToolName[] = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_reload',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_select_option',
  'browser_evaluate',
  'browser_ask_user',
  'browser_tabs',
  'browser_resize',
]

const TAB = object(
  {
    index: { type: 'integer' },
    url: { type: 'string' },
    title: { type: 'string' },
    current: { type: 'boolean', description: 'Your current tab, which your other tools act on.' },
    released: { type: 'boolean', description: 'Released to save memory; it loads when selected.' },
    yours: {
      type: 'boolean',
      description:
        'You opened it. A tab the user opened needs their allow: your first call on it asks them.',
    },
    usable: { type: 'boolean', description: 'You may act on it now.' },
  },
  ['index', 'url', 'title', 'current', 'released'],
)

export const BROWSER_TOOLS: Tool[] = [
  {
    name: 'browser_navigate',
    title: 'Navigate',
    description:
      'Opens a URL in the browser, at a local dev server (localhost, 127.0.0.1, [::1], ' +
      '*.localhost, *.test) or about:blank, and returns the page with a snapshot. Other sites ' +
      'are the user’s to open. After you change a web page, open it here to check it before you ' +
      'finish, without being asked: the user watches this browser.',
    inputSchema: object(
      {
        url: { type: 'string', maxLength: 8_192, description: 'An absolute http(s) address.' },
        forward_ports: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Extra local ports the page calls (e.g. API).',
        },
      },
      ['url'],
    ),
    outputSchema: output(PAGE),
    // Claude Code defers MCP tools behind a search; checking a changed page should not need one.
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'browser_navigate_back',
    title: 'Go back',
    description: 'Goes back one page in the browser, and returns the page with a snapshot.',
    inputSchema: object({}),
    outputSchema: output(PAGE),
  },
  {
    name: 'browser_reload',
    title: 'Reload',
    description: 'Reloads the page in the browser, and returns it with a snapshot.',
    inputSchema: object({}),
    outputSchema: output(PAGE),
  },
  {
    name: 'browser_snapshot',
    title: 'Snapshot',
    description:
      'Returns the page as an outline of its accessibility tree, with a ref on each element ' +
      'you can act on (buttons, links, fields, options and the like) and on the lists, forms, ' +
      'dialogs and regions that hold them, and the page’s text under the element that holds ' +
      'it. A ref stays the same element’s while the page shows it. Give a ref to read only that ' +
      'element, and depth to read fewer levels; acting tools answer with only what changed, and ' +
      'this gives the whole page again.',
    inputSchema: object({
      ref: { ...REF, description: 'Only this element and what it holds.' },
      depth: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_SNAPSHOT_DEPTH,
        description:
          'How many levels under the top elements to show; an element cut off ends in "…".',
      },
    }),
    outputSchema: output(PAGE),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_click',
    title: 'Click',
    description:
      'Clicks an element from the snapshot at its centre, once it is on the page, visible, ' +
      'enabled, scrolled into view and not covered by another element, waiting up to 5 s for ' +
      'that; one that stays covered fails and names what covers it.',
    inputSchema: object(
      {
        ref: REF,
        element: ELEMENT,
        double: { type: 'boolean', default: false, description: 'Clicks twice.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      ['ref'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_type',
    title: 'Type',
    description:
      'Focuses a field from the snapshot, replaces what it holds with text, and with submit ' +
      'presses Enter. Slowly types one key at a time, for fields that react to keys. Waits up ' +
      'to 5 s for the field to be visible, enabled and not read-only.',
    inputSchema: object(
      {
        ref: REF,
        element: ELEMENT,
        text: { type: 'string', maxLength: MAX_TEXT_CHARS },
        submit: { type: 'boolean', default: false, description: 'Presses Enter after typing.' },
        slowly: {
          type: 'boolean',
          default: false,
          description: 'Types each character as a key press.',
        },
      },
      ['ref', 'text'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_press_key',
    title: 'Press key',
    description:
      'Presses a key on the page, as a name such as Enter or ArrowDown, or a combination such ' +
      'as Control+A or Meta+ArrowLeft.',
    inputSchema: object(
      {
        key: {
          type: 'string',
          maxLength: 60,
          description: 'A key name or a combination such as Control+A.',
        },
      },
      ['key'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scrolls the page, or an element from the snapshot, by whole screens.',
    inputSchema: object(
      {
        ref: { ...REF, description: 'The element to scroll in; the page by default.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 50,
          default: 1,
          description: 'How many screens.',
        },
      },
      ['direction'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_select_option',
    title: 'Select option',
    description:
      'Chooses options of a select element from the snapshot, by value, label or text, and ' +
      'fires input and change as a browser does.',
    inputSchema: object(
      {
        ref: REF,
        element: ELEMENT,
        values: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_VALUES,
          items: { type: 'string' },
          description: 'The values, labels or texts of the options to choose.',
        },
      },
      ['ref', 'values'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_take_screenshot',
    title: 'Screenshot',
    description:
      'Takes a PNG screenshot of the page, of the whole page scrolled out, or of an element ' +
      'from the snapshot. The longer side is at most 2000 px.',
    inputSchema: object({
      ref: { ...REF, description: 'The element to capture; the viewport by default.' },
      full_page: {
        type: 'boolean',
        default: false,
        description: 'Captures the whole page, at most 8000 px high.',
      },
    }),
    outputSchema: output({
      url: PAGE.url,
      title: PAGE.title,
    }),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_wait_for',
    title: 'Wait for',
    description:
      'Waits for text to appear or to leave the page, for an element (a CSS selector, or a ref ' +
      'from the snapshot) to be visible, hidden, attached or detached, or for a number of ' +
      'seconds, then returns the page. It looks in every frame of the page it can reach and in ' +
      'open shadow roots. Give one of text, text_gone, selector and ref; time is then the ' +
      'longest it waits.',
    inputSchema: object({
      text: { type: 'string', maxLength: MAX_TEXT_CHARS, description: 'Waits until it shows.' },
      text_gone: { type: 'string', maxLength: MAX_TEXT_CHARS, description: 'Waits until it goes.' },
      selector: {
        type: 'string',
        maxLength: MAX_SELECTOR_CHARS,
        description: 'A CSS selector, such as "#results li" or "[role=alert]".',
      },
      ref: { ...REF, description: 'An element from the snapshot.' },
      state: {
        type: 'string',
        enum: [...BROWSER_WAIT_STATES],
        default: 'visible',
        description:
          'For selector or ref: visible, hidden (not visible or gone), attached (on the page) ' +
          'or detached (gone).',
      },
      time: {
        type: 'number',
        minimum: 0,
        maximum: MAX_WAIT_SECONDS,
        description: 'Seconds to wait, at most 30.',
      },
    }),
    outputSchema: output(PAGE),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_console_messages',
    title: 'Console messages',
    description:
      'Returns the page’s console messages and the errors it did not catch, thrown or an ' +
      'unhandled rejection, the last 200, as text. Errors and warnings come with their stack.',
    inputSchema: object({
      since_navigation: SINCE,
      level: {
        type: 'string',
        enum: [...BROWSER_CONSOLE_LEVELS],
        default: 'all',
        description: 'Only messages at this level or more severe: error, warn, info, or all.',
      },
    }),
    outputSchema: output({
      messages: {
        type: 'array',
        items: object(
          {
            level: { type: 'string' },
            text: { type: 'string' },
            url: { type: 'string' },
            line: { type: 'integer' },
            stack: {
              type: 'string',
              description: 'Where it was thrown or logged, one call a line, the innermost first.',
            },
          },
          ['level', 'text', 'url', 'line'],
        ),
      },
    }),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_network_requests',
    title: 'Network requests',
    description:
      'Returns the page’s network requests, the last 300, with their id, method, address, ' +
      'status, type, size and why one failed. Images, scripts and other static resources that ' +
      'loaded are left out unless include_static. browser_network_request gives one’s headers, ' +
      'timing and body.',
    inputSchema: object({
      since_navigation: SINCE,
      url: {
        type: 'string',
        maxLength: MAX_URL_FILTER_CHARS,
        description: 'Only requests whose address holds this text, in any case.',
      },
      include_static: {
        type: 'boolean',
        default: false,
        description: 'Also lists images, fonts, style sheets, scripts and media that loaded.',
      },
    }),
    outputSchema: output({
      requests: {
        type: 'array',
        items: object(
          {
            id: { type: 'string' },
            method: { type: 'string' },
            url: { type: 'string' },
            status: { type: ['integer', 'null'] },
            type: { type: 'string' },
            size: { type: ['integer', 'null'] },
            error: { type: 'string', description: 'Why it failed, such as net::ERR_FAILED.' },
            mocked: {
              type: 'string',
              description: 'What a browser_route rule did with it, such as "mocked by r1".',
            },
          },
          ['id', 'method', 'url', 'status', 'type', 'size'],
        ),
      },
    }),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_network_request',
    title: 'Network request',
    description:
      'Returns one request from browser_network_requests: its request and response headers, ' +
      'status, timing, and its request and response bodies when they are text, at most ' +
      `${MAX_BODY_KB} KB each. The values of credential headers (Authorization, Cookie, ` +
      'Set-Cookie and the like) and of password, token and other secret fields are replaced ' +
      'with [redacted].',
    inputSchema: object(
      {
        id: {
          type: 'string',
          maxLength: MAX_REQUEST_ID_CHARS,
          description: 'The id browser_network_requests gave the request.',
        },
      },
      ['id'],
    ),
    outputSchema: output({
      id: { type: 'string' },
      method: { type: 'string' },
      url: { type: 'string' },
      status: { type: ['integer', 'null'] },
      status_text: { type: 'string' },
      type: { type: 'string' },
      mime_type: { type: 'string' },
      size: { type: ['integer', 'null'], description: 'Bytes on the wire.' },
      from_cache: { type: 'boolean' },
      error: { type: ['string', 'null'] },
      redirects: {
        type: 'array',
        items: { type: 'string' },
        description: 'The addresses it was redirected from, each after its status.',
      },
      request_headers: { type: 'object', additionalProperties: { type: 'string' } },
      response_headers: {
        type: ['object', 'null'],
        additionalProperties: { type: 'string' },
      },
      timing: object(
        {
          started_at: { type: ['string', 'null'] },
          total_ms: { type: ['number', 'null'] },
          dns_ms: { type: ['number', 'null'] },
          connect_ms: { type: ['number', 'null'] },
          tls_ms: { type: ['number', 'null'] },
          wait_ms: { type: ['number', 'null'], description: 'From sent to the first headers.' },
          download_ms: { type: ['number', 'null'] },
        },
        ['started_at', 'total_ms', 'dns_ms', 'connect_ms', 'tls_ms', 'wait_ms', 'download_ms'],
      ),
      request_body: { type: ['string', 'null'] },
      response_body: { type: ['string', 'null'] },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Why a body is cut or not shown, and how the request ended.',
      },
    }),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_evaluate',
    title: 'Evaluate',
    description:
      'Runs a JavaScript function on the page to inspect it, with the element from the ' +
      'snapshot as its argument when a ref is given, and returns its value as JSON, at most ' +
      '64 KB. For inspection: prefer the snapshot and the other tools for acting.',
    inputSchema: object(
      {
        function: {
          type: 'string',
          maxLength: MAX_SCRIPT_CHARS,
          description: 'A function’s source, such as "() => document.title".',
        },
        ref: { ...REF, description: 'Passes this element to the function.' },
      },
      ['function'],
    ),
    outputSchema: output({ value: { description: 'The function’s value, as JSON.' } }),
    annotations: { openWorldHint: true },
  },
  {
    name: 'browser_ask_user',
    title: 'Ask the user',
    description:
      'Asks the user to do a step on the page that only a person can do, such as signing in, ' +
      'entering a code sent to them or passing a human check, and waits until they press Done ' +
      'or Skip. The page is theirs while it waits. After Done it returns the page as they left ' +
      'it, with a snapshot. If it says the user is still doing the step, call it again.',
    inputSchema: object(
      {
        step: {
          type: 'string',
          enum: [...CONTROL_STEPS],
          description:
            'sign_in, code for a code sent to the user, check for a human check, or other.',
        },
        reason: {
          type: 'string',
          maxLength: MAX_REASON_CHARS,
          description: 'One or two sentences for the user: why you need it, and what you do next.',
        },
      },
      ['step', 'reason'],
    ),
    outputSchema: output({
      outcome: { type: 'string', enum: ['done', 'skipped'] },
      url: PAGE.url,
      title: PAGE.title,
      snapshot: PAGE.snapshot,
    }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_tabs',
    title: 'Tabs',
    description:
      'Lists the browser’s tabs, opens a blank one, switches to one or closes one. Your other ' +
      'browser tools act on your current tab; a tab you open or switch to becomes it, and a tab ' +
      'the user selects does not. Answers the tabs with their indexes.',
    inputSchema: object(
      {
        action: { type: 'string', enum: [...BROWSER_TAB_ACTIONS] },
        index: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SESSION_TABS - 1,
          description:
            'The tab to select or close, from the list; close takes your current tab by default.',
        },
      },
      ['action'],
    ),
    outputSchema: output({ tabs: { type: 'array', items: TAB } }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_resize',
    title: 'Resize page',
    description:
      'Sets the size your page lays out at: desktop (at least 1280 px wide, filling the panel’s ' +
      `height, the one it starts with), tablet ${sizeText('tablet')} or phone ${sizeText('phone')}, ` +
      'or a width and height of your own. Tablet and phone lay it out as a touch device with a ' +
      'mobile user agent. The size stays with the tab, and desktop stays fixed during your turn ' +
      'so panel resizes never reflow it. To emulate a device, its pixel ratio or the rest, use ' +
      'browser_emulate, whose device or viewport takes the place of this size while it is set. ' +
      'Returns the page with a snapshot.',
    inputSchema: object({
      size: { type: 'string', enum: [...PAGE_SIZE_NAMES] },
      width: {
        type: 'integer',
        minimum: MIN_PAGE_SIDE,
        maximum: MAX_PAGE_SIDE,
        description: 'In CSS pixels, with height, in place of size.',
      },
      height: {
        type: 'integer',
        minimum: MIN_PAGE_SIDE,
        maximum: MAX_PAGE_SIDE,
        description: 'In CSS pixels, with width, in place of size.',
      },
    }),
    outputSchema: output({
      size: { type: 'string', enum: [...PAGE_SIZE_NAMES, 'custom'] },
      width: { type: 'integer' },
      height: { type: 'integer' },
      mobile: { type: 'boolean', description: 'It lays out as a touch device.' },
      ...PAGE,
    }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_upload_file',
    title: 'Upload file',
    description:
      'Puts files from this computer into a file input on the page: the file chooser your last ' +
      'action opened (click the page’s upload button first), or the file input a snapshot ref ' +
      `names. Give absolute paths of existing files, at most ${MAX_UPLOAD_FILES} and ` +
      `${MAX_UPLOAD_BYTES / 1024 / 1024} MB in all. The user is asked every time, on the page, ` +
      'whether these files may go to this site; nothing is uploaded unless they allow it, and ' +
      'a refusal or no answer fails with not_allowed. Returns the page with a snapshot.',
    inputSchema: object(
      {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_UPLOAD_FILES,
          items: { type: 'string', maxLength: MAX_PATH_CHARS },
          description: 'Absolute paths of the files.',
        },
        ref: {
          ...REF,
          description: 'A file input from the snapshot; the open chooser by default.',
        },
        element: ELEMENT,
      },
      ['paths'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: true },
  },
  // Huli: the second batch.
  {
    name: 'browser_hover',
    title: 'Hover',
    description:
      'Moves the pointer over an element from the snapshot, to show a tooltip or a menu that ' +
      'opens on hover, once it is visible and uncovered, waiting up to 5 s for that.',
    inputSchema: object({ ref: REF, element: ELEMENT }, ['ref']),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_drag',
    title: 'Drag',
    description:
      'Drags one element from the snapshot onto another, with the mouse held down, as a person ' +
      'does: for drag and drop lists, boards and sliders.',
    inputSchema: object(
      {
        start_ref: { ...REF, description: 'The element to drag.' },
        start_element: ELEMENT,
        end_ref: { ...REF, description: 'The element to drop it on.' },
        end_element: ELEMENT,
      },
      ['start_ref', 'end_ref'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_click_at',
    title: 'Click at a point',
    description:
      'Clicks at a point of the page, in CSS pixels from the top left of the visible page, for ' +
      'what a snapshot gives no ref, such as a canvas or a map. Prefer browser_click with a ref. ' +
      'The point must lie inside the visible page; the user sees the reason.',
    inputSchema: object(
      {
        x: { type: 'number', minimum: 0, description: 'From the left edge of the visible page.' },
        y: { type: 'number', minimum: 0, description: 'From the top edge of the visible page.' },
        reason: {
          type: 'string',
          maxLength: MAX_CLICK_REASON,
          description: 'What is at the point and why you click it, shown to the user.',
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        double: { type: 'boolean', default: false, description: 'Clicks twice.' },
      },
      ['x', 'y', 'reason'],
    ),
    outputSchema: output(PAGE),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_emulate',
    title: 'Emulate',
    description:
      'Makes your current tab emulate a device (its size, pixel ratio, touch and mobile browser), ' +
      'a dark or light color scheme, reduced motion, a locale, a time zone, a location, or a slow ' +
      'or offline network. What you leave out stays as it is; off turns items back off. The ' +
      'user sees a chip while anything is emulated and may reset it. Reload the page for a ' +
      'locale or a device to apply to what it already loaded. For a page size alone, use ' +
      'browser_resize; a device or viewport here takes its place until you turn it off.',
    inputSchema: object({
      device: {
        type: 'string',
        enum: DEVICE_PRESETS.map((device) => device.id),
        description: 'A device by name.',
      },
      viewport: object(
        {
          width: { type: 'integer', minimum: 200, maximum: 3840 },
          height: { type: 'integer', minimum: 200, maximum: 3840 },
          device_scale_factor: { type: 'number', minimum: 1, maximum: 4, default: 1 },
          mobile: { type: 'boolean', default: false },
          touch: { type: 'boolean', description: 'Touch events; as mobile by default.' },
        },
        ['width', 'height'],
      ),
      color_scheme: { type: 'string', enum: ['light', 'dark'] },
      reduced_motion: { type: 'string', enum: ['reduce', 'no-preference'] },
      locale: { type: 'string', maxLength: 35, description: 'A language tag, such as zh-CN.' },
      timezone: {
        type: 'string',
        maxLength: 64,
        description: 'An IANA time zone, such as America/New_York.',
      },
      geolocation: object(
        {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          accuracy: { type: 'number', minimum: 0, description: 'Metres; 50 by default.' },
        },
        ['latitude', 'longitude'],
      ),
      network: {
        type: 'string',
        enum: [...NETWORK_PRESETS],
        description: 'Throttles the tab, or takes it offline.',
      },
      off: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: [...EMULATION_ITEMS, 'all'] },
        description: 'Items to turn off, or all.',
      },
    }),
    outputSchema: output({
      emulation: { type: 'object', description: 'What the tab emulates now.' },
    }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_route',
    title: 'Mock network',
    description:
      'Mocks the network of your tabs: add a rule that answers requests whose address matches ' +
      'url with a fixed response, delays them, or fails them; list, remove or clear the rules. ' +
      'url is a whole address with * for any run of characters, or text the address must hold. ' +
      'The first rule that matches answers, in the order added. Rules last until the session’s ' +
      'browser closes; browser_network_requests marks the requests they answered. A page of a ' +
      'site that needs the user’s allow is never mocked itself.',
    inputSchema: object(
      {
        action: { type: 'string', enum: [...ROUTE_ACTIONS] },
        url: {
          type: 'string',
          maxLength: 2_000,
          description: 'For add: such as "http://localhost:3000/api/*" or "/api/users".',
        },
        method: { type: 'string', maxLength: 16, description: 'Only this method; any by default.' },
        status: { type: 'integer', minimum: 100, maximum: 599, description: '200 by default.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', maxLength: MAX_ROUTE_BODY },
        content_type: { type: 'string', maxLength: 200, description: 'Such as application/json.' },
        delay_ms: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_ROUTE_DELAY_MS,
          description: 'Waits this long first; alone, the request then goes to the network.',
        },
        abort: { type: 'string', enum: Object.keys(ROUTE_ABORTS), description: 'Fails it so.' },
        times: {
          type: 'integer',
          minimum: 1,
          maximum: 1_000,
          description: 'Answers only this many requests.',
        },
        id: { type: 'string', maxLength: 20, description: 'For remove: the rule’s id.' },
      },
      ['action'],
    ),
    outputSchema: output({
      rules: {
        type: 'array',
        items: object(
          {
            id: { type: 'string' },
            url: { type: 'string' },
            method: { type: ['string', 'null'] },
            does: { type: 'string', description: 'What it answers, in words.' },
            used: { type: 'integer', description: 'Requests it answered.' },
          },
          ['id', 'url', 'method', 'does', 'used'],
        ),
      },
    }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_downloads',
    title: 'Downloads',
    description:
      'Lists the files your pages downloaded in this session, with where each was saved, its ' +
      'size and whether it finished. They are saved under .kite/downloads in the session’s ' +
      'folder, where you can read them; the user is asked first for one over 50 MB.',
    inputSchema: object({}),
    outputSchema: output({
      downloads: {
        type: 'array',
        items: object(
          {
            name: { type: 'string' },
            path: { type: ['string', 'null'] },
            bytes: { type: 'integer' },
            state: {
              type: 'string',
              enum: ['waiting', 'progressing', 'completed', 'cancelled', 'interrupted'],
            },
          },
          ['name', 'path', 'bytes', 'state'],
        ),
      },
    }),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'browser_pdf',
    title: 'Save as PDF',
    description:
      'Saves the page of your current tab as a PDF under .kite/downloads in the session’s ' +
      'folder, and returns its path, which you can read.',
    inputSchema: object({
      landscape: { type: 'boolean', default: false },
      print_background: { type: 'boolean', default: true },
    }),
    outputSchema: output({ path: { type: 'string' }, bytes: { type: 'integer' } }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_trace',
    title: 'Performance trace',
    description:
      'Records a performance trace of your current tab for a few seconds, reloading the page ' +
      'first with reload, and returns a short summary: long tasks, the scripts that ran longest, ' +
      'layout and style time, and the largest contentful paint.',
    inputSchema: object({
      seconds: {
        type: 'number',
        minimum: 1,
        maximum: MAX_TRACE_SECONDS,
        default: 3,
        description: `How long to record, at most ${MAX_TRACE_SECONDS} s.`,
      },
      reload: { type: 'boolean', default: false, description: 'Traces a reload of the page.' },
    }),
    outputSchema: output({ summary: { type: 'object' } }),
    annotations: { openWorldHint: false },
  },
  {
    name: 'browser_storage_state',
    title: 'Saved sign-in states',
    description:
      'Saves the signed-in state of your current tab’s site (its cookies and local storage) ' +
      'under a name, restores a saved one into this session’s browser, or lists them. Kite keeps ' +
      'them encrypted, and you never see their values. Sign in once, save, and restore it in ' +
      'another session or worktree whose browser data is its own; open the site again after a ' +
      'restore.',
    inputSchema: object(
      {
        action: { type: 'string', enum: [...STORAGE_ACTIONS] },
        name: {
          type: 'string',
          maxLength: MAX_STATE_NAME,
          description: 'For save and restore, such as "admin".',
        },
      },
      ['action'],
    ),
    outputSchema: output({
      states: {
        type: 'array',
        items: object(
          {
            name: { type: 'string' },
            sites: { type: 'array', items: { type: 'string' } },
            saved_at: { type: 'string' },
          },
          ['name', 'sites', 'saved_at'],
        ),
      },
    }),
    annotations: { openWorldHint: false },
  },
]

const NAMES = new Set<string>(BROWSER_TOOL_NAMES)

export function isBrowserToolName(name: string): boolean {
  return NAMES.has(name)
}

type Args = Record<string, unknown>

/** An argument that does not fit its schema; its answer goes back as the tool error. */
class BrowserArgsError extends Error {
  constructor(readonly answer: BrowserCallAnswer) {
    super('Invalid arguments')
  }
}

function invalid(message: string): BrowserArgsError {
  return new BrowserArgsError({ error: { code: 'invalid', message } })
}

/** A call, checked as its schema says, ready for main. */
export interface BrowserCall {
  tool: BrowserToolName
  args: Args
}

function checked(name: BrowserToolName, value: unknown): BrowserCall {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'object' || Array.isArray(value))
  ) {
    throw invalid('The arguments must be an object.')
  }
  const o = (value ?? {}) as Args
  const allowed: Record<string, string[]> = {
    browser_navigate: ['url', 'forward_ports'],
    browser_navigate_back: [],
    browser_reload: [],
    browser_snapshot: ['ref', 'depth'],
    browser_click: ['ref', 'element', 'double', 'button'],
    browser_type: ['ref', 'element', 'text', 'submit', 'slowly'],
    browser_press_key: ['key'],
    browser_scroll: ['ref', 'direction', 'amount'],
    browser_select_option: ['ref', 'element', 'values'],
    browser_take_screenshot: ['ref', 'full_page'],
    browser_wait_for: ['text', 'text_gone', 'selector', 'ref', 'state', 'time'],
    browser_console_messages: ['since_navigation', 'level'],
    browser_network_requests: ['since_navigation', 'url', 'include_static'],
    browser_network_request: ['id'],
    browser_evaluate: ['function', 'ref'],
    browser_ask_user: ['step', 'reason'],
    browser_tabs: ['action', 'index'],
    browser_upload_file: ['paths', 'ref', 'element'],
    browser_resize: ['size', 'width', 'height'],
  }
  if (isArgsTool(name)) {
    // Huli: the second batch's tools are checked by the parsers main runs again.
    // Main parses them again from what the agent gave, so they go on as given.
    try {
      BROWSER_ARGS[name](o)
      return { tool: name, args: o }
    } catch (error) {
      if (error instanceof BrowserArgsInvalid) throw invalid(error.message)
      throw error
    }
  }
  for (const key of Object.keys(o)) {
    if (!allowed[name].includes(key)) throw invalid(`Unknown argument ${key}.`)
  }
  const text = (key: string, required: boolean, max = MAX_TEXT_CHARS): string | undefined => {
    const given = o[key]
    if (given === undefined) {
      if (required) throw invalid(`${key} is needed.`)
      return undefined
    }
    if (typeof given !== 'string' || given.length > max) {
      throw invalid(`${key} must be text of at most ${max} characters.`)
    }
    return given
  }
  const flag = (key: string): boolean | undefined => {
    const given = o[key]
    if (given === undefined) return undefined
    if (typeof given !== 'boolean') throw invalid(`${key} must be true or false.`)
    return given
  }
  const ref = (required: boolean): string | undefined => {
    const given = o.ref
    if (given === undefined) {
      if (required) throw invalid('ref is needed.')
      return undefined
    }
    if (typeof given !== 'string' || !/^e[0-9]+$/.test(given)) {
      throw invalid('ref must be a ref such as e12.')
    }
    return given
  }
  const args: Args = {}
  switch (name) {
    case 'browser_navigate': {
      const url = text('url', true, 8_192)!
      if (url.trim() === '') throw invalid('url must not be empty.')
      args.url = url
      if (o.forward_ports !== undefined) {
        if (
          !Array.isArray(o.forward_ports) ||
          o.forward_ports.length === 0 ||
          o.forward_ports.length > MAX_COMPANION_FORWARDS
        ) {
          throw invalid(`forward_ports must list 1 to ${MAX_COMPANION_FORWARDS} TCP ports.`)
        }
        if (!o.forward_ports.every(isBrowserForwardPort)) {
          throw invalid('forward_ports must contain whole port numbers from 1 to 65535.')
        }
        if (loopbackForward(url) === null) {
          throw invalid('forward_ports can only be used when opening a local dev server URL.')
        }
        args.forward_ports = [...new Set(o.forward_ports)]
      }
      break
    }
    case 'browser_snapshot': {
      const element = ref(false)
      if (element !== undefined) args.ref = element
      if (o.depth !== undefined) {
        if (
          typeof o.depth !== 'number' ||
          !Number.isInteger(o.depth) ||
          o.depth < 0 ||
          o.depth > MAX_SNAPSHOT_DEPTH
        ) {
          throw invalid(`depth must be a whole number from 0 to ${MAX_SNAPSHOT_DEPTH}.`)
        }
        args.depth = o.depth
      }
      break
    }
    case 'browser_click': {
      args.ref = ref(true)
      if (o.element !== undefined) args.element = text('element', false, 200)
      const double = flag('double')
      if (double !== undefined) args.double = double
      if (o.button !== undefined) {
        if (!['left', 'right', 'middle'].includes(String(o.button))) {
          throw invalid('button must be left, right or middle.')
        }
        args.button = o.button
      }
      break
    }
    case 'browser_type': {
      args.ref = ref(true)
      args.text = text('text', true)!
      if (o.element !== undefined) args.element = text('element', false, 200)
      const submit = flag('submit')
      if (submit !== undefined) args.submit = submit
      const slowly = flag('slowly')
      if (slowly !== undefined) args.slowly = slowly
      break
    }
    case 'browser_press_key': {
      const key = text('key', true, 60)!
      if (key.trim() === '') throw invalid('key must not be empty.')
      args.key = key
      break
    }
    case 'browser_scroll': {
      const element = ref(false)
      if (element !== undefined) args.ref = element
      if (!['up', 'down', 'left', 'right'].includes(String(o.direction))) {
        throw invalid('direction must be up, down, left or right.')
      }
      args.direction = o.direction
      if (o.amount !== undefined) {
        if (typeof o.amount !== 'number' || !(o.amount > 0) || o.amount > 50) {
          throw invalid('amount must be a number of screens from 0 to 50.')
        }
        args.amount = o.amount
      }
      break
    }
    case 'browser_select_option': {
      args.ref = ref(true)
      if (o.element !== undefined) args.element = text('element', false, 200)
      if (!Array.isArray(o.values) || o.values.length === 0 || o.values.length > MAX_VALUES) {
        throw invalid(`values must list 1 to ${MAX_VALUES} option values.`)
      }
      if (!o.values.every((item) => typeof item === 'string')) {
        throw invalid('values must be text.')
      }
      args.values = o.values
      break
    }
    case 'browser_take_screenshot': {
      const element = ref(false)
      if (element !== undefined) args.ref = element
      const full = flag('full_page')
      if (full !== undefined) args.full_page = full
      break
    }
    case 'browser_wait_for': {
      const waiting = text('text', false)
      const gone = text('text_gone', false)
      const selector = text('selector', false, MAX_SELECTOR_CHARS)
      const element = ref(false)
      if (waiting !== undefined) args.text = waiting
      if (gone !== undefined) args.text_gone = gone
      if (selector !== undefined) {
        if (selector.trim() === '') throw invalid('selector must not be empty.')
        args.selector = selector
      }
      if (element !== undefined) args.ref = element
      if (o.state !== undefined) {
        if (!(BROWSER_WAIT_STATES as readonly unknown[]).includes(o.state)) {
          throw invalid('state must be visible, hidden, attached or detached.')
        }
        if (selector === undefined && element === undefined) {
          throw invalid('state is for selector or ref.')
        }
        args.state = o.state
      }
      if (o.time !== undefined) {
        if (typeof o.time !== 'number' || !Number.isFinite(o.time) || o.time < 0 || o.time > 30) {
          throw invalid('time must be 0 to 30 seconds.')
        }
        args.time = o.time
      }
      const conditions = [waiting, gone, selector, element].filter((given) => given !== undefined)
      if (conditions.length > 1) throw invalid('Give one of text, text_gone, selector and ref.')
      if (conditions.length === 0 && args.time === undefined) {
        throw invalid('Give text, text_gone, selector, ref or time to wait for.')
      }
      break
    }
    case 'browser_console_messages': {
      const since = flag('since_navigation')
      if (since !== undefined) args.since_navigation = since
      if (o.level !== undefined) {
        if (!(BROWSER_CONSOLE_LEVELS as readonly unknown[]).includes(o.level)) {
          throw invalid('level must be error, warn, info or all.')
        }
        args.level = o.level
      }
      break
    }
    case 'browser_network_requests': {
      const since = flag('since_navigation')
      if (since !== undefined) args.since_navigation = since
      const url = text('url', false, MAX_URL_FILTER_CHARS)
      if (url !== undefined && url !== '') args.url = url
      const statics = flag('include_static')
      if (statics !== undefined) args.include_static = statics
      break
    }
    case 'browser_network_request': {
      const id = text('id', true, MAX_REQUEST_ID_CHARS)!
      if (id.trim() === '') throw invalid('id must not be empty.')
      args.id = id
      break
    }
    case 'browser_ask_user': {
      if (!isControlStep(o.step)) throw invalid('step must be sign_in, code, check or other.')
      args.step = o.step
      const reason = text('reason', true, MAX_REASON_CHARS)!
      if (reason.trim() === '') throw invalid('reason must say why.')
      args.reason = reason
      break
    }
    case 'browser_tabs': {
      if (!(BROWSER_TAB_ACTIONS as readonly unknown[]).includes(o.action)) {
        throw invalid('action must be list, new, select or close.')
      }
      args.action = o.action
      if (o.index !== undefined) {
        if (
          typeof o.index !== 'number' ||
          !Number.isInteger(o.index) ||
          o.index < 0 ||
          o.index >= MAX_SESSION_TABS
        ) {
          throw invalid(`index must be a whole number from 0 to ${MAX_SESSION_TABS - 1}.`)
        }
        if (o.action === 'list' || o.action === 'new') {
          throw invalid(`index is for select and close, not ${String(o.action)}.`)
        }
        args.index = o.index
      } else if (o.action === 'select') {
        throw invalid('index is needed to select a tab.')
      }
      break
    }
    case 'browser_upload_file': {
      // Main checks the files themselves; this keeps a malformed call from reaching it.
      if (!Array.isArray(o.paths) || o.paths.length === 0 || o.paths.length > MAX_UPLOAD_FILES) {
        throw invalid(`paths must list 1 to ${MAX_UPLOAD_FILES} files.`)
      }
      for (const path of o.paths) {
        if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) {
          throw invalid('Each path must be text.')
        }
        if (!isAbsolute(path)) {
          throw invalid(`${JSON.stringify(path)} is not an absolute path.`)
        }
      }
      args.paths = o.paths
      const element = ref(false)
      if (element !== undefined) args.ref = element
      if (o.element !== undefined) args.element = text('element', false, 200)
      break
    }
    case 'browser_resize': {
      const size = pageSizeOf(o)
      if ('error' in size) throw invalid(size.error)
      if (size.name === 'custom') {
        args.width = size.width
        args.height = size.height
      } else {
        args.size = size.name
      }
      break
    }
    case 'browser_evaluate': {
      const source = text('function', true, MAX_SCRIPT_CHARS)!
      if (source.trim() === '') throw invalid('function must be JavaScript.')
      args.function = source
      const element = ref(false)
      if (element !== undefined) args.ref = element
      break
    }
    default:
      break
  }
  return { tool: name, args }
}

/** How long a call may take, by the tool and its arguments. */
export function timeoutFor(tool: BrowserToolName, args: Args): number {
  // It returns once the user answers, or to be called again before the harness's own limit.
  if (tool === 'browser_ask_user' || tool === 'browser_upload_file') {
    return CONTROL_WAIT_MS + WAIT_EXTRA_MS
  }
  // Selecting a released tab loads its page again.
  if (
    tool === 'browser_navigate' ||
    tool === 'browser_navigate_back' ||
    tool === 'browser_reload' ||
    tool === 'browser_tabs'
  )
    return NAVIGATION_TIMEOUT_MS
  if (tool === 'browser_wait_for') {
    const seconds = typeof args.time === 'number' ? args.time : MAX_WAIT_SECONDS
    return Math.round(seconds * 1000) + WAIT_EXTRA_MS
  }
  // Huli: a trace records for its seconds, after a reload when asked, then reads the trace.
  if (tool === 'browser_trace') {
    const seconds = typeof args.seconds === 'number' ? args.seconds : 3
    return Math.round(seconds * 1000) + NAVIGATION_TIMEOUT_MS
  }
  if (tool === 'browser_pdf' || tool === 'browser_storage_state') return NAVIGATION_TIMEOUT_MS
  return ACTION_TIMEOUT_MS
}

function failure(error: { code: BrowserToolErrorCode; message: string }): CallToolResult {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { code: error.code, message: error.message },
    isError: true,
  }
}

export class BrowserTools {
  private nextId = 1
  // The user's answer each tab of theirs waits on, by session and tab, so a call made again while
  // they decide waits on the same card rather than asking twice.
  private readonly asking = new Map<string, Promise<SurfaceAccessAnswer>>()
  // Allows the user gave while no call waited on the card, which the agent's next call takes to
  // the page; once there, the page keeps them.
  private readonly granted = new Set<string>()
  /** The waits the origin requests of `browser_waiting` start and end, by the call's id. */
  private readonly waits = new Map<number, (waiting: boolean) => void>()

  constructor(private readonly deps: BrowserToolDeps) {}

  /**
   * Serves a call. The session whose page it drives is the caller's, or for a subagent the one it
   * runs under; a call main does not answer in its time fails with `timeout`.
   */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isBrowserToolName(name)) throw new Error(`Unknown tool ${name}`)
    const tool = name as BrowserToolName
    let asked: BrowserCall
    try {
      asked = checked(tool, input)
    } catch (error) {
      if (error instanceof BrowserArgsError && 'error' in error.answer) {
        return failure(error.answer.error)
      }
      throw error
    }
    const page = this.deps.pageOf(caller.sessionId)
    if (page === null) {
      return failure({
        code: 'no_page',
        message: 'This session no longer exists, so it has no browser.',
      })
    }
    const projectPath = this.deps.projectOf(page)
    const folder = this.deps.folderOf?.(page) ?? null
    const request: BrowserCallRequest = {
      callId: this.nextId++,
      sessionId: page,
      tool,
      args: asked.args,
      projectPath,
      ...(folder ? { folder, worktree: folder !== projectPath } : {}),
    }
    let answer = await this.forward(request, timeoutFor(tool, asked.args), caller.sessionId)
    const theirs =
      'error' in answer && answer.error.code === 'needs_allow' ? answer.error.tab : null
    if (theirs && typeof theirs.id === 'string' && typeof theirs.title === 'string') {
      const tab = { id: theirs.id, title: theirs.title.slice(0, MAX_TAB_TITLE) }
      const decision = await this.allowed(page, tab)
      if (decision === 'waiting') {
        return failure({
          code: 'needs_allow',
          message: `The user has not answered yet whether you may use their tab "${tab.title}". Call again to keep waiting.`,
        })
      }
      if (decision !== 'allow') {
        return failure({
          code: 'not_allowed',
          message: `The user did not allow this session to use their tab "${tab.title}". Leave it alone unless they bring it up; open a tab of your own with browser_tabs if you need one.`,
        })
      }
      const again = { ...request, callId: this.nextId++, allowTab: tab.id }
      answer = await this.forward(again, timeoutFor(tool, asked.args), caller.sessionId)
    }
    if ('error' in answer) return failure(answer.error)
    return this.result(tool, answer.result)
  }

  /**
   * Whether the agent may use a tab the user opened: one they referenced, or any in Full access,
   * at once; else their answer in a card, or `waiting` after CONTROL_WAIT_MS, to be called again.
   */
  private async allowed(
    sessionId: string,
    tab: { id: string; title: string },
  ): Promise<SurfaceAccessAnswer | 'waiting'> {
    const access = this.deps.access
    if (!access) return 'deny'
    if (access.shared(sessionId, tab.id)) return 'allow'
    if (access.fullAccess(sessionId)) {
      access.used(sessionId, tab.title)
      return 'allow'
    }
    const key = `${sessionId}\n${tab.id}`
    if (this.granted.delete(key)) return 'allow'
    let asking = this.asking.get(key)
    if (!asking) {
      asking = access
        .ask(sessionId, tab)
        .then((answer) => {
          if (answer === 'allow') this.granted.add(key)
          return answer
        })
        .finally(() => this.asking.delete(key))
      this.asking.set(key, asking)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const decision = await Promise.race([
      asking,
      new Promise<'waiting'>((resolve) => {
        timer = setTimeout(() => resolve('waiting'), CONTROL_WAIT_MS)
      }),
    ])
    clearTimeout(timer)
    // This call takes the allow to the page itself.
    if (decision === 'allow') this.granted.delete(key)
    return decision
  }

  /** `host:browser-waiting`: the call waits on a new origin, or that wait ended. */
  browserWaiting(callId: number, waiting: boolean): void {
    this.waits.get(callId)?.(waiting)
  }

  /**
   * Forwards the call and settles with main's answer, or `timeout` after `ms`. While the call waits
   * on the user, for a new site or while they hold the page, its limit grows to that wait's.
   */
  private forward(
    request: BrowserCallRequest,
    ms: number,
    caller: string,
  ): Promise<BrowserCallAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let limit = ms
    const settle = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () =>
          resolve({
            error: {
              code: 'timeout',
              message: `The browser did not answer within ${Math.round(limit / 1000)} s. Check the page and try again.`,
            },
          }),
        limit,
      )
      timer.unref?.()
    }
    let resolve!: (answer: BrowserCallAnswer) => void
    const timeout = new Promise<BrowserCallAnswer>((done) => (resolve = done))
    settle()
    const waiting = (on: boolean): void => {
      limit = on ? Math.max(ms, ORIGIN_WAIT_MS + WAIT_EXTRA_MS) : ms
      settle()
    }
    this.waits.set(request.callId, waiting)
    const forwarded = this.deps
      .call(request, caller)
      .catch((error: unknown): BrowserCallAnswer => ({
        error: { code: 'invalid', message: (error as Error)?.message ?? String(error) },
      }))
    const clear = (): void => {
      if (timer) clearTimeout(timer)
      this.waits.delete(request.callId)
    }
    return Promise.race([forwarded, timeout]).finally(clear)
  }

  private result(
    tool: BrowserToolName,
    result: { text: string; value: Record<string, unknown>; image?: string },
  ): CallToolResult {
    const content: CallToolResult['content'] = [{ type: 'text', text: result.text }]
    if (tool === 'browser_take_screenshot' && result.image) {
      content.push({ type: 'image', data: result.image, mimeType: 'image/png' })
    }
    return { content, structuredContent: result.value }
  }
}

// Huli: the arguments of the browser tools of the second batch (emulation, network mocking, hover,
// drag, a click at a point, downloads, PDF, a trace and saved sign-in states). The agent host checks
// them before a call goes out and main checks them again before it runs one, since another
// computer's host sends calls too; each parser answers the arguments as main uses them.

/** An argument that does not fit; its message goes back to the agent as the tool's error. */
export class BrowserArgsInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserArgsInvalid'
  }
}

type Args = Record<string, unknown>

function invalid(message: string): never {
  throw new BrowserArgsInvalid(message)
}

function only(o: Args, keys: readonly string[]): void {
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) invalid(`Unknown argument ${key}.`)
  }
}

function isObject(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function number(o: Args, key: string, min: number, max: number): number | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${key} must be a number from ${min} to ${max}.`)
  }
  return value
}

function integer(o: Args, key: string, min: number, max: number): number | undefined {
  const value = number(o, key, min, max)
  if (value !== undefined && !Number.isInteger(value)) {
    invalid(`${key} must be a whole number from ${min} to ${max}.`)
  }
  return value
}

function flag(o: Args, key: string): boolean | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalid(`${key} must be true or false.`)
  return value
}

function text(o: Args, key: string, max: number, required = false): string | undefined {
  const value = o[key]
  if (value === undefined) {
    if (required) invalid(`${key} is needed.`)
    return undefined
  }
  if (typeof value !== 'string' || value.length > max) {
    invalid(`${key} must be text of at most ${max} characters.`)
  }
  return value
}

function oneOf<T extends string>(o: Args, key: string, values: readonly T[]): T | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (!(values as readonly unknown[]).includes(value)) {
    invalid(`${key} must be one of ${values.join(', ')}.`)
  }
  return value as T
}

const REF = /^e[0-9]+$/

function ref(o: Args, key: string): string {
  const value = o[key]
  if (typeof value !== 'string' || !REF.test(value)) invalid(`${key} must be a ref such as e12.`)
  return value
}

/** A label for the element a ref names, which the result and the thread show; at most 200. */
function element(o: Args, key: string): string | undefined {
  return text(o, key, 200)
}

// --- Emulation -----------------------------------------------------------------------------------

export interface DevicePreset {
  id: string
  label: string
  width: number
  height: number
  scale: number
  mobile: boolean
  touch: boolean
  /** Which browser's user agent the page sees; null keeps the browser's own. */
  agent: 'ios' | 'ipad' | 'android' | null
}

/** The devices `browser_emulate` knows by name; their sizes are each one's CSS viewport. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {
    id: 'iphone-15',
    label: 'iPhone 15',
    width: 393,
    height: 852,
    scale: 3,
    mobile: true,
    touch: true,
    agent: 'ios',
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    width: 375,
    height: 667,
    scale: 2,
    mobile: true,
    touch: true,
    agent: 'ios',
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    width: 412,
    height: 915,
    scale: 2.625,
    mobile: true,
    touch: true,
    agent: 'android',
  },
  {
    id: 'galaxy-s24',
    label: 'Galaxy S24',
    width: 360,
    height: 780,
    scale: 3,
    mobile: true,
    touch: true,
    agent: 'android',
  },
  {
    id: 'ipad-mini',
    label: 'iPad mini',
    width: 768,
    height: 1024,
    scale: 2,
    mobile: true,
    touch: true,
    agent: 'ipad',
  },
  {
    id: 'ipad-pro-11',
    label: 'iPad Pro 11',
    width: 834,
    height: 1194,
    scale: 2,
    mobile: true,
    touch: true,
    agent: 'ipad',
  },
  {
    id: 'laptop',
    label: 'Laptop',
    width: 1366,
    height: 768,
    scale: 1,
    mobile: false,
    touch: false,
    agent: null,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    width: 1920,
    height: 1080,
    scale: 1,
    mobile: false,
    touch: false,
    agent: null,
  },
]

export const NETWORK_PRESETS = ['offline', 'slow-3g', 'fast-3g', '4g'] as const
export type NetworkPreset = (typeof NETWORK_PRESETS)[number]

/** Each preset's conditions, as Chrome DevTools throttles them. */
export const NETWORK_CONDITIONS: Record<
  Exclude<NetworkPreset, 'offline'>,
  { latencyMs: number; downloadKbps: number; uploadKbps: number }
> = {
  'slow-3g': { latencyMs: 2_000, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { latencyMs: 563, downloadKbps: 1_440, uploadKbps: 675 },
  '4g': { latencyMs: 165, downloadKbps: 8_100, uploadKbps: 8_100 },
}

/** What `off` names: one emulated item, or all of them. */
export const EMULATION_ITEMS = [
  'device',
  'color_scheme',
  'reduced_motion',
  'locale',
  'timezone',
  'geolocation',
  'network',
] as const
export type EmulationItem = (typeof EMULATION_ITEMS)[number]

export interface EmulatedDevice {
  /** The preset's label, or null for a size given in numbers. */
  label: string | null
  width: number
  height: number
  scale: number
  mobile: boolean
  touch: boolean
  agent: DevicePreset['agent']
}

export interface EmulatedNetwork {
  /** The preset, or null for conditions given in numbers. */
  preset: NetworkPreset | null
  offline: boolean
  latencyMs: number
  downloadKbps: number
  uploadKbps: number
}

/** What a tab emulates; null for an item it leaves as the browser has it. */
export interface BrowserEmulation {
  device: EmulatedDevice | null
  colorScheme: 'light' | 'dark' | null
  reducedMotion: 'reduce' | 'no-preference' | null
  locale: string | null
  timezone: string | null
  geolocation: { latitude: number; longitude: number; accuracy: number } | null
  network: EmulatedNetwork | null
}

export const NO_EMULATION: BrowserEmulation = {
  device: null,
  colorScheme: null,
  reducedMotion: null,
  locale: null,
  timezone: null,
  geolocation: null,
  network: null,
}

/** Whether a tab emulates anything, which the pane's chip shows. */
export function emulating(emulation: BrowserEmulation | null | undefined): boolean {
  if (!emulation) return false
  return Object.values(emulation).some((value) => value !== null)
}

/** A change `browser_emulate` asks for: the items it sets, and those it turns off. */
export interface EmulationChange {
  set: Partial<BrowserEmulation>
  off: EmulationItem[]
}

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$/
const TIMEZONE = /^(UTC|GMT|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/

/** The device a name gives, in any case and with spaces or dashes; undefined when none is. */
export function devicePreset(name: string): DevicePreset | undefined {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-')
  return DEVICE_PRESETS.find(
    (device) => device.id === key || device.label.toLowerCase().replace(/\s+/g, '-') === key,
  )
}

export function emulateArgs(o: Args): EmulationChange {
  only(o, [
    'device',
    'viewport',
    'color_scheme',
    'reduced_motion',
    'locale',
    'timezone',
    'geolocation',
    'network',
    'off',
  ])
  const set: Partial<BrowserEmulation> = {}
  const off: EmulationItem[] = []
  if (o.off !== undefined) {
    if (!Array.isArray(o.off) || o.off.length === 0 || o.off.length > 8) {
      invalid('off must list the items to turn off, or "all".')
    }
    for (const item of o.off) {
      if (item === 'all') off.push(...EMULATION_ITEMS)
      else if ((EMULATION_ITEMS as readonly unknown[]).includes(item)) {
        off.push(item as EmulationItem)
      } else invalid(`off takes ${EMULATION_ITEMS.join(', ')} or all.`)
    }
  }
  if (o.device !== undefined && o.viewport !== undefined) {
    invalid('Give device or viewport, not both.')
  }
  if (o.device !== undefined) {
    const name = text(o, 'device', 60, true)!
    const preset = devicePreset(name)
    if (!preset) {
      invalid(
        `Unknown device "${name}". Use one of ${DEVICE_PRESETS.map((d) => d.id).join(', ')}, or viewport.`,
      )
    }
    const { label, width, height, scale, mobile, touch, agent } = preset
    set.device = { label, width, height, scale, mobile, touch, agent }
  }
  if (o.viewport !== undefined) {
    if (!isObject(o.viewport)) invalid('viewport must be an object with width and height.')
    const view = o.viewport
    only(view, ['width', 'height', 'device_scale_factor', 'mobile', 'touch'])
    const width = integer(view, 'width', 200, 3_840)
    const height = integer(view, 'height', 200, 3_840)
    if (width === undefined || height === undefined) invalid('viewport needs width and height.')
    const mobile = flag(view, 'mobile') ?? false
    set.device = {
      label: null,
      width,
      height,
      scale: number(view, 'device_scale_factor', 1, 4) ?? 1,
      mobile,
      touch: flag(view, 'touch') ?? mobile,
      agent: null,
    }
  }
  const scheme = oneOf(o, 'color_scheme', ['light', 'dark'] as const)
  if (scheme !== undefined) set.colorScheme = scheme
  const motion = oneOf(o, 'reduced_motion', ['reduce', 'no-preference'] as const)
  if (motion !== undefined) set.reducedMotion = motion
  const locale = text(o, 'locale', 35)
  if (locale !== undefined) {
    if (!LOCALE.test(locale)) invalid('locale must be a language tag such as en-US or zh-CN.')
    set.locale = locale
  }
  const timezone = text(o, 'timezone', 64)
  if (timezone !== undefined) {
    if (!TIMEZONE.test(timezone)) {
      invalid('timezone must be an IANA time zone such as Asia/Shanghai, or UTC.')
    }
    set.timezone = timezone
  }
  if (o.geolocation !== undefined) {
    if (!isObject(o.geolocation))
      invalid('geolocation must be an object with latitude and longitude.')
    const at = o.geolocation
    only(at, ['latitude', 'longitude', 'accuracy'])
    const latitude = number(at, 'latitude', -90, 90)
    const longitude = number(at, 'longitude', -180, 180)
    if (latitude === undefined || longitude === undefined) {
      invalid('geolocation needs latitude and longitude.')
    }
    set.geolocation = { latitude, longitude, accuracy: number(at, 'accuracy', 0, 100_000) ?? 50 }
  }
  if (o.network !== undefined) {
    if (typeof o.network === 'string') {
      const preset = oneOf(o, 'network', NETWORK_PRESETS)!
      set.network =
        preset === 'offline'
          ? { preset, offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 }
          : { preset, offline: false, ...NETWORK_CONDITIONS[preset] }
    } else if (isObject(o.network)) {
      const given = o.network
      only(given, ['latency_ms', 'download_kbps', 'upload_kbps'])
      const latencyMs = integer(given, 'latency_ms', 0, 10_000) ?? 0
      const downloadKbps = integer(given, 'download_kbps', 1, 1_000_000)
      const uploadKbps = integer(given, 'upload_kbps', 1, 1_000_000)
      if (downloadKbps === undefined || uploadKbps === undefined) {
        invalid('network needs download_kbps and upload_kbps, or a preset name.')
      }
      set.network = { preset: null, offline: false, latencyMs, downloadKbps, uploadKbps }
    } else {
      invalid(`network must be ${NETWORK_PRESETS.join(', ')}, or an object of numbers.`)
    }
  }
  for (const item of off) {
    if (KEY_OF[item] in set) invalid(`${item} is both set and turned off.`)
  }
  if (Object.keys(set).length === 0 && off.length === 0) {
    invalid('Give something to emulate, or off to turn emulation off.')
  }
  return { set, off: [...new Set(off)] }
}

/** The field of BrowserEmulation each `off` item names. */
export const KEY_OF: Record<EmulationItem, keyof BrowserEmulation> = {
  device: 'device',
  color_scheme: 'colorScheme',
  reduced_motion: 'reducedMotion',
  locale: 'locale',
  timezone: 'timezone',
  geolocation: 'geolocation',
  network: 'network',
}

/** A tab's emulation after a change. */
export function changedEmulation(
  before: BrowserEmulation,
  change: EmulationChange,
): BrowserEmulation {
  const next: BrowserEmulation = { ...before }
  for (const item of change.off) {
    ;(next as unknown as Record<string, unknown>)[KEY_OF[item]] = null
  }
  return { ...next, ...change.set }
}

// --- Network mocking -----------------------------------------------------------------------------

export const ROUTE_ACTIONS = ['add', 'list', 'remove', 'clear'] as const
export type RouteAction = (typeof ROUTE_ACTIONS)[number]

/** How a mocked request fails, as `Fetch.failRequest` names them. */
export const ROUTE_ABORTS = {
  failed: 'Failed',
  aborted: 'Aborted',
  timed_out: 'TimedOut',
  connection_refused: 'ConnectionRefused',
  internet_disconnected: 'InternetDisconnected',
  blocked: 'BlockedByClient',
} as const
export type RouteAbort = keyof typeof ROUTE_ABORTS

export const MAX_ROUTES = 50
export const MAX_ROUTE_BODY = 256 * 1024
export const MAX_ROUTE_DELAY_MS = 30_000
const MAX_HEADERS = 50
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/

/** What a rule does with a request it matches. */
export type RouteResponse =
  | { kind: 'fulfill'; status: number; headers: [string, string][]; body: string }
  | { kind: 'abort'; reason: RouteAbort }
  | { kind: 'continue' }

export interface RouteRuleSpec {
  pattern: string
  /** Upper case, or null for any method. */
  method: string | null
  response: RouteResponse
  delayMs: number
  /** How many requests it answers before it goes; null for every one. */
  times: number | null
}

export type RouteCall =
  | { action: 'add'; rule: RouteRuleSpec }
  | { action: 'list' }
  | { action: 'clear' }
  | { action: 'remove'; id: string }

export function routeArgs(o: Args): RouteCall {
  const action = oneOf(o, 'action', ROUTE_ACTIONS)
  if (action === undefined) invalid(`action must be one of ${ROUTE_ACTIONS.join(', ')}.`)
  if (action === 'list' || action === 'clear') {
    only(o, ['action'])
    return { action }
  }
  if (action === 'remove') {
    only(o, ['action', 'id'])
    const id = text(o, 'id', 20, true)!
    if (!/^r[0-9]+$/.test(id)) invalid('id must be a rule id such as r3, from the list.')
    return { action, id }
  }
  only(o, [
    'action',
    'url',
    'method',
    'status',
    'headers',
    'body',
    'content_type',
    'delay_ms',
    'abort',
    'times',
  ])
  const pattern = text(o, 'url', 2_000, true)!
  if (pattern.trim() === '' || pattern !== pattern.trim()) {
    invalid('url must be a URL pattern without spaces around it.')
  }
  if (/[\s]/.test(pattern)) invalid('url must not hold spaces.')
  let method: string | null = null
  const givenMethod = text(o, 'method', 16)
  if (givenMethod !== undefined && givenMethod !== '*') {
    if (!/^[A-Za-z]{3,16}$/.test(givenMethod)) invalid('method must be an HTTP method such as GET.')
    method = givenMethod.toUpperCase()
  }
  const delayMs = integer(o, 'delay_ms', 0, MAX_ROUTE_DELAY_MS) ?? 0
  const times = integer(o, 'times', 1, 1_000) ?? null
  const abort = oneOf(o, 'abort', Object.keys(ROUTE_ABORTS) as RouteAbort[])
  const status = integer(o, 'status', 100, 599)
  const contentType = text(o, 'content_type', 200)
  const body = text(o, 'body', MAX_ROUTE_BODY)
  const fulfills =
    status !== undefined || o.headers !== undefined || body !== undefined || !!contentType
  let response: RouteResponse
  if (abort !== undefined) {
    if (fulfills) invalid('abort takes no status, headers, body or content_type.')
    response = { kind: 'abort', reason: abort }
  } else if (fulfills) {
    const headers: [string, string][] = []
    if (o.headers !== undefined) {
      if (!isObject(o.headers)) invalid('headers must be an object of header names to values.')
      const entries = Object.entries(o.headers)
      if (entries.length > MAX_HEADERS) invalid(`headers takes at most ${MAX_HEADERS} headers.`)
      for (const [name, value] of entries) {
        if (!HEADER_NAME.test(name)) invalid(`"${name}" is not a header name.`)
        if (typeof value !== 'string' || value.length > 4_096 || /[\r\n\0]/.test(value)) {
          invalid(`The value of ${name} must be one line of text.`)
        }
        headers.push([name, value])
      }
    }
    if (contentType !== undefined) {
      if (/[\r\n\0]/.test(contentType)) invalid('content_type must be one line.')
      if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) {
        headers.push(['Content-Type', contentType])
      }
    }
    response = { kind: 'fulfill', status: status ?? 200, headers, body: body ?? '' }
  } else if (delayMs > 0) {
    response = { kind: 'continue' }
  } else {
    invalid('Give a response (status, headers or body), a delay_ms, or abort.')
  }
  return { action, rule: { pattern, method, response, delayMs, times } }
}

/**
 * A rule's URL pattern: a whole address with `*` for any run of characters when it holds a `*` or
 * a scheme, else text the address must contain. `test` is exact; `fetch` is the pattern the
 * DevTools protocol's Fetch domain pauses requests by, which may pause a few more.
 */
export function routePattern(pattern: string): { fetch: string; test: (url: string) => boolean } {
  const whole = pattern.includes('*') || /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)
  const escapeFetch = (part: string): string => part.replace(/[\\?]/g, (c) => `\\${c}`)
  if (!whole) {
    return { fetch: `*${escapeFetch(pattern)}*`, test: (url) => url.includes(pattern) }
  }
  const parts = pattern.split('*')
  const source = parts.map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')
  const matcher = new RegExp(`^${source}$`, 's')
  return { fetch: parts.map(escapeFetch).join('*'), test: (url) => matcher.test(url) }
}

/** Whether a rule answers a request, by its address and method. */
export function routeMatches(rule: RouteRuleSpec, url: string, method: string): boolean {
  if (rule.method !== null && rule.method !== method.toUpperCase()) return false
  return routePattern(rule.pattern).test(url)
}

// --- Interactions --------------------------------------------------------------------------------

export function hoverArgs(o: Args): { ref: string; element?: string } {
  only(o, ['ref', 'element'])
  const label = element(o, 'element')
  return { ref: ref(o, 'ref'), ...(label === undefined ? {} : { element: label }) }
}

export function dragArgs(o: Args): {
  start_ref: string
  start_element?: string
  end_ref: string
  end_element?: string
} {
  only(o, ['start_ref', 'start_element', 'end_ref', 'end_element'])
  const start = element(o, 'start_element')
  const end = element(o, 'end_element')
  const args = {
    start_ref: ref(o, 'start_ref'),
    end_ref: ref(o, 'end_ref'),
    ...(start === undefined ? {} : { start_element: start }),
    ...(end === undefined ? {} : { end_element: end }),
  }
  if (args.start_ref === args.end_ref) invalid('start_ref and end_ref must be two elements.')
  return args
}

export const MAX_CLICK_REASON = 200

export function clickAtArgs(o: Args): {
  x: number
  y: number
  reason: string
  button: 'left' | 'right' | 'middle'
  double: boolean
} {
  only(o, ['x', 'y', 'reason', 'button', 'double'])
  const x = number(o, 'x', 0, 10_000)
  const y = number(o, 'y', 0, 10_000)
  if (x === undefined || y === undefined) invalid('x and y are needed.')
  const reason = text(o, 'reason', MAX_CLICK_REASON, true)!.trim()
  if (reason === '') invalid('reason must say why the click goes by its point.')
  return {
    x,
    y,
    reason,
    button: oneOf(o, 'button', ['left', 'right', 'middle'] as const) ?? 'left',
    double: flag(o, 'double') ?? false,
  }
}

// --- Downloads, PDF and trace --------------------------------------------------------------------

/** Downloads above this size wait for the user's allow. */
export const DOWNLOAD_ASK_BYTES = 50 * 1024 * 1024

export function downloadsArgs(o: Args): Record<string, never> {
  only(o, [])
  return {}
}

export function pdfArgs(o: Args): { landscape: boolean; background: boolean } {
  only(o, ['landscape', 'print_background'])
  return {
    landscape: flag(o, 'landscape') ?? false,
    background: flag(o, 'print_background') ?? true,
  }
}

export const MAX_TRACE_SECONDS = 15

export function traceArgs(o: Args): { seconds: number; reload: boolean } {
  only(o, ['seconds', 'reload'])
  return {
    seconds: number(o, 'seconds', 1, MAX_TRACE_SECONDS) ?? 3,
    reload: flag(o, 'reload') ?? false,
  }
}

// --- Saved sign-in states ------------------------------------------------------------------------

export const STORAGE_ACTIONS = ['save', 'restore', 'list'] as const
export const MAX_STATE_NAME = 60

/** A saved state's name: one line of at most 60 characters, without spaces around it. */
export function isStateName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STATE_NAME &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

export function storageStateArgs(
  o: Args,
): { action: 'list' } | { action: 'save' | 'restore'; name: string } {
  const action = oneOf(o, 'action', STORAGE_ACTIONS)
  if (action === undefined) invalid(`action must be one of ${STORAGE_ACTIONS.join(', ')}.`)
  if (action === 'list') {
    only(o, ['action'])
    return { action }
  }
  only(o, ['action', 'name'])
  if (!isStateName(o.name)) {
    invalid(`name must be one line of 1 to ${MAX_STATE_NAME} characters, such as "admin".`)
  }
  return { action, name: o.name }
}

/** The tools whose arguments this file checks, by their parser. */
export const BROWSER_ARGS = {
  browser_emulate: emulateArgs,
  browser_route: routeArgs,
  browser_hover: hoverArgs,
  browser_drag: dragArgs,
  browser_click_at: clickAtArgs,
  browser_downloads: downloadsArgs,
  browser_pdf: pdfArgs,
  browser_trace: traceArgs,
  browser_storage_state: storageStateArgs,
} as const satisfies Record<string, (o: Args) => unknown>

export type BrowserArgsTool = keyof typeof BROWSER_ARGS

export function isArgsTool(name: string): name is BrowserArgsTool {
  return Object.hasOwn(BROWSER_ARGS, name)
}

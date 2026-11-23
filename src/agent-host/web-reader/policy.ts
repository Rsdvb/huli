// Huli: what `read_web_page` may read. Moli runs on this computer outside any sandbox, with the
// user's network position, so the tool reads public http(s) pages only: no file: or other
// schemes, no credentials in the address, and nothing on this computer or the local network but
// the session's own worktree ports (KITE_PORT), where its dev servers run, and those only while
// the session is not held by a sandbox. A page's own redirects and requests are held by Moli's
// private-network blocking (fetch.ts). Huli's own; see tools/huli/README.md (Background web
// reading).

import { isIP } from 'node:net'
import type { SandboxChoice } from '@shared/sandbox'
import {
  WEB_READ_CHARS,
  WEB_READ_FORMATS,
  WEB_READ_SECONDS,
  type WebReadFormat,
} from '@shared/web-reader'
import type { PortBlock } from '@shared/worktree-ports'

export const MAX_URL_CHARS = 4096
export const MAX_SELECTOR_CHARS = 500

export interface ReadRequest {
  url: URL
  format: WebReadFormat
  /** Only what matches this CSS selector, when set. */
  selector: string | null
  maxChars: number
  /** Wait until the page's scripts have finished changing it, rather than only for its load. */
  waitForJs: boolean
  /** Also wait until an element matches this CSS selector. */
  waitForSelector: string | null
  timeoutSeconds: number
}

/** Where the session may reach from: its sandbox and its worktree's ports. */
export interface ReadPlace {
  sandbox: SandboxChoice | null
  ports: PortBlock | null
}

/** Where a read that may go ahead goes. */
export interface ReadRoute {
  /** The session's own dev server on this computer. */
  local: boolean
}

export type Checked<T> = { ok: T } | { error: string }

const KEYS = [
  'url',
  'format',
  'selector',
  'max_chars',
  'wait_for_js',
  'wait_for_selector',
  'timeout_seconds',
] as const

/** Host names that only ever name this computer or the local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net']

function selectorOf(value: unknown, name: string): Checked<string | null> {
  if (value === undefined || value === null || value === '') return { ok: null }
  if (typeof value !== 'string') return { error: `${name} must be a CSS selector string` }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: null }
  if (trimmed.length > MAX_SELECTOR_CHARS) {
    return { error: `${name} is longer than ${MAX_SELECTOR_CHARS} characters` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { error: `${name} holds control characters` }
  return { ok: trimmed }
}

function integerIn(
  value: unknown,
  name: string,
  bounds: { default: number; min: number; max: number },
): Checked<number> {
  if (value === undefined || value === null) return { ok: bounds.default }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { error: `${name} must be a whole number` }
  }
  if (value < bounds.min || value > bounds.max) {
    return { error: `${name} must be between ${bounds.min} and ${bounds.max}` }
  }
  return { ok: value }
}

/** The tool's arguments, checked; the address's scheme and form here, its place in `checkPlace`. */
export function parseReadInput(input: unknown): Checked<ReadRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'The arguments must be an object' }
  }
  const raw = input as Record<string, unknown>
  const extra = Object.keys(raw).find((key) => !(KEYS as readonly string[]).includes(key))
  if (extra !== undefined) return { error: `Unknown argument "${extra}"` }
  const url = parseUrl(raw.url)
  if ('error' in url) return url
  const format = raw.format ?? 'markdown'
  if (!(WEB_READ_FORMATS as readonly unknown[]).includes(format)) {
    return { error: `format must be ${WEB_READ_FORMATS.join(', ')}` }
  }
  const selector = selectorOf(raw.selector, 'selector')
  if ('error' in selector) return selector
  const waitFor = selectorOf(raw.wait_for_selector, 'wait_for_selector')
  if ('error' in waitFor) return waitFor
  const maxChars = integerIn(raw.max_chars, 'max_chars', WEB_READ_CHARS)
  if ('error' in maxChars) return maxChars
  const timeout = integerIn(raw.timeout_seconds, 'timeout_seconds', WEB_READ_SECONDS)
  if ('error' in timeout) return timeout
  if (raw.wait_for_js !== undefined && typeof raw.wait_for_js !== 'boolean') {
    return { error: 'wait_for_js must be true or false' }
  }
  return {
    ok: {
      url: url.ok,
      format: format as WebReadFormat,
      selector: selector.ok,
      maxChars: maxChars.ok,
      waitForJs: raw.wait_for_js !== false,
      waitForSelector: waitFor.ok,
      timeoutSeconds: timeout.ok,
    },
  }
}

/** An http(s) address without credentials. */
export function parseUrl(value: unknown): Checked<URL> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'url must be an http or https address' }
  }
  if (value.length > MAX_URL_CHARS)
    return { error: `url is longer than ${MAX_URL_CHARS} characters` }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return { error: 'url is not a valid address' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Only http and https pages are read, not ${url.protocol}` }
  }
  if (url.username !== '' || url.password !== '') {
    return { error: 'An address with a user name or password in it is refused' }
  }
  if (url.hostname === '') return { error: 'url names no host' }
  return { ok: url }
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
}

function ipv4Parts(address: string): number[] {
  return address.split('.').map(Number)
}

function ipv4Private(address: string): { loopback: boolean; private: boolean } {
  const [a = 0, b = 0] = ipv4Parts(address)
  const loopback = a === 127
  const isPrivate =
    loopback ||
    a === 0 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  return { loopback, private: isPrivate }
}

/** An IPv6 address's mapped IPv4 one (`::ffff:127.0.0.1`, as URL writes it `::ffff:7f00:1`). */
function mappedIpv4(address: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (dotted) return dotted[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (!hex) return null
  const high = parseInt(hex[1]!, 16)
  const low = parseInt(hex[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

/** What an address in the URL names: this computer, the local network, or the internet. */
export function hostPlace(hostname: string): 'loopback' | 'private' | 'public' {
  const host = bareHost(hostname).replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  const kind = isIP(host)
  if (kind === 4) {
    const place = ipv4Private(host)
    return place.loopback ? 'loopback' : place.private ? 'private' : 'public'
  }
  if (kind === 6) {
    if (host === '::1') return 'loopback'
    if (host === '::') return 'private'
    const mapped = mappedIpv4(host)
    if (mapped) return hostPlace(mapped)
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('ff')) return 'private'
    return 'public'
  }
  // A name without a dot is a machine of the local network; some suffixes only ever are.
  if (!host.includes('.')) return 'private'
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private'
  return 'public'
}

function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/** Whether the session's sandbox lets it reach its own dev server on this computer. */
function sandboxAllowsLocal(sandbox: SandboxChoice | null): boolean {
  return !sandbox || sandbox.tier === 'off' || sandbox.network === 'open'
}

/**
 * Whether the session may read the address from where it is: never inside a container, nor in a
 * sandbox that keeps its commands off the network; this computer only on its own worktree ports.
 */
export function checkPlace(url: URL, place: ReadPlace): Checked<ReadRoute> {
  const { sandbox } = place
  if (sandbox?.tier === 'container') {
    return {
      error:
        'read_web_page is not available in a container session: Moli runs on the computer, ' +
        "outside the session's container, and would go around the container's network limits. " +
        'Use a tool inside the container instead.',
    }
  }
  if (sandbox?.tier === 'native' && sandbox.network === 'none') {
    return {
      error:
        "This session's sandbox keeps its commands off the network, and read_web_page follows " +
        'that choice. The user can change the sandbox’s network in the session’s sandbox menu.',
    }
  }
  const where = hostPlace(url.hostname)
  if (where === 'public') return { ok: { local: false } }
  if (where === 'private') {
    return {
      error:
        'read_web_page reads public pages only, not addresses on the local network. To check a ' +
        "page there, open it in Kite's browser with browser_navigate.",
    }
  }
  const port = portOf(url)
  const own =
    place.ports !== null &&
    port >= place.ports.first &&
    port < place.ports.first + place.ports.count
  if (!own) {
    return {
      error:
        "read_web_page reads this computer's pages only on the session's own worktree ports " +
        '(KITE_PORT)' +
        (place.ports
          ? `, ${place.ports.first} to ${place.ports.first + place.ports.count - 1}`
          : ', and this session has none') +
        ". To check another local page or dev server, open it in Kite's browser with " +
        'browser_navigate.',
    }
  }
  if (!sandboxAllowsLocal(sandbox)) {
    return {
      error:
        "This session's sandbox sends its network only through its Agent network exit, so " +
        "read_web_page does not read this computer's pages for it.",
    }
  }
  return { ok: { local: true } }
}

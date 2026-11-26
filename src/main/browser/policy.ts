// What keeps the side panel's browser to plain web pages: the partitions its sessions use, with
// every permission refused, downloads saved only where the user picks (Huli: an agent's into its
// session's folder), and requests to Kettu's own surfaces cancelled.

import { basename, join } from 'node:path'
import { app, type DownloadItem, type Session, type WebContents } from 'electron'
import { refuseRequests } from '../request-filter'

/** A request that never leaves the partition: a local file or one of Kettu's own schemes. */
export function isForbiddenRequest(url: string, servicePort: number | null): boolean {
  if (url.startsWith('file:') || url.startsWith('kettu-')) return true
  if (servicePort === null) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
    parsed.port === String(servicePort)
  )
}

/** Whether a top-level navigation may happen: http(s), and an empty document. */
export function isAllowedNavigation(url: string): boolean {
  return url === 'about:blank' || url === 'about:srcdoc' || isHttp(url)
}

/** Whether an address is one the page may load; the pane only ever asks for these. */
export function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Hosts an agent opens without asking: a dev server on this machine. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  )
}

/** Whether a parsed address is an http(s) page on a local dev host, or the empty document. */
export function isLocalAddress(url: URL): boolean {
  if (url.href === 'about:blank') return true
  return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalHost(url.hostname)
}

const NEVER_OPENED = new Set([
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'chrome:',
  'devtools:',
  'view-source:',
])

/** A scheme that never opens at the top level, whether an agent or the user asks. */
export function isNeverOpened(url: URL): boolean {
  return NEVER_OPENED.has(url.protocol) || url.protocol.startsWith('kettu-')
}

/** The user agent of the Chromium Electron ships, without the token that names Electron. */
export function stripElectronUserAgent(userAgent: string): string {
  return userAgent.replace(/\sElectron\/[\d.]+/g, '')
}

/** Cloudflare's challenge platform, which runs Turnstile's checks. */
const CHALLENGE_URLS = ['https://challenges.cloudflare.com/*']

/**
 * A challenge request's headers with Electron's own user agent in place of the stripped one;
 * a user agent a phone or tablet size set stays as it is.
 */
function challengeHeaders(
  headers: Record<string, string>,
  stripped: string,
  full: string,
): Record<string, string> {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'user-agent')
  if (!key || headers[key] !== stripped) return headers
  return { ...headers, [key]: full }
}

export interface BrowserPolicyDeps {
  /** A download the user saved, or one that failed; the pane says which, with the file's name. */
  downloadDone(contents: WebContents, name: string, saved: boolean): void
  /**
   * Huli: takes a download of a page an agent drives into its session's folder; false leaves it
   * to the system's save dialog, as the user's own downloads are.
   */
  agentDownload?(contents: WebContents, item: DownloadItem): boolean
  /**
   * Huli: whether the page emulates a location (browser_emulate). Only then may it ask for the
   * position, which is the emulated one: the computer's own never reaches a page.
   */
  fakeLocation?(contents: WebContents | null): boolean
}

/** The partition's rules, set once for every page. */
export class BrowserPolicy {
  private servicePort: number | null = null
  private installed = false

  constructor(
    private readonly session: Session,
    private readonly deps: BrowserPolicyDeps,
  ) {}

  install(): void {
    if (this.installed) return
    this.installed = true
    const full = this.session.getUserAgent()
    const stripped = stripElectronUserAgent(full)
    this.session.setUserAgent(stripped)
    // Turnstile fails a page whose fingerprint is Electron's while its requests claim another
    // Chromium (error 600010), so only its own requests say Electron.
    this.session.webRequest.onBeforeSendHeaders({ urls: CHALLENGE_URLS }, (details, callback) => {
      callback({ requestHeaders: challengeHeaders(details.requestHeaders, stripped, full) })
    })
    this.session.setPermissionRequestHandler((contents, permission, callback) =>
      callback(permission === 'geolocation' && this.deps.fakeLocation?.(contents) === true),
    )
    this.session.setPermissionCheckHandler(
      (contents, permission) =>
        permission === 'geolocation' && this.deps.fakeLocation?.(contents) === true,
    )
    this.session.setDevicePermissionHandler(() => false)
    // Huli: with no save path set, Electron asks in the system's save dialog, so a download lands
    // on disk only where the user chooses, whether the user or an agent clicked it.
    this.session.on('will-download', (_event, item, contents) => {
      if (this.deps.agentDownload?.(contents, item)) return
      item.setSaveDialogOptions({
        defaultPath: join(app.getPath('downloads'), item.getFilename()),
      })
      item.once('done', (_done, state) => {
        if (state === 'cancelled' || contents.isDestroyed()) return
        const name = basename(item.getSavePath() || item.getFilename())
        this.deps.downloadDone(contents, name, state === 'completed')
      })
    })
    refuseRequests(this.session, (details) => isForbiddenRequest(details.url, this.servicePort))
  }

  /** The artifacts service's port, which a page must never reach; null while it does not run. */
  setServicePort(port: number | null): void {
    this.servicePort = port
  }
}

/** Sends a link meant for a new window to the same page, and opens no window at all. */
export function navigateInPlace(contents: WebContents, url: string): void {
  if (!isAllowedNavigation(url) || url === 'about:srcdoc') return
  void contents.loadURL(url)
}

// Huli: saving a page's sign-in state from the browser data its session uses, and restoring one
// into another session's: the site's cookies through the partition's cookie store, its local
// storage through the page's debugger in a world of Kite's own, which the page's scripts never
// reach. Nothing here logs or answers a cookie's or an item's value.

import type { Cookie, Session, WebContents } from 'electron'
import { getDomain } from 'tldts'
import type { SavedPayload, SavedStateInfo, SavedStates, StoredCookie } from './saved-states'
import { SavedStateError } from './saved-states'

/** The most local storage one site saves, in characters. */
const MAX_STORAGE_CHARS = 5 * 1024 * 1024
const WORLD = 'kite-state'

export interface StateToolsDeps {
  /** Reads the saved states' file, the first time one is used. */
  load(): Promise<SavedStates>
  /** The cookie store of the browser data a session's pages use. */
  partition(sessionId: string): Session
  tabContents(tabId: string): WebContents | null
  /** The saved states changed, for Settings' list. */
  changed(states: SavedStateInfo[]): void
}

/** The site a host's cookies belong to: its registrable domain, or the host itself. */
export function cookieSite(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host
}

function stored(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    hostOnly: cookie.hostOnly ?? false,
    ...(cookie.session || cookie.expirationDate === undefined
      ? {}
      : { expirationDate: cookie.expirationDate }),
  }
}

/** The address a cookie is set for, which Electron's store needs beside its domain. */
function cookieUrl(cookie: StoredCookie): string {
  const host = cookie.domain.replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
}

async function isolatedEval<T>(contents: WebContents, expression: string): Promise<T | null> {
  const tree = (await contents.debugger.sendCommand('Page.getFrameTree')) as {
    frameTree?: { frame?: { id?: string } }
  }
  const frameId = tree.frameTree?.frame?.id
  if (!frameId) return null
  const world = (await contents.debugger.sendCommand('Page.createIsolatedWorld', {
    frameId,
    worldName: WORLD,
  })) as { executionContextId?: number }
  const answer = (await contents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
  })) as { result?: { value?: unknown } }
  return (answer.result?.value as T | undefined) ?? null
}

export class StateTools {
  private loaded: Promise<SavedStates> | null = null

  constructor(private readonly deps: StateToolsDeps) {}

  private store(): Promise<SavedStates> {
    this.loaded ??= this.deps.load()
    return this.loaded
  }

  async list(): Promise<SavedStateInfo[]> {
    return (await this.store()).list()
  }

  /** Saves the signed-in state of a tab's site, its cookies and its local storage, as `name`. */
  async save(
    sessionId: string,
    tabId: string,
    name: string,
  ): Promise<{ sites: string[]; cookies: number }> {
    const contents = this.deps.tabContents(tabId)
    const url = contents?.getURL() ?? ''
    const parsed = URL.parse(url)
    if (!contents || !parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new SavedStateError('Open the signed-in site in the tab first.')
    }
    const host = parsed.hostname
    const site = cookieSite(host)
    const cookies = this.deps.partition(sessionId).cookies
    const found = [...(await cookies.get({ url })), ...(await cookies.get({ domain: site }))]
    const unique = new Map<string, StoredCookie>()
    for (const cookie of found) {
      unique.set(`${cookie.domain}\n${cookie.path}\n${cookie.name}`, stored(cookie))
    }
    const items =
      (await isolatedEval<[string, string][]>(
        contents,
        `(() => { try { return Object.keys(localStorage).map((key) => [key, localStorage.getItem(key) ?? '']) } catch (error) { return [] } })()`,
      ).catch(() => null)) ?? []
    const size = items.reduce((sum, [key, value]) => sum + key.length + value.length, 0)
    if (size > MAX_STORAGE_CHARS)
      throw new SavedStateError('The site’s local storage is too large.')
    if (unique.size === 0 && items.length === 0) {
      throw new SavedStateError(`${host} has no cookies or local storage to save. Sign in first.`)
    }
    const payload: SavedPayload = {
      cookies: [...unique.values()],
      storage: items.length > 0 ? [{ origin: parsed.origin, items }] : [],
    }
    const sites = [host, ...new Set([...unique.values()].map((c) => c.domain.replace(/^\./, '')))]
    const store = await this.store()
    await store.save(name, [...new Set(sites)], payload)
    this.deps.changed(store.list())
    return { sites: [...new Set(sites)], cookies: unique.size }
  }

  /**
   * Restores a saved state into the browser data a session's pages use: its cookies at once, and
   * its local storage into the tab, now when the tab shows its site, else on the tab's next page
   * of that site, once.
   */
  async restore(
    sessionId: string,
    tabId: string | null,
    name: string,
  ): Promise<{ sites: string[]; cookies: number; storage: number }> {
    const payload = await (await this.store()).open(name)
    if (!payload) throw new SavedStateError(`There is no saved state "${name}".`)
    const cookies = this.deps.partition(sessionId).cookies
    let set = 0
    const now = Date.now() / 1000
    for (const cookie of payload.cookies) {
      if (cookie.expirationDate !== undefined && cookie.expirationDate < now) continue
      try {
        await cookies.set({
          url: cookieUrl(cookie),
          name: cookie.name,
          value: cookie.value,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        })
        set += 1
      } catch {
        // A cookie the store refuses now, such as a secure one of a plain http site, is left out.
      }
    }
    const contents = tabId === null ? null : this.deps.tabContents(tabId)
    let storage = 0
    if (contents && payload.storage.length > 0) {
      for (const area of payload.storage) {
        if (await this.restoreStorage(contents, area)) storage += 1
      }
    }
    const sites = [...new Set(payload.cookies.map((c) => c.domain.replace(/^\./, '')))]
    for (const area of payload.storage) {
      const host = URL.parse(area.origin)?.hostname
      if (host && !sites.includes(host)) sites.push(host)
    }
    return { sites, cookies: set, storage }
  }

  async remove(name: string): Promise<boolean> {
    const store = await this.store()
    const removed = await store.remove(name)
    if (removed) this.deps.changed(store.list())
    return removed
  }

  /** Puts a site's local storage into the tab: at once on that site, else on its next page there. */
  private async restoreStorage(
    contents: WebContents,
    area: SavedPayload['storage'][number],
  ): Promise<boolean> {
    const source = `(() => {
      if (location.origin !== ${JSON.stringify(area.origin)}) return false
      try {
        for (const [key, value] of ${JSON.stringify(area.items)}) localStorage.setItem(key, value)
        return true
      } catch (error) {
        return false
      }
    })()`
    if (URL.parse(contents.getURL())?.origin === area.origin) {
      return (await isolatedEval<boolean>(contents, source).catch(() => false)) === true
    }
    const added = (await contents.debugger
      .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD })
      .catch(() => null)) as { identifier?: string } | null
    const identifier = added?.identifier
    if (!identifier) return false
    // Once: the next page of the site gets the items, and later ones keep what the site does.
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
      if (method !== 'Page.frameNavigated') return
      const frame = (params.frame ?? {}) as { parentId?: string; url?: string }
      if (frame.parentId !== undefined || URL.parse(frame.url ?? '')?.origin !== area.origin) return
      contents.debugger.off('message', onMessage)
      void contents.debugger
        .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        .catch(() => {})
    }
    contents.debugger.on('message', onMessage)
    return true
  }
}

// Huli: `state/browser-states.json`, the sign-in states saved from Kite's browser by name (the
// cookies of a site and its local storage), to restore into another session's or worktree's
// browser data. The names, sites and times are plain for Settings to list; what a state holds is
// sealed by the system's encryption, as the API keys in market-keys.json are, and never written,
// logged or sent anywhere unsealed. Without the system's encryption nothing is saved.

import { join } from 'node:path'
import { isStateName, MAX_STATE_NAME } from '@shared/browser-args'
import { readJsonFile, writeFileAtomic } from '../json-file'
import type { Logger } from '../log'
import type { IdentityCipher } from '../remote-identity'

const VERSION = 1
const FILE_MODE = 0o600
export const MAX_SAVED_STATES = 50
/** The most a state's sealed contents may hold, in characters of base64. */
const MAX_SEALED_CHARS = 16 * 1024 * 1024
const MAX_SITES = 50
const MAX_COOKIES = 2_000
const MAX_ORIGINS = 20
const MAX_ITEMS = 5_000

export function savedStatesFile(dataPath: string): string {
  return join(dataPath, 'state', 'browser-states.json')
}

export interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** As Electron names it. */
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  /** Seconds since the epoch; absent for a cookie that ends with the browser. */
  expirationDate?: number
  /** A cookie set without a Domain, which goes to its own host alone. */
  hostOnly: boolean
}

/** What a state holds, which only its sealed form ever stores. */
export interface SavedPayload {
  cookies: StoredCookie[]
  storage: { origin: string; items: [string, string][] }[]
}

/** A state as Settings and `browser_storage_state` list it. */
export interface SavedStateInfo {
  name: string
  sites: string[]
  savedAt: number
}

interface Entry extends SavedStateInfo {
  sealed: string
}

/** Refused with a reason the user or the agent reads. */
export class SavedStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedStateError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSite(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 300
}

/** The entries of the file, each checked; one that does not fit is left out. */
export function parseStates(raw: unknown): Entry[] {
  if (!isRecord(raw) || raw.version !== VERSION || !Array.isArray(raw.states)) return []
  const entries = new Map<string, Entry>()
  for (const item of raw.states) {
    if (!isRecord(item)) continue
    const { name, sites, savedAt, sealed } = item
    if (!isStateName(name) || entries.has(name)) continue
    if (!Array.isArray(sites) || sites.length > MAX_SITES || !sites.every(isSite)) continue
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) continue
    if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > MAX_SEALED_CHARS) {
      continue
    }
    entries.set(name, { name, sites: [...sites], savedAt, sealed })
    if (entries.size >= MAX_SAVED_STATES) break
  }
  return [...entries.values()]
}

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict'])

/** A state's contents as unsealed, checked; null when they are not a state's. */
export function parsePayload(raw: unknown): SavedPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.cookies) || !Array.isArray(raw.storage)) return null
  if (raw.cookies.length > MAX_COOKIES || raw.storage.length > MAX_ORIGINS) return null
  const cookies: StoredCookie[] = []
  for (const cookie of raw.cookies) {
    if (!isRecord(cookie)) return null
    const { name, value, domain, path, secure, httpOnly, sameSite, expirationDate, hostOnly } =
      cookie
    if (typeof name !== 'string' || typeof value !== 'string') return null
    if (typeof domain !== 'string' || domain === '' || typeof path !== 'string') return null
    if (typeof secure !== 'boolean' || typeof httpOnly !== 'boolean') return null
    if (typeof hostOnly !== 'boolean' || !SAME_SITE.has(String(sameSite))) return null
    if (expirationDate !== undefined && typeof expirationDate !== 'number') return null
    cookies.push({
      name,
      value,
      domain,
      path,
      secure,
      httpOnly,
      hostOnly,
      sameSite: sameSite as StoredCookie['sameSite'],
      ...(expirationDate === undefined ? {} : { expirationDate }),
    })
  }
  const storage: SavedPayload['storage'] = []
  for (const area of raw.storage) {
    if (!isRecord(area) || typeof area.origin !== 'string' || !Array.isArray(area.items)) {
      return null
    }
    if (area.items.length > MAX_ITEMS) return null
    const items: [string, string][] = []
    for (const pair of area.items) {
      if (!Array.isArray(pair) || pair.length !== 2) return null
      const [key, value] = pair as unknown[]
      if (typeof key !== 'string' || typeof value !== 'string') return null
      items.push([key, value])
    }
    storage.push({ origin: area.origin, items })
  }
  return { cookies, storage }
}

export class SavedStates {
  private constructor(
    private entries: Entry[],
    private readonly path: string,
    private readonly cipher: IdentityCipher,
    private readonly log: Logger,
  ) {}

  static async load(path: string, cipher: IdentityCipher, log: Logger): Promise<SavedStates> {
    const read = await readJsonFile(path)
    let entries: Entry[] = []
    if (read.kind === 'ok') entries = parseStates(read.value)
    else if (read.kind === 'unreadable')
      log.warn(`Could not read browser-states.json: ${read.reason}`)
    return new SavedStates(entries, path, cipher, log)
  }

  list(): SavedStateInfo[] {
    return this.entries
      .map(({ name, sites, savedAt }) => ({ name, sites: [...sites], savedAt }))
      .sort((a, b) => b.savedAt - a.savedAt)
  }

  /** Seals and keeps a state under `name`, in place of one of that name. */
  async save(
    name: string,
    sites: string[],
    payload: SavedPayload,
    now = Date.now(),
  ): Promise<void> {
    if (!isStateName(name)) {
      throw new SavedStateError(`A name is one line of 1 to ${MAX_STATE_NAME} characters.`)
    }
    if (!(await this.cipher.available()) || this.cipher.plainText()) {
      throw new SavedStateError(
        'This computer cannot encrypt saved sign-ins, so Kite does not save them.',
      )
    }
    const others = this.entries.filter((entry) => entry.name !== name)
    if (others.length >= MAX_SAVED_STATES) {
      throw new SavedStateError(
        `Kite keeps at most ${MAX_SAVED_STATES} saved states. Delete one first.`,
      )
    }
    const sealed = (await this.cipher.encrypt(JSON.stringify(payload))).toString('base64')
    if (sealed.length > MAX_SEALED_CHARS)
      throw new SavedStateError('The state is too large to save.')
    this.entries = [
      ...others,
      { name, sites: [...new Set(sites)].slice(0, MAX_SITES), savedAt: now, sealed },
    ]
    await this.write()
  }

  /** A state's contents, unsealed; null when there is none of that name. */
  async open(name: string): Promise<SavedPayload | null> {
    const entry = this.entries.find((e) => e.name === name)
    if (!entry) return null
    let text: string
    try {
      text = (await this.cipher.decrypt(Buffer.from(entry.sealed, 'base64'))).result
    } catch {
      throw new SavedStateError(`"${name}" cannot be opened on this computer now.`)
    }
    let payload: SavedPayload | null
    try {
      payload = parsePayload(JSON.parse(text))
    } catch {
      payload = null
    }
    if (!payload) throw new SavedStateError(`"${name}" is damaged.`)
    return payload
  }

  async remove(name: string): Promise<boolean> {
    const left = this.entries.filter((entry) => entry.name !== name)
    if (left.length === this.entries.length) return false
    this.entries = left
    await this.write()
    return true
  }

  private async write(): Promise<void> {
    const file = {
      version: VERSION,
      states: this.entries.map(({ name, sites, savedAt, sealed }) => ({
        name,
        sites,
        savedAt,
        sealed,
      })),
    }
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`, FILE_MODE)
    } catch (error) {
      this.log.warn(`Could not write browser-states.json: ${(error as Error).message}`)
      throw new SavedStateError('The saved states could not be written.')
    }
  }
}

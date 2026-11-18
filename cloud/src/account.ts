// The account's devices and computers over the API, for the phone, the desktop app and the hosted
// web client: who is signed in, which computers registered on the relay and whether they are
// online, and signing a device out. Only an access token of the account is taken, never a relay
// token, and nothing of another account is ever listed.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  deviceKind,
  type AccountComputer,
  type AccountDevice,
  type AccountDevices,
} from '@shared/huli-cloud'
import type { Auth } from './auth'
import { readForm, sendError, sendJson } from './http'
import type { Store } from './store'

export interface AccountDevicesOptions {
  store: Store
  auth: Pick<Auth, 'authorize'>
  /** Whether a computer is signed in to the relay now. */
  online(id: string): boolean
  /** A device was signed out: hosts signed in with it, and its connections, leave the relay now. */
  revoked(): void
  now(): number
  secure: boolean
  log(line: string): void
}

/** The account's devices and computers as `family` sees them. */
export function accountDevices(
  store: Store,
  family: string,
  online: (id: string) => boolean,
  now: number,
): AccountDevices {
  const devices: AccountDevice[] = store.families().map((f) => ({
    id: f.id,
    kind: deviceKind(f.clientId),
    name: f.info?.name ?? null,
    os: f.info ? `${f.info.os} ${f.info.arch}`.trim() : null,
    version: f.info?.version ?? null,
    createdAt: f.createdAt,
    lastUsedAt: f.lastUsedAt,
    current: f.id === family,
  }))
  const computers: AccountComputer[] = store.computers().map((c) => {
    const live = online(c.id)
    return {
      id: c.id,
      name: c.name,
      platform: c.platform,
      key: c.key,
      signKey: c.signKey,
      device: c.family,
      firstSeen: c.firstSeen,
      // An online computer is seen now; what is written down lags by design.
      lastSeen: live ? now : c.lastSeen,
      online: live,
      pairable: live && c.pairable && c.key !== null,
      current: c.family === family,
    }
  })
  return { devices, computers }
}

export class AccountDevicesApi {
  constructor(private readonly options: AccountDevicesOptions) {}

  /** GET /api/v1/account/devices */
  list(request: IncomingMessage, response: ServerResponse): void {
    const family = this.options.auth.authorize(request, response)
    if (!family) return
    const { store, online, secure, now } = this.options
    sendJson(response, secure, 200, accountDevices(store, family.id, online, now()))
  }

  /** POST /api/v1/account/devices/revoke: `device=<id>`, or `others=1` for all but the asker. */
  async revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const family = this.options.auth.authorize(request, response)
    if (!family) return
    const { store, secure } = this.options
    const form = await readForm(request)
    const device = form.get('device')
    const others = form.get('others') === '1'
    if (!others && !device) {
      return sendError(response, secure, 400, 'invalid_request', 'Name a device, or others.')
    }
    const targets = others
      ? store.families().filter((f) => f.id !== family.id)
      : store.families().filter((f) => f.id === device)
    if (!others && targets.length === 0) {
      return sendError(response, secure, 404, 'not_found', 'No such device of the account.')
    }
    for (const target of targets) store.revokeFamily(target.id)
    if (targets.length > 0) {
      this.options.log(`huli-cloud: ${targets.length} device(s) signed out from the API`)
      this.options.revoked()
    }
    sendJson(response, secure, 200, { revoked: targets.length })
  }
}

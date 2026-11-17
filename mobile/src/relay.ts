// The phone's way to its computer through Huli Cloud's relay, from any network: the fallback when
// no direct address (the local network or Tailscale) answers. The relay joins the phone to the
// computer only with a token of the computer's Huli Cloud account, and passes the channel's Noise
// messages it cannot read; the computer still decides inside the channel whether the phone may
// connect. Where the token comes from is the phone's Huli Cloud sign-in, which sets `relayTokens`;
// until it does, the relay is never dialed.

import { RELAY_URL, trustedRelay, type HostRelay } from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'

/** How long the relay waits for a direct address to answer before it is dialed too. */
export const RELAY_GRACE_MS = 2500
/** How long the relay has to join the computer. */
const RELAY_TIMEOUT_MS = 15_000

/** A token the relay takes: a relay token or the access token of the phone's sign-in; null without. */
export type RelayTokenSource = () => Promise<string | null>

let tokens: RelayTokenSource = async () => null

/** The phone's Huli Cloud sign-in hands its tokens over here; null takes them back. */
export function relayTokens(source: RelayTokenSource | null): void {
  tokens = source ?? (async () => null)
}

/** The relays a computer named that may get the account's token: Huli Cloud's own alone. */
export function relayUrls(relay: HostRelay): string[] {
  return [...new Set([...relay.urls, RELAY_URL])].filter((url) => trustedRelay(url, RELAY_URL))
}

export class RelayUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`The relay did not reach the computer: ${reason}`)
    this.name = 'RelayUnavailable'
  }
}

/** Joins the computer through the relay; rejects without a token or when no relay joins it. */
export async function dialRelayTo(relay: HostRelay): Promise<Transport> {
  const token = await tokens()
  if (!token) throw new RelayUnavailable('signed_out')
  const result = await dialRelay({
    relays: relayUrls(relay),
    id: relay.id,
    token,
    openSocket: (url) => new WebSocket(url),
    timeoutMs: RELAY_TIMEOUT_MS,
  })
  if (result.kind !== 'joined') {
    throw new RelayUnavailable(result.kind === 'refused' ? result.reason : result.kind)
  }
  const socket = result.socket
  // React Native's WebSocket may not count what it has buffered.
  if (typeof socket.bufferedAmount !== 'number') {
    Object.defineProperty(socket, 'bufferedAmount', { value: 0 })
  }
  return webSocketTransport(socket, true)
}

/**
 * `dial` after a grace, so a direct address that answers wins, and not at all while a direct
 * connection is open; at once when `now`, as for a computer without a usable address.
 */
export function afterGrace(
  dial: () => Promise<Transport>,
  options: { now: boolean; direct: () => boolean },
): () => Promise<Transport> {
  return async () => {
    if (!options.now) await new Promise((resolve) => setTimeout(resolve, RELAY_GRACE_MS))
    if (options.direct()) throw new RelayUnavailable('direct')
    return dial()
  }
}

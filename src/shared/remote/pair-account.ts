// Huli: pairing a phone or a browser with a computer of its Huli Cloud account without a code, the
// device's side of Kettu's discovery (discovery.ts) for clients without the desktop app's host
// client. The account's registry gives the computer's relay id and its channel key; the device
// runs Noise IK with the discovery prologue to that key through the relay, both screens show the
// six-digit code of the commit-then-reveal exchange, and the computer adds the device only once its
// owner said yes there and the device's user said the codes match.
//
// The registry is only a hint: a key that is not the computer's own fails the handshake, and a
// cloud that listed a key of its own and answered in the computer's place shows a code the
// computer's prompt does not, and never has the owner's yes. A welcome that comes before this
// device's user confirmed the codes is refused, since a real host never sends one then.

import { HandshakeDropped, startDeviceChannel, type DeviceChannel } from './device-channel'
import { DISCOVER_PROLOGUE, deviceDiscovery } from './discovery'
import { awaitWelcome, hello, type Dial, type Opened } from './link'
import type { KeyPair } from './noise'
import type { Paired } from './pair'
import type { ClosingReason, Hello } from './protocol'
import type { Transport } from './transport'

export type AccountPairFailure =
  /** The computer ended the request without saying why, or the codes were not confirmed in order. */
  | 'void'
  /** The computer's owner said no. */
  | 'rejected'
  /** The computer is asked about another device now, or took too many requests that ended. */
  | 'busy'
  | 'cooling_down'
  | 'update_client'
  | 'update_host'
  /** The computer answered no handshake: it takes no requests now, or the key is not its own. */
  | 'refused'
  /** The relay did not join the computer: it is offline, of another account, or unreachable. */
  | 'host_offline'
  | 'wrong_account'
  | 'unreachable'
  /** This device's user said the codes differ, or gave up. */
  | 'cancelled'

export type AccountPairProgress =
  | { state: 'connecting' }
  /** The code both screens show; `matched` once this device's user said they are the same. */
  | { state: 'compare'; code: string; matched: boolean }
  | { state: 'failed'; reason: AccountPairFailure }

export interface AccountPairOptions {
  /** Opens a transport to the computer through the relay. */
  dial: Dial
  /** The computer's X25519 key as the account's registry lists it. */
  hostKey: Uint8Array
  key: KeyPair
  client: Hello['client']
  device: NonNullable<Hello['device']>
  /** Why a failed dial failed, when the dial can say; else it counts as unreachable. */
  dialFailure?(error: unknown): AccountPairFailure | null
}

export interface AccountPairing {
  /** The welcomed connection once the computer added this device; null when it did not. */
  readonly result: Promise<Paired | null>
  /** This device's user saw the same code on both screens; false ends the request. */
  match(same: boolean): void
  /** Gives the request up; the computer's prompt closes. */
  cancel(): void
}

/** Why the computer's closing reason ends the request. */
export function accountPairFailure(reason: ClosingReason | null): AccountPairFailure {
  switch (reason) {
    case 'rejected':
    case 'busy':
    case 'cooling_down':
    case 'update_client':
    case 'update_host':
      return reason
    case 'remote_off':
    case 'stopping':
    case 'unavailable':
      return 'host_offline'
    default:
      return 'void'
  }
}

/** Starts a request to be added to the computer; `progress` hears how it goes. */
export function pairWithAccountHost(
  options: AccountPairOptions,
  progress: (state: AccountPairProgress) => void,
): AccountPairing {
  let done = false
  let transport: Transport | null = null
  let channel: DeviceChannel | null = null
  let code: string | null = null
  let matched = false

  const fail = (reason: AccountPairFailure): null => {
    if (done) return null
    done = true
    transport?.close()
    progress({ state: 'failed', reason })
    return null
  }

  const run = async (): Promise<Paired | null> => {
    progress({ state: 'connecting' })
    let dialed: Transport
    try {
      dialed = await options.dial()
    } catch (error) {
      return fail(options.dialFailure?.(error) ?? 'unreachable')
    }
    transport = dialed
    if (done) {
      dialed.close()
      return null
    }
    let opened: DeviceChannel
    try {
      const started = await startDeviceChannel({
        transport: dialed,
        hostKey: options.hostKey,
        key: options.key,
        prologue: DISCOVER_PROLOGUE,
        hello: null,
      })
      opened = await started.opened
    } catch (error) {
      return fail(error instanceof HandshakeDropped ? 'refused' : 'void')
    }
    if (done) return null
    const exchange = await deviceDiscovery(opened)
    if (done) return null
    if (!('code' in exchange)) return fail(accountPairFailure(exchange.closing))
    channel = exchange.channel
    try {
      await channel.send(hello(options.client, options.device))
    } catch {
      return fail('void')
    }
    code = exchange.code
    progress({ state: 'compare', code, matched: false })
    const connection: Opened = { channel, transport: dialed }
    const answer = await awaitWelcome(connection, null)
    if (done) return null
    if (!('welcome' in answer)) return fail(accountPairFailure(answer.closing))
    // A host adds the device only after its yes; a welcome before it is no host's.
    if (!matched) return fail('void')
    done = true
    return { opened: connection, welcome: answer.welcome, later: answer.later }
  }

  const result = run().catch(() => fail('void'))
  return {
    result,
    match(same) {
      if (done || !channel || code === null || matched) return
      if (!same) {
        fail('cancelled')
        return
      }
      matched = true
      channel.send({ type: 'pair-confirm' }).catch(() => fail('void'))
      progress({ state: 'compare', code, matched: true })
    },
    cancel() {
      fail('cancelled')
    },
  }
}

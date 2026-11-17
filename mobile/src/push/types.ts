// What notifications need of the phone's system, behind one face so the screens never see which
// transport a platform uses: APNs on iOS now, Android's own later.

import type { PushTarget } from '@shared/remote/push'

export type PushPermission = 'granted' | 'denied' | 'undetermined'

/** What opens and checks a host's notifications where the app is not running. */
export interface PushKeys {
  /** This phone's X25519 private key, which every notification is sealed to. */
  device: Uint8Array
  /** The host's id and its Ed25519 public key in base64url, which signs what it sends. */
  host: { id: string; key: string }
  /** Show only what kind of thing happened, never the session's title or text. */
  quiet: boolean
}

export interface PushPlatform {
  /** Whether the phone can receive the host's notifications at all. */
  readonly supported: boolean
  /** The user's answer; asks them first when `ask` and they have not answered yet. */
  permission(ask: boolean): Promise<PushPermission>
  /** Where the host sends this phone's notifications; null when the system gives no address. */
  target(): Promise<PushTarget | null>
  /** The system changed the address. */
  onTargetChange(listener: () => void): () => void
  share(keys: PushKeys): Promise<void>
  unshare(): Promise<void>
}

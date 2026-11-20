// The HuliSystem native module (ios/HuliSystemModule.swift): the links Siri, Shortcuts, the Control
// Center controls, Spotlight and Handoff leave for the app, the sessions in Spotlight, the open
// session's activity, and Low Power Mode. iOS only; elsewhere, and in a build without it,
// `HuliSystem` is null.

import { Platform } from 'react-native'
import { requireOptionalNativeModule, type NativeModule } from 'expo'

/** A session as Spotlight lists it. */
export interface IndexedSession {
  id: string
  title: string
  project?: string
  agent?: string
  /** When it last changed, in ms since the epoch. */
  at: number
}

/** The open session, advertised for Handoff and Siri suggestions; no title while titles hide. */
export interface CurrentSession {
  id: string
  /** The computer's id in the app (SavedHost.id). */
  host: string
  title?: string
  project?: string
}

declare class HuliSystemModule extends NativeModule<{
  onOpenURL: () => void
  onLowPowerMode: (event: { on: boolean }) => void
}> {
  /** The huli:// link waiting for the app, taken so it opens once; null when none waits. */
  takeOpenURL(): string | null
  /** Puts a computer's sessions in place of what Spotlight held for it (`IndexedSession[]`). */
  indexSessions(host: string, json: string): Promise<void>
  /** Removes from Spotlight every computer but these. */
  keepSessions(hosts: string[]): Promise<void>
  removeAllSessions(): Promise<void>
  /** A `CurrentSession` as JSON, or an empty string for none. */
  setCurrentSession(json: string): Promise<void>
  /** Whether Low Power Mode is on; "onLowPowerMode" tells when it changes. */
  isLowPowerMode(): boolean
}

export const HuliSystem: HuliSystemModule | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<HuliSystemModule>('HuliSystem') : null

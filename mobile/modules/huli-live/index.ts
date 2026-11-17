// The HuliLive native module (ios/HuliLiveModule.swift): Live Activities and the home-screen
// widget's data. iOS only; elsewhere, and in a build without it, `HuliLive` is null.

import { Platform } from 'react-native'
import { requireOptionalNativeModule, type NativeModule } from 'expo'

/** One Huli activity on the phone, as the module's snapshot lists it. */
export interface NativeActivity {
  id: string
  state: 'active' | 'ended' | 'dismissed' | 'stale' | 'unknown'
  /** Started by the app itself, rather than by the computer's push. */
  local: boolean
  /** The computer's sealed attributes. */
  sealed?: string
  /** The activity's own push token, in lowercase hex, once ActivityKit gave it. */
  token?: string
  /** The session a local activity shows now. */
  sessionId?: string
}

export interface NativeSnapshot {
  /** Whether the user allows Live Activities for Huli in Settings. */
  enabled: boolean
  /** The token that starts an activity by push (iOS 17.2 and later), in lowercase hex. */
  startToken?: string
  activities: NativeActivity[]
}

declare class HuliLiveModule extends NativeModule<{ onChange: () => void }> {
  isEnabled(): boolean
  snapshot(): string
  start(attributes: string, state: string, staleSeconds: number): Promise<string>
  update(id: string, state: string, staleSeconds: number): Promise<void>
  /** `state` empty ends it as it is; `dismissSeconds` 0 removes it at once. */
  end(id: string, state: string, dismissSeconds: number): Promise<void>
  setWidgetSnapshot(json: string): void
}

export const HuliLive: HuliLiveModule | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<HuliLiveModule>('HuliLive') : null

export function readSnapshot(): NativeSnapshot {
  if (!HuliLive) return { enabled: false, activities: [] }
  try {
    const value = JSON.parse(HuliLive.snapshot()) as Partial<NativeSnapshot>
    return {
      enabled: value.enabled === true,
      ...(typeof value.startToken === 'string' ? { startToken: value.startToken } : {}),
      activities: Array.isArray(value.activities) ? value.activities : [],
    }
  } catch {
    return { enabled: false, activities: [] }
  }
}

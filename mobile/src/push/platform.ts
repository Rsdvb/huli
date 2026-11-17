// Platforms without notifications yet, Android among them: no target, so the host sends nothing.
// Metro takes platform.ios.ts on iOS.

import type { PushPlatform } from './types'

export const platform: PushPlatform = {
  supported: false,
  permission: async () => 'denied',
  target: async () => null,
  onTargetChange: () => () => {},
  share: async () => {},
  unshare: async () => {},
  onOpen: () => () => {},
}

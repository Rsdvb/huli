// Whether the developer's tools are on: always in a development build, and in a release build on
// iOS only when the app was launched with `-huliDev YES`, as the simulator scripts launch it to
// measure a release build. A phone's user cannot pass launch arguments, so it stays off for them.

import { Platform, Settings } from 'react-native'

export function devMode(): boolean {
  if (__DEV__) return true
  return Platform.OS === 'ios' && !!Settings.get('huliDev')
}

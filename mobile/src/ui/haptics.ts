// The app's haptics, by what happened: a tap that changed something, a choice in a control, and
// an action's outcome. Failures are dropped; a phone without a motor just stays still.

import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'

const quiet = () => {}

export const haptic = {
  /** A button that changed state, or a tab switch. */
  tap(): void {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key).catch(quiet)
    } else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(quiet)
  },
  /** A segmented control or a picker moved to another value. */
  select(): void {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick).catch(quiet)
    } else void Haptics.selectionAsync().catch(quiet)
  },
  success(): void {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(quiet)
    } else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(quiet)
  },
  warning(): void {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Reject).catch(quiet)
    } else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(quiet)
  },
}

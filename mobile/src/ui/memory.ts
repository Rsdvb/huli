// When the system runs short of memory, the decoded pictures go first: expo-image keeps them in
// memory for quick redraws, and reads them again from its disk cache when they show next.

import { AppState } from 'react-native'
import { Image } from 'expo-image'

export function watchMemory(): () => void {
  const subscription = AppState.addEventListener('memoryWarning', () => {
    void Image.clearMemoryCache()
  })
  return () => subscription.remove()
}

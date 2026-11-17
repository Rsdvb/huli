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

/**
 * Where expo-image keeps a picture: one read from the network or the computer in memory and on
 * disk; one already on the phone, a file or inline data, in memory only, since its disk copy
 * would only be a second copy.
 */
export function cacheFor(uri: string): 'memory' | 'memory-disk' {
  return /^(data|file):/i.test(uri) ? 'memory' : 'memory-disk'
}

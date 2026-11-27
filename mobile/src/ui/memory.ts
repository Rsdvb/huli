// When the system runs short of memory, the decoded pictures go first: expo-image keeps them in
// memory for quick redraws, and reads them again from its disk cache when they show next. Huli: so
// do the threads kept in memory for a quick reopen, the steps read whole and the sub-agents'
// numbers, each read again when it shows next.

import { AppState } from 'react-native'
import { Image } from 'expo-image'
import { dropRecentThreads } from '../cache'
import { dropFullEntries } from './session/fullEntry'
import { dropSubagentReads } from './session/subagents'

export function watchMemory(): () => void {
  const subscription = AppState.addEventListener('memoryWarning', () => {
    void Image.clearMemoryCache()
    dropRecentThreads()
    dropFullEntries()
    dropSubagentReads()
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

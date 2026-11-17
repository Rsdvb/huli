// Takes in what another Android app shares with Huli (ACTION_SEND and SEND_MULTIPLE, through
// expo-share-intent, which copies shared files into the app's cache) and opens the share sheet
// once the app knows whether a computer is paired.

import { useEffect } from 'react'
import { router } from 'expo-router'
import { useShareIntent, type ShareIntent } from 'expo-share-intent'
import { isPhoto } from '../attachments'
import { useHostSelector, type HostData } from '../host'
import { keepShared, type SharedItem } from './inbox'

const selectPhase = (d: HostData) => d.phase

function itemsOf(intent: ShareIntent): SharedItem[] {
  const items: SharedItem[] = []
  for (const file of intent.files ?? []) {
    if (!file.path) continue
    items.push({
      kind: isPhoto(file.mimeType) ? 'image' : 'file',
      uri: file.path,
      name: file.fileName || '文件',
      mimeType: file.mimeType || null,
      size: file.size,
    })
  }
  const text = intent.text?.trim()
  if (text) items.push({ kind: 'text', text })
  else if (intent.webUrl) items.push({ kind: 'url', url: intent.webUrl })
  return items
}

export function ShareIntake() {
  const phase = useHostSelector(selectPhase)
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    resetOnBackground: true,
  })

  useEffect(() => {
    if (!hasShareIntent || phase === 'loading') return
    const items = itemsOf(shareIntent)
    resetShareIntent()
    if (items.length === 0) return
    const id = keepShared(items)
    router.push({ pathname: '/share', params: { id } })
  }, [hasShareIntent, shareIntent, phase, resetShareIntent])

  return null
}

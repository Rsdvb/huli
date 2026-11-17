// The sessions whose notifications this phone keeps quiet. The computer has no mute of a session's
// own, so the phone keeps the list: what arrives for one of them shows in the list without a sound
// or a banner, here while the app is open and in the notification extension otherwise (it reads
// the list the iOS platform shares with it).

import { useSyncExternalStore } from 'react'
import * as SecureStore from 'expo-secure-store'

const ITEM = 'huli.muted'

let muted = new Set<string>()
let loaded = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

void SecureStore.getItemAsync(ITEM)
  .then((text) => {
    const list = text ? (JSON.parse(text) as unknown) : []
    if (Array.isArray(list)) muted = new Set(list.filter((id) => typeof id === 'string'))
  })
  .catch(() => {})
  .finally(() => {
    loaded = true
    emit()
  })

export function isMuted(sessionId: string | null | undefined): boolean {
  return !!sessionId && muted.has(sessionId)
}

export function mutedIds(): string[] {
  return [...muted]
}

/** Called once the list was read, and on each change. */
export function onMutedChange(listener: () => void): () => void {
  listeners.add(listener)
  if (loaded) listener()
  return () => listeners.delete(listener)
}

export async function setMuted(sessionId: string, on: boolean): Promise<void> {
  const next = new Set(muted)
  if (on) next.add(sessionId)
  else next.delete(sessionId)
  muted = next
  emit()
  await SecureStore.setItemAsync(ITEM, JSON.stringify([...next]))
}

export function useMuted(sessionId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => muted.has(sessionId),
  )
}

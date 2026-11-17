// What another app shared to Huli, waiting for the user to pick where it goes. On iOS the share
// extension (plugins/share-extension/ShareViewController.swift) leaves each share in the App Group
// container as share/<id>/manifest.json beside its files, and opens huli://share?id=<id>; on
// Android the intake keeps it here in memory under an id of its own.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { Directory, File, Paths } from 'expo-file-system'

export type SharedItem =
  | {
      kind: 'image' | 'file'
      uri: string
      name: string
      mimeType: string | null
      size: number | null
    }
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }

export interface SharedBundle {
  id: string
  items: SharedItem[]
}

const ID = /^[0-9a-z-]{8,64}$/

const waiting = new Map<string, SharedBundle>()

let nextId = 1

/** Keeps a share for the sheet to read; its id goes in /share?id=. */
export function keepShared(items: SharedItem[]): string {
  const id = `android-${Date.now()}-${nextId++}`
  waiting.set(id, { id, items })
  return id
}

function shareFolder(id: string): Directory | null {
  if (Platform.OS !== 'ios' || !ID.test(id)) return null
  const groups = Constants.expoConfig?.ios?.entitlements?.['com.apple.security.application-groups']
  const group = Array.isArray(groups) && typeof groups[0] === 'string' ? groups[0] : null
  const container = group ? Paths.appleSharedContainers[group] : undefined
  return container ? new Directory(container, 'share', id) : null
}

function itemOf(raw: unknown, folder: Directory): SharedItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  switch (item.kind) {
    case 'text':
      return typeof item.text === 'string' && item.text.trim()
        ? { kind: 'text', text: item.text }
        : null
    case 'url':
      return typeof item.url === 'string' ? { kind: 'url', url: item.url } : null
    case 'image':
    case 'file': {
      // Only a file of this share's own folder, by its plain name.
      if (typeof item.file !== 'string' || item.file.includes('/') || item.file.startsWith('.')) {
        return null
      }
      const file = new File(folder, item.file)
      if (!file.exists) return null
      return {
        kind: item.kind,
        uri: file.uri,
        name: typeof item.name === 'string' && item.name ? item.name : item.file,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : null,
        size: typeof item.size === 'number' ? item.size : file.size,
      }
    }
    default:
      return null
  }
}

/** The share of this id, or null when it is gone, as one already sent. */
export async function loadShared(id: string): Promise<SharedBundle | null> {
  const kept = waiting.get(id)
  if (kept) return kept
  const folder = shareFolder(id)
  if (!folder?.exists) return null
  try {
    const manifest = JSON.parse(await new File(folder, 'manifest.json').text()) as {
      items?: unknown[]
    }
    const items = (manifest.items ?? []).flatMap((raw) => itemOf(raw, folder) ?? [])
    return items.length > 0 ? { id, items } : null
  } catch {
    return null
  }
}

/** Forgets a share once it went, its files with it. */
export function discardShared(id: string): void {
  waiting.delete(id)
  try {
    const folder = shareFolder(id)
    if (folder?.exists) folder.delete()
  } catch {
    // Left for the extension, which clears shares older than a day.
  }
}

// The last artifact pages the phone opened, made whole, kept to show again while the computer
// cannot be reached:
//
//   <cache>/huli/<computer id>/artifacts/<artifact id>.json   one page, its version and layout
//
// Only single pages and canvas pages small enough are kept, the least recently opened dropped
// first; documents and decks are read from the computer each time. Unpairing a computer deletes
// its folder with the rest of its cache (cache.ts).

import { Directory, File, Paths } from 'expo-file-system'
import type { FrameLayout } from './shell'

const VERSION = 1
const KEPT = 12
/** A page larger than this is not kept. */
const MAX_CHARS = 6 * 1024 * 1024

export interface CachedPage {
  title: string
  version: number
  path: string
  layout: FrameLayout
  html: string
  savedAt: number
}

function folder(computer: string): Directory {
  return new Directory(Paths.cache, 'huli', computer.replace(/[^A-Za-z0-9_-]/g, '_'), 'artifacts')
}

function fileOf(computer: string, id: string): File {
  return new File(folder(computer), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

export async function readCachedPage(computer: string, id: string): Promise<CachedPage | null> {
  try {
    const file = fileOf(computer, id)
    if (!file.exists) return null
    const value = JSON.parse(await file.text()) as { v?: number } & CachedPage
    return value.v === VERSION && typeof value.html === 'string' ? value : null
  } catch {
    return null
  }
}

let writing: Promise<void> = Promise.resolve()

export function writeCachedPage(computer: string, id: string, page: Omit<CachedPage, 'savedAt'>): void {
  if (page.html.length > MAX_CHARS) return
  writing = writing
    .then(async () => {
      const dir = folder(computer)
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
      const file = fileOf(computer, id)
      if (!file.exists) file.create()
      await file.write(JSON.stringify({ v: VERSION, ...page, savedAt: Date.now() }))
      const kept = dir
        .list()
        .filter((entry): entry is File => entry instanceof File)
        .sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0))
      for (const old of kept.slice(KEPT)) old.delete()
    })
    .catch(() => {})
}

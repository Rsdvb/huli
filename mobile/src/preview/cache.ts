// Files downloaded from a computer to preview, kept in the app's cache folder (out of backups; the
// system may clear it) so a file opened again opens at once while it has not changed:
//
//   <cache>/huli-preview/<key>/meta.json         which file it is and its size and time there
//   <cache>/huli-preview/<key>/file/<name>       its bytes, under its own name, which the viewer
//                                                shows and reads its type from
//   <cache>/huli-preview/<key>/download-<n>      the bytes while they come
//
// <key> is a hash of the computer, the folder and the path. A sweep drops what has not been
// opened for a week, and the least recently opened past the size kept in all.

import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto'
import { Directory, File, Paths } from 'expo-file-system'
import type { FileStamp } from '@shared/files'

const VERSION = 1
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const KEEP_BYTES = 512 * 1024 * 1024
/** A download's bytes untouched this long belong to none still coming. */
const LEFTOVER_MS = 24 * 60 * 60 * 1000
const DOWNLOAD = 'download-'

interface Meta extends FileStamp {
  version: number
  name: string
  openedAt: number
}

export interface Kept extends FileStamp {
  key: string
  name: string
  file: File
}

const root = () => new Directory(Paths.cache, 'huli-preview')

/** The key a computer's file is kept under. */
export async function keyOf(computer: string, folder: string, path: string): Promise<string> {
  const hash = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    `${VERSION}\0${computer}\0${folder}\0${path}`,
  )
  return hash.slice(0, 32)
}

function readMeta(entry: Directory): Meta | null {
  try {
    const meta = JSON.parse(new File(entry, 'meta.json').textSync()) as Partial<Meta>
    if (
      meta.version !== VERSION ||
      typeof meta.name !== 'string' ||
      typeof meta.size !== 'number' ||
      typeof meta.mtimeMs !== 'number' ||
      typeof meta.openedAt !== 'number'
    ) {
      return null
    }
    return meta as Meta
  } catch {
    return null
  }
}

function writeMeta(entry: Directory, meta: Meta): void {
  const file = new File(entry, 'meta.json')
  if (!file.exists) file.create()
  file.writeSync(JSON.stringify(meta))
}

/** The kept copy under `key`, or null when there is none whole. */
export function kept(key: string): Kept | null {
  try {
    const entry = new Directory(root(), key)
    if (!entry.exists) return null
    const meta = readMeta(entry)
    if (!meta) return null
    const file = new File(entry, 'file', meta.name)
    if (!file.exists || file.size !== meta.size) return null
    return { key, name: meta.name, size: meta.size, mtimeMs: meta.mtimeMs, file }
  } catch {
    return null
  }
}

/**
 * Where the bytes of a download under `key` go while they come, empty: a file of the download's
 * own, so one given up and cleaned after never takes the next one's bytes with it.
 */
export function downloadTarget(key: string, download: number): File {
  const entry = new Directory(root(), key)
  entry.create({ intermediates: true, idempotent: true })
  const target = new File(entry, `${DOWNLOAD}${download}`)
  if (target.exists) target.delete()
  target.create()
  return target
}

/** Keeps a finished download as the file `name` of that stamp, in place of what was kept. */
export function keep(key: string, name: string, stamp: FileStamp, download: File): Kept {
  const entry = new Directory(root(), key)
  const folder = new Directory(entry, 'file')
  if (folder.exists) folder.delete()
  folder.create({ intermediates: true })
  const file = new File(folder, name)
  download.moveSync(file)
  writeMeta(entry, { version: VERSION, name, ...stamp, openedAt: Date.now() })
  return { key, name, ...stamp, file }
}

/** Notes that the kept copy was opened again, which keeps it the longest. */
export function opened(copy: Kept): void {
  try {
    const entry = new Directory(root(), copy.key)
    const meta = readMeta(entry)
    if (meta) writeMeta(entry, { ...meta, openedAt: Date.now() })
  } catch {
    // Kept a while less, nothing worse.
  }
}

/** Drops a download given up or failed; a copy kept before stays. */
export function dropDownload(download: File): void {
  try {
    if (download.exists) download.delete()
  } catch {
    // The next sweep takes it.
  }
}

/**
 * Drops what was not opened for a week, then the least recently opened past KEEP_BYTES in all;
 * never `spare`, the copy just opened, which the viewer may be showing.
 */
export function sweep(spare: string | null = null): void {
  let entries: Directory[]
  try {
    const folder = root()
    if (!folder.exists) return
    entries = folder.list().filter((item): item is Directory => item instanceof Directory)
  } catch {
    return
  }
  const now = Date.now()
  const live: { entry: Directory; openedAt: number; bytes: number }[] = []
  for (const entry of entries) {
    const key = entry.name
    if (key === spare) continue
    const copy = kept(key)
    const meta = copy ? readMeta(entry) : null
    if (!copy || !meta || now - meta.openedAt > KEEP_MS) {
      // A download still coming may have no copy yet; one a day old is a leftover.
      if (!copy && downloading(entry, now)) continue
      remove(entry)
      continue
    }
    clearLeftovers(entry, now)
    live.push({ entry, openedAt: meta.openedAt, bytes: copy.size })
  }
  let total = 0
  for (const item of live.sort((a, b) => b.openedAt - a.openedAt)) {
    total += item.bytes
    if (total > KEEP_BYTES) remove(item.entry)
  }
}

/** The bytes of downloads under `entry`, each with whether one still comes into it. */
function downloads(entry: Directory, now: number): { file: File; coming: boolean }[] {
  try {
    return entry
      .list()
      .filter((item): item is File => item instanceof File && item.name.startsWith(DOWNLOAD))
      .map((file) => {
        const changed = file.lastModified
        return { file, coming: changed !== null && now - changed < LEFTOVER_MS }
      })
  } catch {
    return []
  }
}

function downloading(entry: Directory, now: number): boolean {
  return downloads(entry, now).some((download) => download.coming)
}

function clearLeftovers(entry: Directory, now: number): void {
  for (const download of downloads(entry, now)) if (!download.coming) dropDownload(download.file)
}

function remove(entry: Directory): void {
  try {
    entry.delete()
  } catch {
    // Tried again on the next sweep.
  }
}

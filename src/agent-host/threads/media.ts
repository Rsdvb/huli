// The bytes of the large images, sounds and clips the threads carry, one file per SHA-256 of the
// bytes in `thread-media/` beside the thread database, which any number of sessions name. The
// database keeps what each session calls them and the type of each file; the thread worker that
// writes the database writes and removes the files in turn with the rows that name them.

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { putWhole, removeIfEmpty } from '../artifacts/content'

/** The folder beside the database `file` that holds its media. */
export function mediaDirOf(file: string): string {
  return path.join(path.dirname(file), 'thread-media')
}

const HASH = /^[0-9a-f]{64}$/
const FOLDER = /^[0-9a-f]{2}$/
const FILE = /^([0-9a-f]{64})\.([a-z0-9]{1,5})$/
const TEMP = /^[0-9a-f]{64}\.[a-z0-9]{1,5}\.[0-9a-f]+\.tmp$/

// What a file of each type is named with, so the folder opens in other apps; others are `.bin`.
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

export function mediaExtension(mime: string): string {
  const type = mime.split(';')[0]!.trim().toLowerCase()
  return EXTENSIONS[type] ?? (type.startsWith('text/') ? 'txt' : 'bin')
}

/** The file of the bytes with this hash, of this type, in a folder named by its first two hex. */
export function mediaPath(dir: string, hash: string, mime: string): string {
  if (!HASH.test(hash)) throw new Error(`Not a media hash: ${hash}`)
  return path.join(dir, hash.slice(0, 2), `${hash}.${mediaExtension(mime)}`)
}

/** Writes the bytes unless their file is there, so the file is whole whenever it exists. */
export function putMedia(dir: string, hash: string, mime: string, data: Uint8Array): void {
  putWhole(mediaPath(dir, hash, mime), data)
}

/** The bytes of the file, or null when it is gone. */
export function readMedia(dir: string, hash: string, mime: string): Uint8Array | null {
  try {
    const bytes = readFileSync(mediaPath(dir, hash, mime))
    // As the database gave its bytes: a plain array, not a Buffer.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function hasMedia(dir: string, hash: string, mime: string): boolean {
  try {
    return statSync(mediaPath(dir, hash, mime)).isFile()
  } catch {
    return false
  }
}

export function removeMedia(dir: string, files: Iterable<{ hash: string; mime: string }>): void {
  for (const { hash, mime } of files) {
    const file = mediaPath(dir, hash, mime)
    rmSync(file, { force: true })
    removeIfEmpty(path.dirname(file))
  }
}

/**
 * Removes every file whose name is not `<hash>.<extension>` of a hash in `named` with its
 * extension, and the temporary files a crash left; other names are left alone. Returns how many
 * files went and their bytes.
 */
export function sweepMedia(
  dir: string,
  named: ReadonlyMap<string, string>,
): { files: number; bytes: number } {
  let folders
  try {
    folders = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 }
    throw error
  }
  let files = 0
  let bytes = 0
  for (const folder of folders) {
    if (!folder.isDirectory() || !FOLDER.test(folder.name)) continue
    const at = path.join(dir, folder.name)
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = FILE.exec(entry.name)
      const keep =
        match !== null &&
        match[1]!.startsWith(folder.name) &&
        named.has(match[1]!) &&
        mediaExtension(named.get(match[1]!)!) === match[2]
      if (keep || (match === null && !TEMP.test(entry.name))) continue
      const file = path.join(at, entry.name)
      try {
        bytes += statSync(file).size
      } catch {
        // Gone already.
      }
      rmSync(file, { force: true })
      files++
    }
    removeIfEmpty(at)
  }
  return { files, bytes }
}

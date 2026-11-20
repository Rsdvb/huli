// The bytes the data folder holds, by what keeps them, for the Storage row of Settings. The folders
// are walked as they are, off the host's way: every read is asynchronous.

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { StorageUsage } from '@shared/data-usage'
import { mediaDirOf } from './threads/media'

/** The bytes of the files under `target`, a file or a folder; 0 when it is not there. */
export async function sizeOf(target: string): Promise<number> {
  let info
  try {
    info = await stat(target)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let entries
  try {
    entries = await readdir(target, { recursive: true, withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  // A few at a time, so a folder of thousands of files does not open them all at once.
  for (let i = 0; i < entries.length; i += 64) {
    const sizes = await Promise.all(
      entries.slice(i, i + 64).map(async (entry) => {
        if (!entry.isFile()) return 0
        try {
          return (await stat(path.join(entry.parentPath, entry.name))).size
        } catch {
          return 0
        }
      }),
    )
    for (const size of sizes) total += size
  }
  return total
}

/** The bytes of the files in `folder` whose names start with one of `prefixes`. */
async function filesStarting(folder: string, prefixes: readonly string[]): Promise<number> {
  let names: string[]
  try {
    names = await readdir(folder)
  } catch {
    return 0
  }
  const picked = names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
  const sizes = await Promise.all(picked.map((name) => sizeOf(path.join(folder, name))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

export async function storageUsage(
  userDataPath: string,
  logFolder: string | null,
): Promise<StorageUsage> {
  const state = path.join(userDataPath, 'state')
  const logs = [path.join(userDataPath, 'agent-reports')]
  if (logFolder) logs.push(logFolder)
  const [threads, media, attachments, artifacts, logBytes, usage] = await Promise.all([
    filesStarting(state, ['threads.db', 'search-']),
    sizeOf(mediaDirOf(path.join(state, 'threads.db'))),
    sizeOf(path.join(userDataPath, 'attachments')),
    sizeOf(path.join(userDataPath, 'artifacts')),
    Promise.all([...new Set(logs)].map(sizeOf)).then((sizes) => sizes.reduce((a, b) => a + b, 0)),
    filesStarting(state, ['usage.db']),
  ])
  return { threads, media, attachments, artifacts, logs: logBytes, usage }
}

// Huli: deletes a big folder without anyone waiting for it. One rename moves it aside to a trash
// name on the same disk, so every reader finds it gone at once, and its files go in the
// background, one folder after another. On Windows a harness's thousands of node_modules files
// under a virus scan take most of a minute to delete, and a file the scan or a closing process
// still holds fails with EPERM or EBUSY for a moment. What a quit cuts short goes at the next start.

import { randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'

export const TRASH_PREFIX = '.trash-'

/** What Windows answers for a file another process holds, or one it is still closing. */
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** Worth a wait: ENOTEMPTY is a file Windows still lists while a scan holds it past its delete. */
const TRANSIENT = new Set([...HELD, 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

/** The rename's waits: a scan lets go within a second or two. */
const RENAME_WAITS_MS = [100, 200, 400, 800, 1_500]
/** The background delete's waits between whole tries, each of which retries briefly itself. */
const DELETE_WAITS_MS = [1_000, 5_000, 15_000, 30_000, 60_000]

export interface DiscardDeps {
  rename?(from: string, to: string): Promise<void>
  remove?(dir: string): Promise<void>
  wait?(ms: number): Promise<void>
  log?(level: 'info' | 'warn', message: string): void
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? ''
}

/** Whether a rename or delete failed because a file in the folder is in use. */
export function heldOpen(error: unknown): boolean {
  return HELD.has(code(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

const RM = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const

/**
 * Deletes a tree a few levels at a time, one subtree after another: one `rm` of a whole harness
 * queues its tens of thousands of deletes at once, ahead of every other file the host reads.
 */
async function removeGently(dir: string): Promise<void> {
  const info = await lstat(dir).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (!info) return
  // A link is removed as a link, never followed; below, the entries' own types say the same.
  if (info.isDirectory()) await removeLevels(dir, 4)
  else await rm(dir, RM)
}

async function removeLevels(dir: string, depth: number): Promise<void> {
  if (depth > 0) {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return [] as Dirent[]
      throw error
    })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await removeLevels(full, depth - 1)
      else await rm(full, RM)
    }
  }
  await rm(dir, RM)
}

/** A fresh trash name in `root`. */
export function trashPath(root: string): string {
  return path.join(root, `${TRASH_PREFIX}${randomBytes(6).toString('hex')}`)
}

export interface MoveAsideOptions {
  /** This computer's by default. */
  platform?: Platform
  /** Where the trash name goes, on the same disk: the folder's own parent by default. */
  trashRoot?: string
  /** The rename's waits while a file is held; the defaults add up to about three seconds. */
  waits?: readonly number[]
  deps?: DiscardDeps
}

/**
 * Moves `dir` aside under a trash name: the trash's path, or null when `dir` is not there. A file
 * held for a moment is waited for; one still held at the end throws, and `dir` stays whole.
 */
export async function moveAside(dir: string, options: MoveAsideOptions): Promise<string | null> {
  const move = options.deps?.rename ?? rename
  const wait = options.deps?.wait ?? sleep
  const waits = options.waits ?? RENAME_WAITS_MS
  const trash = trashPath(options.trashRoot ?? path.dirname(dir))
  for (let attempt = 0; ; attempt++) {
    try {
      await move(dir, trash)
      return trash
    } catch (error) {
      if (code(error) === 'ENOENT') return null
      // Only Windows holds a folder whose files are open; elsewhere a refusal is final.
      const windows = (options.platform ?? process.platform) === 'win32'
      if (!windows || !heldOpen(error) || attempt >= waits.length) throw error
      await wait(waits[attempt]!)
    }
  }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Deletes a folder moved aside, after the ones queued before it, so one disk is never asked for
 * two at once. A file still held is waited for and tried again, for about two minutes in all;
 * then the folder is left for the next start. Resolves true once it is gone; never rejects.
 */
export function deleteLater(trash: string, deps: DiscardDeps = {}): Promise<boolean> {
  const remove = deps.remove ?? removeGently
  const wait = deps.wait ?? sleep
  const run = async (): Promise<boolean> => {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      try {
        await remove(trash)
        const ms = Date.now() - started
        if (ms >= 5_000) deps.log?.('info', `Deleted ${trash} in ${Math.round(ms / 1000)} s`)
        return true
      } catch (error) {
        if (!TRANSIENT.has(code(error)) || attempt >= DELETE_WAITS_MS.length) {
          deps.log?.(
            'warn',
            `Could not delete ${trash}, which goes at the next start: ${(error as Error).message}`,
          )
          return false
        }
        await wait(DELETE_WAITS_MS[attempt]!)
      }
    }
  }
  const next = queue.then(run, run)
  queue = next
  return next
}

/** Resolves once the deletes queued so far have ended, for tests. */
export function deletesSettled(): Promise<void> {
  return queue.then(() => {})
}

/**
 * Moves `dir` aside and deletes it in the background: false when a file in it stays in use, as a
 * program that still runs from it on Windows, and then it stays whole.
 */
export async function discard(dir: string, options: MoveAsideOptions): Promise<boolean> {
  let trash: string | null
  try {
    trash = await moveAside(dir, options)
  } catch (error) {
    if (heldOpen(error)) return false
    throw error
  }
  if (trash) void deleteLater(trash, options.deps)
  return true
}

/** Deletes, one after another in the background, the trash an earlier run left in `root`. */
export async function sweepTrash(root: string, deps: DiscardDeps = {}): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  const left = names.filter((name) => name.startsWith(TRASH_PREFIX))
  await Promise.all(left.map((name) => deleteLater(path.join(root, name), deps)))
}

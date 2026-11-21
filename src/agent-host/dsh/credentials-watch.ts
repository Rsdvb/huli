// Watches a dsh home's credential file, which dsh's own sign-in page (`dsh web`), its desktop app
// or a terminal rewrite without telling Kettu. A home not made yet is watched for from its parent.

import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

const FILE = '.credentials.yaml'

export interface CredentialsWatchOptions {
  /** How long after the last change `changed` runs, since one write reports several. */
  delayMs: number
  log(message: string): void
  platform?: NodeJS.Platform
}

/** Watches `home` for its credential file changing; returns what stops the watch. */
export function watchCredentials(
  home: string,
  changed: () => void,
  options: CredentialsWatchOptions,
): () => void {
  const platform = options.platform ?? process.platform
  const same = (a: string, b: string): boolean =>
    platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const fire = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!closed) changed()
    }, options.delayMs)
    timer.unref?.()
  }

  const open = (dir: string, name: string, then: () => void): FSWatcher | null => {
    try {
      const opened = watch(dir, { persistent: false }, (_event, file) => {
        // Without a name, as some platforms report, any change counts.
        if (file !== null && !same(String(file), name)) return
        then()
      })
      opened.on('error', () => {
        opened.close()
        if (watcher !== opened) return
        watcher = null
        arm()
      })
      return opened
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        options.log(`Could not watch ${dir}: ${(error as Error).message}`)
      }
      return null
    }
  }

  const arm = (): void => {
    if (closed) return
    watcher?.close()
    watcher = open(home, FILE, fire)
    if (watcher) return
    // The home comes with dsh's first run or sign-in, and its file may come with it.
    watcher = open(path.dirname(home), path.basename(home), () => {
      arm()
      fire()
    })
  }

  arm()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
    watcher?.close()
    watcher = null
  }
}

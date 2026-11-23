// Huli: what an agent's pages download, and the PDFs `browser_pdf` prints, go into the session's
// own folder under `.kite/downloads`, where the agent can read them, instead of the system's save
// dialog the user's own downloads open. A download above DOWNLOAD_ASK_BYTES waits for the user's
// allow first. The folder ignores itself in git, so nothing it holds shows as a change.

import { mkdir, readdir, writeFile, access } from 'node:fs/promises'
import { extname, basename, join } from 'node:path'
import type { DownloadItem } from 'electron'
import { DOWNLOAD_ASK_BYTES } from '@shared/browser-args'
import type { DownloadInfo } from './cdp'

/** The most downloads a session lists; the oldest go first. */
const MAX_LISTED = 100

/** The folder a session's downloads go into. */
export function downloadsDir(folder: string): string {
  return join(folder, '.kite', 'downloads')
}

/**
 * A file name that is safe on every platform: no folder, no reserved character, no trailing dot
 * or space, and not a device name on Windows.
 */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 150)
  const stem = cleaned.replace(/\.[^.]*$/, '')
  if (cleaned === '' || cleaned.startsWith('.')) return `download${cleaned}`
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) return `_${cleaned}`
  return cleaned
}

/** `name`, or `name (2)`, `name (3)` and so on, whichever `taken` does not hold. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${extension}`
    if (!taken(next)) return next
  }
}

export interface AgentDownloadsDeps {
  /** Asks the user whether a large download may go on; false when they refuse or do not answer. */
  ask(sessionId: string, request: { name: string; size: number | null }): Promise<boolean>
  /** Something the agent's next result says about a download. */
  note(sessionId: string, note: string): void
  /** A download of the tab's page ended in the session's folder, for the pane's notice. */
  done(contentsId: number, name: string, path: string, completed: boolean): void
  log(message: string): void
}

interface Entry extends DownloadInfo {
  item: DownloadItem | null
}

export class AgentDownloads {
  private readonly bySession = new Map<string, Entry[]>()
  /** The names each downloads folder holds, lower case, read once and kept up to date. */
  private readonly names = new Map<string, Set<string>>()
  /** The folders whose ignore file was written this run. */
  private readonly ignored = new Set<string>()

  constructor(private readonly deps: AgentDownloadsDeps) {}

  /** Reads which names a folder's downloads already use, before its first download picks one. */
  know(folder: string): void {
    const dir = downloadsDir(folder)
    if (this.names.has(dir)) return
    const names = new Set<string>()
    this.names.set(dir, names)
    void readdir(dir).then(
      (found) => found.forEach((name) => names.add(name.toLowerCase())),
      () => {},
    )
  }

  list(sessionId: string): DownloadInfo[] {
    return (this.bySession.get(sessionId) ?? []).map(({ name, path, bytes, state }) => ({
      name,
      path,
      bytes,
      state,
    }))
  }

  forget(sessionId: string): void {
    for (const entry of this.bySession.get(sessionId) ?? []) {
      if (entry.state === 'progressing' || entry.state === 'waiting') entry.item?.cancel()
    }
    this.bySession.delete(sessionId)
  }

  /**
   * Takes a download of the agent's page: its path in the session's folder is set at once, as
   * Electron asks for it before the handler returns, and it is paused for the user's allow when
   * it is larger than DOWNLOAD_ASK_BYTES, or grows past that without having said its size.
   */
  take(item: DownloadItem, contentsId: number, sessionId: string, folder: string): void {
    const dir = downloadsDir(folder)
    this.know(folder)
    const taken = this.names.get(dir)!
    const name = freeName(safeFileName(item.getFilename() || 'download'), (n) =>
      taken.has(n.toLowerCase()),
    )
    taken.add(name.toLowerCase())
    const path = join(dir, name)
    // Electron makes the folder when it is not there.
    item.setSavePath(path)
    void this.ignore(dir)
    const entry: Entry = { name, path, bytes: 0, state: 'progressing', item }
    const entries = [...(this.bySession.get(sessionId) ?? []), entry].slice(-MAX_LISTED)
    this.bySession.set(sessionId, entries)
    let asked = false
    const ask = (size: number | null): void => {
      asked = true
      item.pause()
      entry.state = 'waiting'
      void this.deps.ask(sessionId, { name, size }).then((allowed) => {
        if (entry.state !== 'waiting') return
        if (allowed) {
          entry.state = 'progressing'
          item.resume()
        } else {
          item.cancel()
        }
      })
    }
    const total = item.getTotalBytes()
    if (total > DOWNLOAD_ASK_BYTES) ask(total)
    item.on('updated', () => {
      entry.bytes = item.getReceivedBytes()
      if (!asked && total <= 0 && entry.bytes > DOWNLOAD_ASK_BYTES) ask(null)
    })
    item.once('done', (_event, state) => {
      entry.bytes = item.getReceivedBytes()
      entry.item = null
      entry.state = state
      if (state !== 'completed') entry.path = null
      this.deps.done(contentsId, name, path, state === 'completed')
      this.deps.note(
        sessionId,
        state === 'completed'
          ? `It downloaded "${name}", ${entry.bytes} bytes, to ${path}.`
          : `The download of "${name}" ${state === 'cancelled' ? 'was cancelled' : 'failed'}.`,
      )
    })
    this.deps.note(sessionId, `It started downloading "${name}" into ${dir}.`)
  }

  /** Writes a file the agent asked for into the session's folder, and answers its path. */
  async save(sessionId: string, folder: string, name: string, data: Buffer): Promise<string> {
    const dir = downloadsDir(folder)
    this.know(folder)
    await mkdir(dir, { recursive: true })
    await this.ignore(dir)
    const taken = this.names.get(dir)!
    const exists = async (candidate: string): Promise<boolean> =>
      access(join(dir, candidate)).then(
        () => true,
        () => false,
      )
    const wanted = safeFileName(name)
    const extension = extname(wanted)
    const stem = wanted.slice(0, wanted.length - extension.length)
    let file = wanted
    for (let n = 2; taken.has(file.toLowerCase()) || (await exists(file)); n++) {
      file = `${stem} (${n})${extension}`
    }
    taken.add(file.toLowerCase())
    const path = join(dir, file)
    await writeFile(path, data)
    const entries = this.bySession.get(sessionId) ?? []
    entries.push({ name: file, path, bytes: data.length, state: 'completed', item: null })
    this.bySession.set(sessionId, entries.slice(-MAX_LISTED))
    return path
  }

  /** The folder's own `.gitignore`, which keeps all it holds out of git; written once. */
  private async ignore(dir: string): Promise<void> {
    if (this.ignored.has(dir)) return
    this.ignored.add(dir)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.deps.log(
          `Could not write the downloads folder's .gitignore: ${(error as Error).message}`,
        )
      }
    }
  }
}

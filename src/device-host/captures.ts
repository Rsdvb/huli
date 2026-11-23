// Huli: where the device tools write what they capture, always inside the session's folder: its
// recordings, screenshots and diff images under `.kite/device`, and baselines where the agent
// names them. A path that leads out of the folder, through a link or otherwise, is refused.

import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEVICE_CAPTURES_FOLDER } from '@shared/device-agent'

export class CaptureError extends Error {}

export type CaptureKind = 'recordings' | 'shots' | 'diffs'

function key(file: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file
}

/** Whether `inner` is `outer` or inside it, both canonical. */
function contains(outer: string, inner: string): boolean {
  const relative = path.relative(key(outer), key(inner))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() === true
}

/** The files of one session's folder, as the disk has it once its links resolve. */
export class SessionFiles {
  private constructor(readonly root: string) {}

  /** The session's folder; a session without one has nowhere to write. */
  static async open(folder: string | null): Promise<SessionFiles> {
    if (!folder || !path.isAbsolute(folder)) {
      throw new CaptureError('This session has no folder to save into.')
    }
    try {
      return new SessionFiles(await realpath(folder))
    } catch {
      throw new CaptureError('This session’s folder is gone.')
    }
  }

  /**
   * The folder for one kind of capture, made on first use beside a `.gitignore` that keeps all of
   * `.kite/device` out of the project's repository.
   */
  async captures(kind: CaptureKind): Promise<string> {
    const base = path.join(this.root, ...DEVICE_CAPTURES_FOLDER.split('/'))
    const dir = path.join(base, kind)
    await mkdir(dir, { recursive: true })
    await this.within(dir)
    await writeFile(path.join(base, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
    return dir
  }

  /**
   * A file the agent named by its path from the folder, which the agent host checked holds no
   * absolute path and no `..`; its folder is made when `make` is set.
   */
  async file(relative: string, make: boolean): Promise<string> {
    const file = path.resolve(this.root, ...relative.split('/'))
    if (!contains(this.root, file)) {
      throw new CaptureError('The path leads out of this session’s folder.')
    }
    const dir = path.dirname(file)
    if (make) await mkdir(dir, { recursive: true })
    else if (!(await stat(dir).catch(() => null))) return file
    await this.within(dir)
    // An existing file may be a link itself.
    if (await exists(file)) await this.within(file)
    return file
  }

  /** A file's path from the folder, with forward slashes, as the agent and the user read it. */
  relative(file: string): string {
    const relative = path.relative(this.root, file)
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? file
      : relative.split(path.sep).join('/')
  }

  /** Whether a file another program named lies in the folder. */
  holds(file: string): boolean {
    return contains(this.root, path.resolve(file))
  }

  private async within(target: string): Promise<void> {
    if (!contains(this.root, await realpath(target))) {
      throw new CaptureError('The path leads out of this session’s folder.')
    }
  }
}

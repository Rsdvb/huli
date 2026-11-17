import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Whether this process may make a symbolic link to a file. Windows lets only an administrator or
 * Developer Mode make one, so a test that needs one is skipped there without the right. A link to
 * a folder needs none: `linkFolder` makes a junction.
 */
export const FILE_LINKS: boolean = (() => {
  if (process.platform !== 'win32') return true
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-links-'))
  try {
    writeFileSync(path.join(dir, 'target'), '')
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/**
 * A link at `at` to the folder `target`: a junction on Windows, the link a user there makes without
 * any right, and a symbolic link elsewhere, where the type is ignored.
 */
export function linkFolder(target: string, at: string): Promise<void> {
  return symlink(path.resolve(target), at, 'junction')
}

/** `linkFolder`, synchronously. */
export function linkFolderSync(target: string, at: string): void {
  symlinkSync(path.resolve(target), at, 'junction')
}

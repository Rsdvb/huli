// Huli: what manager mode reads of a folder's Git, for the review loop: the commit an
// implementation starts from, and what changed since, as best of N reads a run's changes.

import { readChangesSince } from '../git/details'
import { GIT_TIMEOUT_MS, type Exec } from '../git/exec'

export function managerGit(exec: Exec) {
  return {
    async head(folder: string): Promise<string | null> {
      const result = await exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd: folder,
        timeoutMs: GIT_TIMEOUT_MS,
      }).catch(() => null)
      const oid = result && result.code === 0 ? result.stdout.trim() : ''
      return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
    },
    async changesSince(
      folder: string,
      base: string,
    ): Promise<{ path: string; added: number | null; removed: number | null }[] | null> {
      try {
        const read = await readChangesSince(exec, folder, base)
        return read.files.map((file) => ({
          path: file.path,
          added: file.insertions,
          removed: file.deletions,
        }))
      } catch {
        return null
      }
    },
  }
}

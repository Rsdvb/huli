// Huli: how Kite runs git to clone from an address it was given, a new project's or a moved
// session's on the other computer: the address first passes cloneUrlProblem, then git runs with
// only HTTPS and SSH allowed, no transport helper, no hook and no submodule.

import path from 'node:path'
import type { Platform } from '@shared/platform'

/** The transports a clone and what it runs may use. */
export const CLONE_ENV = { GIT_ALLOW_PROTOCOL: 'https:ssh' } as const

/** A folder in Kite's own data that is never made, so a clone finds no hook to run. */
export function noHooksPath(dataDir: string, platform: Platform): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(dataDir, 'no-hooks')
}

/** git's arguments for a clone of `url` into `folder`, `options` such as `--progress` before. */
export function cloneArgs(
  url: string,
  folder: string,
  hooksPath: string,
  options: readonly string[] = [],
): string[] {
  return [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    `core.hooksPath=${hooksPath}`,
    'clone',
    ...options,
    '--no-recurse-submodules',
    '--',
    url,
    folder,
  ]
}

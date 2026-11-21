// Huli: the commands that remove a program the way it was installed: `npm uninstall -g`,
// `brew uninstall`, `winget uninstall` and `uv cache clean`. Every word but the npm prefix comes
// from the catalog; the prefix comes from the disk, so it must not reach cmd.exe, which runs npm's
// `.cmd` on Windows, with anything cmd.exe expands inside quotes.

import type { Platform } from '@shared/platform'
import { NPM_GLOBAL_FLAGS } from '../binary-install'
import { needsShell } from '../find-command'
import { formatCommand } from '../quote'

export interface RemovalCommand {
  /** The line the dialog shows, as the platform's terminal reads it. */
  line: string
  /** What the host runs; null while the tool is not found. */
  run: { program: string; args: string[] } | null
}

/**
 * Whether a word may go to a program that runs through cmd.exe. Quotes keep spaces and `&|<>^`
 * literal, but cmd.exe still expands `%NAME%` (and `!NAME!` with delayed expansion) inside them,
 * a `"` would end the quotes, and a line break ends the command.
 */
export function cmdSafe(word: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[%!"\u0000-\u001f\u007f]/.test(word)
}

function made(
  command: string,
  args: string[],
  tool: string | null,
  platform: Platform,
  extra: readonly string[] = [],
): RemovalCommand | null {
  if (tool && needsShell(tool, platform) && !args.every(cmdSafe)) return null
  return {
    line: formatCommand({ command, args }, platform),
    run: tool ? { program: tool, args: [...args, ...extra] } : null,
  }
}

/**
 * `npm uninstall -g --prefix <prefix> <package>`: the prefix is the one the package was found
 * under, which may not be the PATH npm's own. Null when the prefix cannot go to npm safely.
 */
export function npmUninstall(
  npmPackage: string,
  prefix: string,
  npm: string | null,
  platform: Platform,
): RemovalCommand | null {
  return made('npm', ['uninstall', '-g', '--prefix', prefix, npmPackage], npm, platform, [
    ...NPM_GLOBAL_FLAGS,
  ])
}

/** `brew uninstall [--cask] <name>`. */
export function brewUninstall(
  name: string,
  cask: boolean,
  brew: string | null,
  platform: Platform,
): RemovalCommand | null {
  return made('brew', ['uninstall', ...(cask ? ['--cask'] : []), name], brew, platform)
}

/** `winget uninstall --id <id> -e`, which may not stop to ask: it runs without a terminal. */
export function wingetUninstall(
  id: string,
  winget: string | null,
  platform: Platform,
): RemovalCommand | null {
  return made('winget', ['uninstall', '--id', id, '-e'], winget, platform, [
    '--disable-interactivity',
  ])
}

/** `uv cache clean <package>`: what `uvx` keeps of a package it ran. */
export function uvCacheClean(
  uvPackage: string,
  uv: string | null,
  platform: Platform,
): RemovalCommand | null {
  return made('uv', ['cache', 'clean', uvPackage], uv, platform)
}

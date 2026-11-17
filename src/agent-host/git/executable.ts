// Finds a command on Windows without the working-directory-first search of CreateProcess,
// so a git.exe inside a repository is never run in place of the installed one; and finds git
// where its installers put it when the app started with a PATH that lacks it.

import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { Platform } from '@shared/platform'
import { findCommand, isExecutableFile } from '../find-command'

export type IsFile = (path: string) => Promise<boolean>

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// Node refuses to start .bat and .cmd files without a shell, and the service never uses one.
const RUNNABLE_EXTENSIONS = ['.com', '.exe']

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Looks `name` up in the directories of `PATH`, trying the extensions of `PATHEXT` that can
 * be started directly, and returns the full path or null. Relative `PATH` entries are skipped.
 */
export async function findWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  isFile: IsFile = isRegularFile,
): Promise<string | null> {
  const pathext = (variable(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
  const extensions = RUNNABLE_EXTENSIONS.filter((extension) => pathext.includes(extension))
  const hasExtension = RUNNABLE_EXTENSIONS.includes(win32.extname(name).toLowerCase())
  const suffixes = hasExtension ? [''] : extensions

  const directories = win32.isAbsolute(name)
    ? ['']
    : (variable(env, 'PATH') ?? '')
        .split(';')
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter((entry) => entry !== '' && win32.isAbsolute(entry))
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory === '' ? name + suffix : win32.join(directory, name + suffix)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}

// Homebrew on Apple silicon, then on Intel Macs and Linux, then the system's own.
const POSIX_GIT_FOLDERS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/**
 * Where git's installers put it, tried after `PATH`: an app started from the macOS or Linux
 * desktop gets a minimal one, and Git for Windows may be installed without adding itself. On
 * Windows: for all users, for all users on a 32-bit build, and for the user alone. Only git has
 * any, and only absolute folders from the environment are used.
 */
export function knownLocations(name: string, platform: Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') {
    return name === 'git' ? POSIX_GIT_FOLDERS.map((folder) => `${folder}/git`) : []
  }
  if (name.toLowerCase() !== 'git' && name.toLowerCase() !== 'git.exe') return []
  const roots: [string | undefined, string][] = [
    [variable(env, 'ProgramFiles'), 'Git'],
    [variable(env, 'ProgramW6432'), 'Git'],
    [variable(env, 'ProgramFiles(x86)'), 'Git'],
    [variable(env, 'LOCALAPPDATA'), win32.join('Programs', 'Git')],
  ]
  const found: string[] = []
  for (const [base, folder] of roots) {
    if (!base || !win32.isAbsolute(base)) continue
    const file = win32.join(base, folder, 'cmd', 'git.exe')
    if (!found.some((known) => known.toLowerCase() === file.toLowerCase())) found.push(file)
  }
  return found
}

/**
 * The full path of the command `name`: looked up on `PATH` as the system would, never in the
 * working directory, then in the places its installers put it. Null when it is in neither.
 */
export async function findExecutable(
  name: string,
  platform: Platform,
  env: NodeJS.ProcessEnv,
  isFile: IsFile = (file) =>
    platform === 'win32' ? isRegularFile(file) : isExecutableFile(file, platform),
): Promise<string | null> {
  const onPath =
    platform === 'win32'
      ? await findWindowsExecutable(name, env, isFile)
      : await findCommand(name, { platform, env, isExecutable: isFile })
  if (onPath !== null) return onPath
  for (const file of knownLocations(name, platform, env)) {
    if (await isFile(file)) return file
  }
  return null
}

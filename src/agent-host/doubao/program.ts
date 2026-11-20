// Where Doubao CLI lives. npm installs only a launcher, `scripts/run.cjs` of @bytedance/doubao-cli
// (a `doubao.cmd` shim on Windows), whose install script downloads the native program into the
// user's application data; the launcher then starts `app/current/doubao(.exe)` there. Kettu runs
// that program itself, so neither cmd.exe nor Node.js stands between it and the prompt, and never
// the PowerShell shim, which the default execution policy blocks.

import os from 'node:os'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from '../find-command'
import { shimTarget, type AdapterCli, type CliFiles } from '../installed-cli'

export const DOUBAO_PACKAGE = '@bytedance/doubao-cli'

/** The platforms Doubao CLI ships its native program for. */
const SUPPORTED: readonly string[] = ['win32-x64', 'darwin-arm64', 'linux-x64']

export function supportedPlatform(platform: Platform, arch: string): boolean {
  return SUPPORTED.includes(`${platform}-${arch}`)
}

const platformPath = (platform: Platform): typeof path.posix =>
  platform === 'win32' ? path.win32 : path.posix

/**
 * Its data folder, as its launcher finds it: under LOCALAPPDATA on Windows, Application Support on
 * macOS, and XDG_DATA_HOME or `~/.local/share` on Linux. It holds the program, the sign-in, the
 * logs and each account's workspace.
 */
export function dataFolder(env: Env, platform: Platform, home = os.homedir()): string {
  const p = platformPath(platform)
  const absolute = (value: string | undefined): string | null =>
    value && p.isAbsolute(value) ? value : null
  if (platform === 'win32') {
    const local =
      absolute(getEnv(env, 'LOCALAPPDATA', platform)) ?? p.join(home, 'AppData', 'Local')
    return p.join(local, 'doubao_cli')
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'doubao_cli')
  const data = absolute(getEnv(env, 'XDG_DATA_HOME', platform))
  return p.join(
    data ?? p.join(absolute(getEnv(env, 'HOME', platform)) ?? home, '.local', 'share'),
    'doubao_cli',
  )
}

/** The native program the launcher starts. */
export function nativeProgram(env: Env, platform: Platform, home?: string): string {
  const p = platformPath(platform)
  const name = platform === 'win32' ? 'doubao.exe' : 'doubao'
  return p.join(dataFolder(env, platform, home), 'app', 'current', name)
}

const LAUNCHER = `${DOUBAO_PACKAGE}/scripts/run.cjs`

function isLauncher(file: string): boolean {
  return file.replaceAll('\\', '/').toLowerCase().endsWith(`/node_modules/${LAUNCHER}`)
}

// npm's shims are under 1 KB.
const SHIM_LIMIT = 64 * 1024

/**
 * What runs for the `doubao` found on PATH: the native program, when the command is the npm
 * launcher or the program itself and the program is installed; otherwise the command as found,
 * whose launcher then says what is missing. A PowerShell shim is swapped for the `.cmd` beside it.
 */
export async function resolveProgram(
  found: string,
  platform: Platform,
  files: CliFiles,
  env: Env,
): Promise<string | null> {
  const p = platformPath(platform)
  let command = found
  if (platform === 'win32' && p.extname(command).toLowerCase() === '.ps1') {
    const cmd = `${command.slice(0, -4)}.cmd`
    if (!(await files.isFile(cmd))) return null
    command = cmd
  }
  const native = nativeProgram(env, platform)
  const same = (a: string, b: string): boolean =>
    platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  let launcher: boolean
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const text = await files.readText(command, SHIM_LIMIT).catch(() => null)
    const target = text === null ? null : shimTarget(text, command)
    launcher = target !== null && isLauncher(target)
  } else {
    const real = await files.realpath(command).catch(() => command)
    if (same(real, native)) return native
    launcher = isLauncher(real)
  }
  if (launcher && (await files.isFile(native))) return native
  return command
}

/**
 * The user's own Doubao CLI. The oldest is the version whose stream-json, listing, export and
 * sign-in were checked.
 */
export const DOUBAO_CLI: AdapterCli = {
  command: 'doubao',
  pinsVersion: false,
  oldest: '2.37.2',
  resolve: async (found, platform, files, env = process.env) => {
    const program = await resolveProgram(found, platform, files, env)
    return program === null ? null : { path: program, env: {} }
  },
}

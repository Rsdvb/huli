// Huli: which folder a sandboxed session's container may mount. Only a project folder, writable,
// is ever mounted from the user's computer: never a drive or the file system's root, the home
// folder or anything above it, the system's own folders, the folders that hold sign-ins and keys,
// or Kite's data folder. A path is judged as written and again once its links are followed, so a
// link or junction cannot lead a mount anywhere the rules keep it out of.

import path from 'node:path'
import type { Platform } from '@shared/platform'

export type MountProblem =
  | 'notAbsolute'
  | 'dotSegments'
  | 'badCharacters'
  | 'devicePath'
  | 'root'
  | 'home'
  | 'aboveHome'
  | 'system'
  | 'credentials'
  | 'kiteData'
  | 'missing'

export class MountError extends Error {
  constructor(
    readonly problem: MountProblem,
    readonly folder: string,
  ) {
    super(`Refused to mount ${folder}: ${problem}`)
    this.name = 'MountError'
  }
}

export interface MountContext {
  platform: Platform
  /** The user's home folder. */
  home: string
  /** Kite's data folder, which holds its keys and every session's history. */
  dataDir: string
  /** The folder with its links followed, as `fs.realpath.native` gives it; rejects when missing. */
  realpath(folder: string): Promise<string>
}

/** Folders of the system that no project lives in, on Windows below any drive's root. */
const WINDOWS_SYSTEM = [
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  '$recycle.bin',
  'recovery',
  'boot',
]

const POSIX_SYSTEM = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/snap',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/opt',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/cores',
  '/Volumes',
]

/**
 * Folders under the home folder that hold sign-ins, keys or the agents' own settings; a mount of
 * one or of anything inside one is refused.
 */
const CREDENTIAL_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config',
  '.local',
  '.claude',
  '.codex',
  '.gemini',
  '.qwen',
  '.cursor',
  '.copilot',
  '.factory',
  '.npm',
  '.git-credentials',
  '.netrc',
  'AppData',
  'Library',
]

// Characters a container engine's mount option or WSL's command line cannot carry as they are.
const BAD_CHARACTERS = /[\0\r\n,"'`$;|&<>*?]/

function api(platform: Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The path for comparisons: normalized, without a trailing separator, case-folded on Windows. */
function key(folder: string, platform: Platform): string {
  const p = api(platform)
  let out = p.normalize(folder)
  const root = p.parse(out).root
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return platform === 'win32' ? out.toLowerCase() : out
}

/** Whether `inner` is `outer` or inside it. */
export function within(inner: string, outer: string, platform: Platform): boolean {
  const a = key(inner, platform)
  const b = key(outer, platform)
  if (a === b) return true
  const sep = platform === 'win32' ? '\\' : '/'
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** The problem with a folder as written, before its links are followed; null when there is none. */
export function folderProblem(
  folder: string,
  ctx: Omit<MountContext, 'realpath'>,
): MountProblem | null {
  const { platform } = ctx
  const p = api(platform)
  if (BAD_CHARACTERS.test(folder)) return 'badCharacters'
  if (platform === 'win32') {
    // \\?\ and \\.\ reach devices and paths Windows' own rules do not normalize.
    if (/^[\\/]{2}[?.][\\/]/.test(folder)) return 'devicePath'
    // A drive's folder, or a share's: `C:\x`, `\\server\share\x`.
    if (!/^[a-zA-Z]:[\\/]/.test(folder) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(folder)) {
      return 'notAbsolute'
    }
    // An alternate data stream or a second drive colon.
    if (folder.indexOf(':', 2) !== -1) return 'badCharacters'
  } else if (!folder.startsWith('/')) {
    return 'notAbsolute'
  }
  if (folder.split(/[\\/]+/).some((part) => part === '..' || part === '.')) return 'dotSegments'
  const normal = p.normalize(folder)
  if (key(normal, platform) === key(p.parse(normal).root, platform)) return 'root'
  // A share's own root, `\\server\share`, is a drive's root too.
  if (platform === 'win32' && /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(normal)) return 'root'
  if (within(ctx.dataDir, normal, platform) || within(normal, ctx.dataDir, platform)) {
    return 'kiteData'
  }
  if (key(normal, platform) === key(ctx.home, platform)) return 'home'
  if (within(ctx.home, normal, platform)) return 'aboveHome'
  if (within(normal, ctx.home, platform)) {
    const relative = p.relative(ctx.home, normal)
    const first = relative.split(/[\\/]/)[0] ?? ''
    const fold = (name: string): string => (platform === 'win32' ? name.toLowerCase() : name)
    if (CREDENTIAL_DIRS.some((dir) => fold(dir) === fold(first))) return 'credentials'
    return null
  }
  if (platform === 'win32') {
    const parts = normal.split(/[\\/]+/)
    // `C:\Windows\...`: the part after the drive.
    const top = /^[a-zA-Z]:$/.test(parts[0] ?? '') ? (parts[1] ?? '') : ''
    if (WINDOWS_SYSTEM.includes(top.toLowerCase())) return 'system'
    // Every user's folders, as `C:\Users\Public` or another user's home.
    if (top.toLowerCase() === 'users' && parts.length <= 3) return 'aboveHome'
    return null
  }
  if (POSIX_SYSTEM.some((dir) => within(normal, dir, platform))) {
    // macOS keeps temporary folders under /private/var/folders and links /tmp into /private.
    if (platform === 'darwin' && within(normal, '/private/tmp', platform)) return null
    return 'system'
  }
  // /home and /Users themselves list every user.
  if (key(normal, platform) === '/home' || key(normal, platform) === '/Users') return 'aboveHome'
  return null
}

/**
 * The project folder a container may mount, with its links followed; throws a MountError naming
 * what is wrong with it as written or where its links lead.
 */
export async function projectMount(folder: string, ctx: MountContext): Promise<string> {
  const written = folderProblem(folder, ctx)
  if (written) throw new MountError(written, folder)
  let real: string
  try {
    real = await ctx.realpath(folder)
  } catch {
    throw new MountError('missing', folder)
  }
  // The home and data folders are compared as they really are too, in case either is a link.
  const [home, dataDir] = await Promise.all([
    ctx.realpath(ctx.home).catch(() => ctx.home),
    ctx.realpath(ctx.dataDir).catch(() => ctx.dataDir),
  ])
  const resolved = folderProblem(real, { ...ctx, home, dataDir })
  if (resolved) throw new MountError(resolved, real)
  // A home folder reached through a link is still judged against the one written.
  const original = folderProblem(real, ctx)
  if (original) throw new MountError(original, real)
  return real
}

/** Names Kite gives its containers and volumes: lowercase letters, digits, `-`, `_` and `.`. */
const ENGINE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/

export function isEngineName(name: string): boolean {
  return ENGINE_NAME.test(name)
}

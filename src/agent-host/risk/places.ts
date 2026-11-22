// Where a path a request names lies, by the platform's path rules: in the project (its `.git`
// apart), elsewhere on the computer, in the system's own folders, or a credential. Pure string work:
// nothing here reads the disk, so a link inside the project that leads out is not seen.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import { pathKey } from '../paths'
import type { ShellKind } from './shell-words'

export type Place = 'project' | 'git' | 'outside' | 'system' | 'secret'

export interface PlaceContext {
  platform: Platform
  /** The folder a relative path resolves against; null once a step moved to one not known. */
  cwd: string | null
  /** The folders that count as the project: the session's worktree and its project. */
  roots: readonly string[]
  shell: ShellKind
}

/** Folders that hold keys or sign-ins, by name, anywhere. */
const SECRET_FOLDERS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.1password',
  '.terraform.d',
  'gcloud',
  'keychains',
  'keyrings',
])

/** Files that hold keys, tokens or passwords, by name. */
const SECRET_FILES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  '.git-credentials',
  '.htpasswd',
  '.boto',
  '.s3cfg',
  '.vault-token',
  '.terraformrc',
  'credentials',
  'credentials.json',
  'credentials.db',
  '.credentials.json',
  'auth.json',
  'token.json',
  'tokens.json',
  'known_hosts',
  'authorized_keys',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
  'consolehost_history.txt',
  'login data',
  'cookies',
  'wallet.dat',
  'master.key',
  'terraform.tfstate',
])

const SECRET_EXTENSIONS =
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|tfstate|keychain|keychain-db|ovpn)$/

/** An `.env` file, its copies such as `.env.local` or `.env~` included, but not its templates. */
const ENV_FILE = /^\.env(?![a-z0-9_-])(?!\.(?:example|sample|template|dist|defaults?)$)/
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)/
const SECRETS_FILE = /^secrets?\.(?:json|ya?ml|toml|env|txt|ini)$/

/** Whether one name in a path names a credential, as a folder or a file. */
export function secretName(name: string): boolean {
  const key = name.toLowerCase()
  return (
    SECRET_FOLDERS.has(key) ||
    SECRET_FILES.has(key) ||
    SECRET_EXTENSIONS.test(key) ||
    ENV_FILE.test(key) ||
    SSH_KEY.test(key) ||
    SECRETS_FILE.test(key)
  )
}

function secretPath(names: readonly string[]): boolean {
  return names.some(
    (name, i) =>
      secretName(name) ||
      // GitHub's and hub's sign-ins under ~/.config.
      (name.toLowerCase() === '.config' && /^(?:gh|hub)$/i.test(names[i + 1] ?? '')),
  )
}

/** The system's own folders at the top of a POSIX file system, macOS's included. */
const POSIX_SYSTEM = new Set([
  'etc',
  'usr',
  'bin',
  'sbin',
  'lib',
  'lib32',
  'lib64',
  'libexec',
  'boot',
  'dev',
  'proc',
  'sys',
  'var',
  'root',
  'run',
  'srv',
  'opt',
  'private',
  'system',
  'library',
  'applications',
  'cores',
  'snap',
])

/** Windows' own folders at the top of a drive, in lower case. */
const WINDOWS_SYSTEM = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'system volume information',
  'recovery',
  'boot',
  '$recycle.bin',
])

/** PowerShell's drives other than the disks: the environment, the registry, certificates. */
const POWERSHELL_DRIVE = /^(env|variable|function|alias|cert|hklm|hkcu|wsman):/i

function names(value: string): string[] {
  return value.split(/[\\/]+/).filter((name) => name !== '' && name !== '.')
}

function inside(key: string, root: string, sep: string): boolean {
  return key === root || key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Git Bash's names for Windows' drives, `/c/Users` and `/cygdrive/c/Users`, as `C:\Users`; null
 * for any other path.
 */
function msysDrive(value: string): string | null {
  const match = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(value)
  if (!match) return null
  return `${match[1]!.toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`
}

/**
 * The absolute path `raw` names, or null where that is not known for certain: under the home
 * folder (`~`), relative to a drive's own folder (`C:foo`), on a network share or a device, in
 * Git Bash's own folders, or relative while the folder it runs in is not known.
 */
export function absolutePath(raw: string, ctx: PlaceContext): string | null {
  const win = ctx.platform === 'win32'
  if (raw.startsWith('~')) return null
  let value = raw
  if (win) {
    if (/^[\\/]{2}/.test(value)) return null
    if (/^[A-Za-z]:(?![\\/])/.test(value)) return null
    if (ctx.shell === 'posix' && value.startsWith('/')) {
      const drive = msysDrive(value)
      if (drive === null) return null
      value = drive
    }
  }
  const api = win ? path.win32 : path.posix
  if (api.isAbsolute(value) && (!win || /^[A-Za-z]:[\\/]/.test(value))) return api.normalize(value)
  if (ctx.cwd === null) return null
  return api.resolve(ctx.cwd, value)
}

/**
 * Where `raw` lies. A path under the home folder (`~`) never counts as the project, nor does any
 * path this cannot place for certain, such as a network share or a drive-relative path.
 */
export function placeOf(raw: string, ctx: PlaceContext): Place {
  const { platform, shell } = ctx
  const win = platform === 'win32'
  if (shell === 'powershell') {
    const drive = POWERSHELL_DRIVE.exec(raw)
    if (drive) return /^(?:env|variable|cert)$/i.test(drive[1]!) ? 'secret' : 'system'
    // A provider-qualified path, such as Registry::HKEY_LOCAL_MACHINE.
    if (raw.includes('::')) return 'system'
  }
  if (win && /^[\\/]{2}[?.][\\/]/.test(raw)) return 'system'
  const resolved = absolutePath(raw, ctx)
  if (resolved === null) {
    if (secretPath(names(raw))) return 'secret'
    // Git Bash's own folders, such as /usr/bin; /tmp and the like are only elsewhere.
    if (win && shell === 'posix' && raw.startsWith('/') && !raw.startsWith('//')) {
      const top = names(raw)[0]?.toLowerCase() ?? ''
      return POSIX_SYSTEM.has(top) ? 'system' : 'outside'
    }
    return 'outside'
  }
  const sep = win ? '\\' : '/'
  const key = pathKey(resolved, platform)
  const parts = names(resolved)
  if (secretPath(parts)) return 'secret'
  for (const root of ctx.roots) {
    const base = pathKey(root, platform)
    if (!inside(key, base, sep)) continue
    const within = names(key.slice(base.length))
    return within.some((name) => name.toLowerCase() === '.git') ? 'git' : 'project'
  }
  if (win) {
    const top = parts[1]?.toLowerCase()
    if (top !== undefined && WINDOWS_SYSTEM.has(top)) return 'system'
    if (parts.some((name) => name.toLowerCase() === 'appdata')) return 'system'
    return 'outside'
  }
  const top = parts[0]
  if (top !== undefined && POSIX_SYSTEM.has(top.toLowerCase())) return 'system'
  return 'outside'
}

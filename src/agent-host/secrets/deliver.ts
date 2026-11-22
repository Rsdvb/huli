// Where a request's secrets go: a file of exports in the host's data folder that the session's
// commands load, or a dotenv file inside the session's folder. A write keeps the file's other lines
// and is owner-only where the system has file modes; nothing here logs a value.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { dotenvLine } from '@shared/secret-request'
import { canonicalizePath, pathKey } from '../paths'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** A refusal whose message names the file, never a value. */
export class DeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryError'
  }
}

/** A POSIX shell's line that exports a value, single-quoted so the shell expands nothing in it. */
export function exportLine(name: string, value: string): string {
  return `export ${name}='${value.replace(/'/g, `'\\''`)}'`
}

/** PowerShell's line that sets a variable for the commands after it, expanding nothing. */
export function powershellLine(name: string, value: string): string {
  return `$env:${name} = '${value.replace(/'/g, "''")}'`
}

/**
 * Whether a line sets `name`, in a dotenv file, a shell script or PowerShell; a name is a checked
 * variable name, so it holds nothing a pattern reads specially.
 */
function setsName(line: string, name: string, kind: 'dotenv' | 'sh' | 'ps1'): boolean {
  if (kind === 'ps1') return new RegExp(`^\\s*\\$env:${name}\\s*=`, 'i').test(line)
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)
}

/**
 * The file's text with its lines for the given names replaced: the first such line takes the new
 * one, later ones go, and a name the file lacks is added at its end. Every other line stays.
 */
export function mergeLines(
  text: string,
  lines: ReadonlyMap<string, string>,
  kind: 'dotenv' | 'sh' | 'ps1',
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  const placed = new Set<string>()
  const source = text.length === 0 ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  for (const line of source) {
    const name = [...lines.keys()].find((each) => setsName(line, each, kind))
    if (name === undefined) {
      out.push(line)
      continue
    }
    if (placed.has(name)) continue
    placed.add(name)
    out.push(lines.get(name)!)
  }
  for (const [name, line] of lines) if (!placed.has(name)) out.push(line)
  return out.length === 0 ? '' : `${out.join(eol)}${eol}`
}

/** The session's own files of exports, by a name its id gives. */
export function sessionEnvFiles(
  dir: string,
  sessionId: string,
  platform: Platform,
): { sh: string; ps1: string | null } {
  const base = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
  return {
    sh: path.join(dir, `${base}.sh`),
    ps1: platform === 'win32' ? path.join(dir, `${base}.ps1`) : null,
  }
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return ''
    throw error
  }
}

/** Writes beside the file and renames it over it; a new file is the owner's alone. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.kite-${randomBytes(4).toString('hex')}.tmp`,
  )
  const handle = await open(temp, 'wx', FILE_MODE)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // On Windows a scanner or indexer can hold the target open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 4 || !RETRYABLE.has(code)) {
        await rm(temp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/** Refuses a file that is a link or not a file, so a write never lands elsewhere. */
async function checkPlainFile(file: string, shown: string): Promise<void> {
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink())
      throw new DeliveryError(`${shown} is a link, so Kettu did not write it`)
    if (!info.isFile()) throw new DeliveryError(`${shown} is not a file`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

/**
 * Sets the values in the session's files of exports, the shell's and, on Windows, PowerShell's,
 * keeping the other lines a file holds, such as those a hook of the agent added.
 */
export async function writeSessionEnv(
  dir: string,
  sessionId: string,
  values: ReadonlyMap<string, string>,
  platform: Platform,
): Promise<{ sh: string; ps1: string | null }> {
  const files = sessionEnvFiles(dir, sessionId, platform)
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  const sh = new Map([...values].map(([name, value]) => [name, exportLine(name, value)]))
  await checkPlainFile(files.sh, path.basename(files.sh))
  await replaceFile(files.sh, mergeLines(await readText(files.sh), sh, 'sh'))
  if (files.ps1) {
    const ps1 = new Map([...values].map(([name, value]) => [name, powershellLine(name, value)]))
    await checkPlainFile(files.ps1, path.basename(files.ps1))
    await replaceFile(files.ps1, mergeLines(await readText(files.ps1), ps1, 'ps1'))
  }
  return files
}

/** Removes a session's files of exports, once the session is deleted. */
export async function removeSessionEnv(
  dir: string,
  sessionId: string,
  platform: Platform,
): Promise<void> {
  const files = sessionEnvFiles(dir, sessionId, platform)
  await rm(files.sh, { force: true })
  if (files.ps1) await rm(files.ps1, { force: true })
}

function inside(child: string, root: string, platform: Platform): boolean {
  const c = pathKey(child, platform)
  const r = pathKey(root, platform)
  const sep = platform === 'win32' ? '\\' : '/'
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`)
}

/**
 * Sets the values in a dotenv file inside `root`, by its checked path from there, keeping its
 * other lines. The file and every folder on the way stay inside `root` once links are followed,
 * and the file itself is no link. Resolves with the file's full path.
 */
export async function writeDotenv(
  root: string,
  relative: string,
  values: ReadonlyMap<string, string>,
  platform: Platform,
): Promise<string> {
  const real = await canonicalizePath(root, platform, realpath)
  const p = platform === 'win32' ? path.win32 : path.posix
  const file = p.join(real, ...relative.split('/'))
  if (!inside(file, real, platform)) throw new DeliveryError(`${relative} is outside the folder`)
  const parent = p.dirname(file)
  await mkdir(parent, { recursive: true })
  const realParent = await canonicalizePath(parent, platform, realpath)
  if (!inside(realParent, real, platform)) {
    throw new DeliveryError(`${relative} leads outside the session’s folder`)
  }
  const target = p.join(realParent, p.basename(file))
  await checkPlainFile(target, relative)
  const lines = new Map<string, string>()
  for (const [name, value] of values) {
    const line = dotenvLine(name, value)
    if (line === null) {
      throw new DeliveryError(`The value of ${name} holds characters a dotenv file cannot keep`)
    }
    lines.set(name, line)
  }
  await replaceFile(target, mergeLines(await readText(target), lines, 'dotenv'))
  return target
}

// The files an agent's `browser_upload_file` names, checked in main before any reaches a page: a
// list of absolute paths on this computer, each an existing regular file, within the count and
// size limits. The user is asked about them next; this only decides what may be asked about.

import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from '@shared/browser'

/** The longest path taken, beyond any a file system holds. */
const MAX_PATH_CHARS = 4_096

/** A file that may be put into a page, once the user allows it. */
export interface UploadFile {
  /** Its real path, with links resolved, which the page gets. */
  path: string
  /** Its real name, which the user is asked about and the page sees. */
  name: string
  size: number
}

/** Why a call's files cannot be uploaded, for the agent. */
export class UploadRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRefused'
  }
}

/**
 * Why `path` is not an absolute path to a local file, or null when it is one. On Windows that is a
 * drive letter's path: a UNC or device path would reach out to a network share or a device.
 */
export function uploadPathProblem(path: string, platform: NodeJS.Platform): string | null {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return 'is not a path'
  if (path.includes('\0')) return 'is not a path'
  const absolute = platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) : path.startsWith('/')
  return absolute ? null : 'is not an absolute path to a file on this computer'
}

/** The paths a call gave, as a list of 1 to `MAX_UPLOAD_FILES` absolute paths. */
export function uploadPaths(value: unknown, platform: NodeJS.Platform): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UploadRefused('paths must list at least one file.')
  }
  if (value.length > MAX_UPLOAD_FILES) {
    throw new UploadRefused(`At most ${MAX_UPLOAD_FILES} files go into a page at once.`)
  }
  return value.map((path) => {
    if (typeof path !== 'string') throw new UploadRefused('Each path must be text.')
    const problem = uploadPathProblem(path, platform)
    if (problem) throw new UploadRefused(`${JSON.stringify(path)} ${problem}.`)
    return path
  })
}

/**
 * Each path's real file, after links: it must exist and be a regular file, and all of them
 * together at most `MAX_UPLOAD_BYTES`. A file named twice goes once.
 */
export async function uploadFiles(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): Promise<UploadFile[]> {
  const paths = uploadPaths(value, platform)
  const files: UploadFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const path of paths) {
    let real: string
    try {
      real = await realpath(path)
    } catch {
      throw new UploadRefused(`${JSON.stringify(path)} does not exist or cannot be read.`)
    }
    const info = await stat(real).catch(() => null)
    if (!info?.isFile()) {
      throw new UploadRefused(`${JSON.stringify(path)} is not a file.`)
    }
    const key = platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) continue
    seen.add(key)
    total += info.size
    if (total > MAX_UPLOAD_BYTES) {
      throw new UploadRefused(
        `The files come to more than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, which is more than a page gets at once.`,
      )
    }
    files.push({ path: real, name: basename(real), size: info.size })
  }
  return files
}

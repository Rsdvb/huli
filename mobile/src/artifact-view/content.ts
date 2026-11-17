// A version of an artifact as the phone shows it: what `artifacts.read` lists, and every file's
// bytes from `artifacts.file`, fetched a few at a time. The phone serves them to its pages itself,
// as the desktop's main does for another host's artifacts (src/main/artifacts/remote.ts), so it
// checks what the computer sent the same way before using any of it.

import {
  artifactFileType,
  artifactPathProblem,
  VERSION_BYTES,
  VERSION_FILES,
} from '@shared/artifact-files'
import { isArtifactTypeName, type ArtifactTypeInfo } from '@shared/artifact-types'
import type { ArtifactContent } from '@shared/artifacts'
import type { HostLink } from '@shared/remote/link'

export interface LoadedFile {
  path: string
  type: string
  bytes: Uint8Array
}

export interface LoadedVersion {
  id: string
  version: number
  title: string
  type: ArtifactTypeInfo | null
  files: Map<string, LoadedFile>
  /** All the files' bytes. */
  size: number
}

/** Above this the viewer asks before it fetches everything. */
export const LARGE_BYTES = 24 * 1024 * 1024
const PARALLEL = 4
const KEPT = 3

export class TooLarge extends Error {
  readonly size: number
  constructor(size: number) {
    super('The artifact is large')
    this.size = size
  }
}

function bytesOf(value: unknown): Uint8Array | null {
  const bytes = (value as { bytes?: unknown } | null)?.bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return null
}

function checkedType(value: unknown): ArtifactTypeInfo | null {
  if (value === undefined || value === null) return null
  const { name, format } = value as Record<string, unknown>
  if (!isArtifactTypeName(name) || !Number.isSafeInteger(format)) return null
  return { name, format: format as number }
}

/** The listing `artifacts.read` gave, checked as main checks another host's. */
function checkedRead(value: unknown): ArtifactContent | null {
  if (typeof value !== 'object' || value === null) return null
  const read = value as ArtifactContent
  if (!Number.isSafeInteger(read.version) || read.version < 1) return null
  if (typeof read.title !== 'string' || !Array.isArray(read.files)) return null
  if (read.files.length > VERSION_FILES) return null
  const seen = new Set<string>()
  let total = 0
  for (const file of read.files) {
    if (typeof file?.path !== 'string' || artifactPathProblem(file.path) !== null) return null
    if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) return null
    seen.add(file.path)
    total += file.size
  }
  if (total > VERSION_BYTES) return null
  return read
}

const kept = new Map<string, LoadedVersion>()

function remember(key: string, loaded: LoadedVersion): void {
  kept.delete(key)
  kept.set(key, loaded)
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
}

/**
 * A version's files, the latest when `version` is null. Rejects with TooLarge for a version over
 * LARGE_BYTES unless `anySize`; `progress` hears how many bytes have come.
 */
export async function loadVersion(
  link: HostLink,
  hostKey: string,
  id: string,
  version: number | null,
  options: { anySize?: boolean; progress?: (done: number, total: number) => void } = {},
): Promise<LoadedVersion> {
  if (version !== null) {
    const hit = kept.get(`${hostKey}:${id}:${version}`)
    if (hit) return hit
  }
  const read = checkedRead(
    await link.request('artifacts.read', version === null ? { id } : { id, version }),
  )
  if (!read || (version !== null && read.version !== version)) {
    throw new Error('电脑发来的内容不完整。')
  }
  const key = `${hostKey}:${id}:${read.version}`
  const hit = kept.get(key)
  if (hit) return hit
  const total = read.files.reduce((sum, f) => sum + f.size, 0)
  if (total > LARGE_BYTES && !options.anySize) throw new TooLarge(total)

  const files = new Map<string, LoadedFile>()
  let done = 0
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < read.files.length; i = next++) {
      const info = read.files[i]!
      const answer = await link.request('artifacts.file', {
        id,
        version: read.version,
        path: info.path,
      })
      const bytes = bytesOf(answer)
      if (!bytes || bytes.byteLength > VERSION_BYTES) throw new Error('电脑发来的文件不完整。')
      files.set(info.path, { path: info.path, type: artifactFileType(info.path), bytes })
      done += bytes.byteLength
      options.progress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, read.files.length) }, worker))
  const loaded: LoadedVersion = {
    id,
    version: read.version,
    title: read.title,
    type: checkedType(read.type),
    // In the listing's order, which the canvas and the exports follow.
    files: new Map(read.files.map((f) => [f.path, files.get(f.path)!])),
    size: total,
  }
  remember(key, loaded)
  return loaded
}

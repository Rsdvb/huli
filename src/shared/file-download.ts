// Huli: a file's bytes downloaded a part at a time with `files.readBytes`, as the phone does to
// preview a document. A few parts are asked for ahead; each is checked against its SHA-256, its
// offset and its length before it is written, in order, and every part after the first must find
// the file as the first did, so a file that changes meanwhile starts over instead of mixing two.

import { FILE_BYTES_PART, type FileBytes, type FileStamp } from './files'

/** What the phone asks for at a time: small enough to show progress, large enough to stream. */
export const DOWNLOAD_PART = 1024 * 1024

/** Parts asked for before the earliest one came, which hides the round trip over a relay. */
export const DOWNLOAD_AHEAD = 3

/** How often a file that changed while it downloaded starts over before the download fails. */
export const DOWNLOAD_RESTARTS = 2

export type DownloadFailure =
  /** The file kept changing while it downloaded. */
  | 'changed'
  /** A part did not match its hash, its offset or its length. */
  | 'corrupt'

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadFailure,
    message: string,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface DownloadDeps {
  /** One `files.readBytes` for the file, of these bytes. */
  read(
    part: { offset: number; length: number; expect?: FileStamp },
    signal: AbortSignal,
  ): Promise<FileBytes>
  /** The SHA-256 of the bytes, in lowercase hex. */
  sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>
  /** Appends the next bytes of the file to what is being written. */
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  /** Empties what was written, as the file changed and starts over. */
  restart(): Promise<void>
  /** How many of the file's bytes are written, of its size. */
  progress?(written: number, size: number): void
  signal?: AbortSignal
  /** The bytes asked for at a time; DOWNLOAD_PART unless given, at most FILE_BYTES_PART. */
  partBytes?: number
  ahead?: number
}

export type DownloadResult =
  | ({ kind: 'done'; name: string } & FileStamp)
  | { kind: 'too-large'; name: string; size: number; limit: number }

/**
 * Downloads the file through `deps`, which writes it; resolves once all of it is written, or with
 * `too-large` when the host will not hand out a file that large. Rejects with a DownloadError when
 * a part is wrong or the file kept changing, and with what `read` rejects with otherwise, as when
 * `signal` aborts.
 */
export async function downloadFile(deps: DownloadDeps): Promise<DownloadResult> {
  const part = Math.max(1, Math.min(deps.partBytes ?? DOWNLOAD_PART, FILE_BYTES_PART))
  for (let restarts = 0; ; restarts++) {
    const outcome = await downloadOnce(deps, part)
    if (outcome !== 'changed') return outcome
    if (restarts >= DOWNLOAD_RESTARTS) {
      throw new DownloadError('changed', 'The file kept changing while it downloaded')
    }
    stopIfAborted(deps.signal)
    await deps.restart()
  }
}

async function downloadOnce(deps: DownloadDeps, part: number): Promise<DownloadResult | 'changed'> {
  // Parts still in flight once this pass ends are given up with it.
  const parts = new AbortController()
  const stop = () => parts.abort()
  deps.signal?.addEventListener('abort', stop, { once: true })
  try {
    stopIfAborted(deps.signal)
    const first = await deps.read({ offset: 0, length: part }, parts.signal)
    if (first.kind === 'too-large') return first
    if (first.kind === 'changed') return 'changed'
    const stamp: FileStamp = { size: first.size, mtimeMs: first.mtimeMs }
    const ask = (offset: number): Promise<FileBytes> => {
      const asked = deps.read({ offset, length: part, expect: stamp }, parts.signal)
      // Left unread when an earlier part ends the pass; its failure is no one's then.
      asked.catch(() => {})
      return asked
    }
    const ahead = Math.max(1, deps.ahead ?? DOWNLOAD_AHEAD)
    const waiting: { offset: number; answer: Promise<FileBytes> }[] = []
    let asked = Math.min(part, stamp.size)
    const fill = () => {
      while (waiting.length < ahead && asked < stamp.size) {
        waiting.push({ offset: asked, answer: ask(asked) })
        asked += part
      }
    }
    fill()
    let written = 0
    let answer: FileBytes = first
    let offset = 0
    for (;;) {
      const checked = await checkPart(deps, answer, offset, part, stamp)
      if (checked === 'changed') return 'changed'
      await deps.write(checked)
      written += checked.length
      deps.progress?.(written, stamp.size)
      stopIfAborted(deps.signal)
      const next = waiting.shift()
      if (!next) break
      fill()
      offset = next.offset
      answer = await next.answer
    }
    if (written !== stamp.size) {
      throw new DownloadError('corrupt', `Got ${written} of the file's ${stamp.size} bytes`)
    }
    return { kind: 'done', name: first.name, ...stamp }
  } finally {
    deps.signal?.removeEventListener('abort', stop)
    parts.abort()
  }
}

/** Rejects as the link does for a request given up; a phone's signal may lack throwIfAborted. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The download was given up', 'AbortError')
}

/** The part's bytes when they are the ones asked for, unchanged; `changed` when the file is not. */
async function checkPart(
  deps: DownloadDeps,
  answer: FileBytes,
  offset: number,
  part: number,
  stamp: FileStamp,
): Promise<Uint8Array<ArrayBuffer> | 'changed'> {
  // A file grown past the limit since its first part changed as much as any other.
  if (answer.kind !== 'part') return 'changed'
  if (answer.size !== stamp.size || answer.mtimeMs !== stamp.mtimeMs) return 'changed'
  const bytes = new Uint8Array(answer.bytes)
  const expected = Math.min(part, stamp.size - offset)
  if (answer.offset !== offset || bytes.length !== expected) {
    throw new DownloadError('corrupt', `The part at ${offset} is not the one asked for`)
  }
  if ((await deps.sha256(bytes)) !== answer.sha256.toLowerCase()) {
    throw new DownloadError('corrupt', `The part at ${offset} does not match its hash`)
  }
  return bytes
}

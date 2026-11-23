// What a device uploads as byte streams, each assembled in a file of the remote host's upload
// folder until a request names it. An attachment's file is handed to the agent host as it lies on
// disk, which moves it out of the folder; any other upload is read once and deleted. An upload the
// device cancels, one it leaves without bytes or unnamed for a minute, one the disk has no room
// for, and every one of a connection that ends goes too. While the disk lags behind what a device
// sends, its connections stop reading.

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, statfs, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { loggedPortError } from '@shared/hosts-text'
import type { PortError } from '@shared/port-rpc'
import {
  isDeviceStream,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS,
  MEMORY_UPLOAD_BYTES,
  UPLOAD_IDLE_MS,
} from '@shared/remote/streams'
import type { Transport } from '@shared/remote/transport'

/** Bytes a device's uploads may hold, received and not yet written, before it is read no more. */
export const MAX_UNWRITTEN = 1024 * 1024

/** Free disk an upload leaves the computer at the least, past every upload still coming. */
export const FREE_MARGIN = 256 * 1024 * 1024

/** Empties the upload folder of what an earlier run left, and makes it when there is none. */
export async function clearUploads(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true, mode: 0o700 })
}

/** The bytes free to this user on the folder's disk, or null when the system does not say. */
export async function freeSpace(folder: string): Promise<number | null> {
  try {
    const info = await statfs(folder)
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

/** Uploads in flight per device, over all its connections, and their bytes not yet written. */
export class UploadCounts {
  private readonly counts = new Map<string, number>()
  private readonly unwrittenBytes = new Map<string, number>()
  /** The connections of each device that stopped reading until its writes are within the bound. */
  private readonly behind = new Map<string, Set<() => void>>()
  /** Bytes the open uploads of every device have still to bring, which the disk must have room for. */
  private coming = 0

  constructor(
    readonly max = MAX_UPLOADS,
    readonly maxUnwritten = MAX_UNWRITTEN,
  ) {}

  take(deviceId: string): boolean {
    const count = this.counts.get(deviceId) ?? 0
    if (count >= this.max) return false
    this.counts.set(deviceId, count + 1)
    return true
  }

  release(deviceId: string): void {
    const count = (this.counts.get(deviceId) ?? 0) - 1
    if (count > 0) this.counts.set(deviceId, count)
    else this.counts.delete(deviceId)
  }

  of(deviceId: string): number {
    return this.counts.get(deviceId) ?? 0
  }

  /** Bytes still to come for the open uploads. */
  get promised(): number {
    return this.coming
  }

  /** An upload opened that brings `bytes`, or bytes promised came or will not. */
  promise(bytes: number): void {
    this.coming = Math.max(0, this.coming + bytes)
  }

  /** Bytes the device's uploads received; whether its writes now lag past the bound. */
  received(deviceId: string, bytes: number): boolean {
    const total = this.unwritten(deviceId) + bytes
    this.unwrittenBytes.set(deviceId, total)
    return total > this.maxUnwritten
  }

  /** Bytes received before are written, or gone with their upload. */
  written(deviceId: string, bytes: number): void {
    const total = this.unwritten(deviceId) - bytes
    if (total > 0) this.unwrittenBytes.set(deviceId, total)
    else this.unwrittenBytes.delete(deviceId)
    if (total > this.maxUnwritten) return
    const waiting = this.behind.get(deviceId)
    this.behind.delete(deviceId)
    for (const resume of waiting ?? []) resume()
  }

  unwritten(deviceId: string): number {
    return this.unwrittenBytes.get(deviceId) ?? 0
  }

  /**
   * Calls `resume` once the device's writes are back within the bound, which they are past now;
   * the function it returns stops waiting.
   */
  caughtUp(deviceId: string, resume: () => void): () => void {
    const waiting = this.behind.get(deviceId) ?? new Set<() => void>()
    this.behind.set(deviceId, waiting)
    waiting.add(resume)
    return () => {
      waiting.delete(resume)
      if (waiting.size === 0 && this.behind.get(deviceId) === waiting) this.behind.delete(deviceId)
    }
  }
}

/** A device broke the protocol, which only a bug or an attacker does, so it is not translated. */
function protocolError(message: string): PortError {
  return { code: 'invalid_params', message }
}

/** Why an upload a request names cannot be used, as the request's error. */
export class UploadError extends Error {
  constructor(readonly error: PortError) {
    super(error.message)
  }
}

interface Upload {
  stream: number
  size: number
  received: number
  file: string
  /** Each step on the file after the one before, from its creation; null when it was not made. */
  writing: Promise<FileHandle | null>
  complete: boolean
  claimed: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Settles once every byte is in the file, or rejects when the upload goes first. */
  done: Promise<void>
  settle: { resolve: () => void; reject: (error: UploadError) => void }
}

export interface UploadsOptions {
  folder: string
  deviceId: string
  counts: UploadCounts
  /** The connection's, which stops reading while the device's writes lag past the bound. */
  transport: Pick<Transport, 'pause' | 'resume'>
  /** The host gave an upload up, for the device to hear why. */
  cancelled(stream: number, error: PortError): void
  maxBytes?: number
  /** The largest upload a request other than an attachment's file takes, read into memory. */
  memoryBytes?: number
  idleMs?: number
  /** The bytes free on the folder's disk, which tests give; null takes the upload. */
  freeSpace?: (folder: string) => Promise<number | null>
  freeMargin?: number
}

/** One connection's uploads. */
export class Uploads {
  private readonly uploads = new Map<number, Upload>()
  /** Files handed to the agent host, until it answers the request that names them. */
  private readonly handed = new Set<string>()
  private last = 0
  private closed = false
  /** Stops waiting for the device's writes, while this connection reads nothing. */
  private behind: (() => void) | null = null
  private readonly maxBytes: number
  private readonly memoryBytes: number
  private readonly idleMs: number

  constructor(private readonly options: UploadsOptions) {
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES
    this.memoryBytes = options.memoryBytes ?? MEMORY_UPLOAD_BYTES
    this.idleMs = options.idleMs ?? UPLOAD_IDLE_MS
  }

  /**
   * Takes `stream` as the device's next id, for an upload or another of its streams; false when
   * it breaks the protocol, being even or not above the last.
   */
  takeId(stream: unknown): stream is number {
    if (!isDeviceStream(stream) || stream <= this.last) return false
    this.last = stream
    return true
  }

  /** Opens an upload; false when its id breaks the protocol, being even or not above the last. */
  open(stream: unknown, size: unknown): boolean {
    if (!this.takeId(stream)) return false
    if (this.closed) return true
    const { counts, deviceId } = this.options
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      this.refuse(stream, protocolError(`Upload ${stream} has no size in bytes`))
    } else if (size > this.maxBytes) {
      this.refuse(
        stream,
        loggedPortError('invalid_params', 'remote.uploadTooLarge', { max: this.maxBytes }),
      )
    } else if (!counts.take(deviceId)) {
      this.refuse(stream, loggedPortError('busy', 'remote.uploadsBusy', { max: counts.max }))
    } else {
      this.start(stream, size)
    }
    return true
  }

  bytes(stream: number, data: Uint8Array): void {
    const upload = this.uploads.get(stream)
    // Bytes of an upload the host gave up may still be on their way.
    if (!upload || upload.complete) return
    if (upload.received + data.length > upload.size) {
      return this.fail(
        upload,
        protocolError(`Upload ${stream} carried more than its ${upload.size} bytes`),
      )
    }
    upload.received += data.length
    const { counts, deviceId } = this.options
    counts.promise(-data.length)
    const lagging = counts.received(deviceId, data.length)
    this.queue(
      upload,
      (handle) => write(handle, data),
      () => counts.written(deviceId, data.length),
    )
    if (lagging) this.stopReading()
    this.watch(upload)
  }

  end(stream: number): void {
    const upload = this.uploads.get(stream)
    if (!upload || upload.complete) return
    if (upload.received !== upload.size) {
      const message = `Upload ${stream} ended after ${upload.received} of its ${upload.size} bytes`
      return this.fail(upload, protocolError(message))
    }
    upload.complete = true
    this.queue(upload, async (handle) => {
      await handle.close()
      upload.settle.resolve()
    })
    this.watch(upload)
  }

  /** The device gives an upload up; one a request is reading already is past giving up. */
  cancel(stream: number): void {
    const upload = this.uploads.get(stream)
    if (!upload || (upload.claimed && upload.complete)) return
    this.drop(upload, { code: 'invalid_params', message: `Upload ${stream} was cancelled` })
  }

  /**
   * The bytes of the upload `stream`, which a request names, once they are all in; its file goes
   * once they are read. It is claimed at once, so no other request may name it. Only one within
   * the memory bound is read; a larger one can only be an attachment's file.
   */
  async claim(stream: unknown): Promise<ArrayBuffer> {
    const upload = this.claimed(stream)
    try {
      if (upload.size > this.memoryBytes) {
        const message = `Upload ${upload.stream} is over ${this.memoryBytes} bytes, which only an attachment's file may be`
        throw new UploadError({ code: 'invalid_params', message })
      }
      await upload.done
      const data = await readFile(upload.file)
      return data.buffer.byteLength === data.byteLength
        ? (data.buffer as ArrayBuffer)
        : new Uint8Array(data).buffer
    } catch (error) {
      if (error instanceof UploadError) throw error
      throw new UploadError(loggedPortError('internal', 'remote.uploadUnreadable'))
    } finally {
      this.drop(upload, null)
    }
  }

  /**
   * The name of the file of the upload `stream`, which an attachment's request names, once all
   * its bytes are in: the agent host takes the file from the folder as it is, unread. The file is
   * this connection's no longer, but stays handed until `settled` or the connection ends, for
   * whatever the agent host leaves of it to go.
   */
  async claimFile(stream: unknown): Promise<string> {
    const upload = this.claimed(stream)
    try {
      await upload.done
    } catch (error) {
      this.drop(upload, null)
      if (error instanceof UploadError) throw error
      throw new UploadError({ code: 'internal', message: `Upload ${stream} could not be written` })
    }
    // Ended with the connection while the last write closed the file.
    if (this.uploads.get(upload.stream) !== upload) {
      throw new UploadError({ code: 'invalid_params', message: 'The connection ended' })
    }
    this.uploads.delete(upload.stream)
    this.options.counts.release(this.options.deviceId)
    if (upload.timer) clearTimeout(upload.timer)
    this.handed.add(upload.file)
    return path.basename(upload.file)
  }

  /** The agent host answered a request that named these handed files: what it left of them goes. */
  settled(names: readonly string[]): void {
    for (const name of names) {
      const file = path.join(this.options.folder, name)
      if (this.handed.delete(file)) void rm(file, { force: true }).catch(() => {})
    }
  }

  /**
   * The connection dropped while its session stays: the uploads it had not finished go, as their
   * bytes on the way are lost, and the finished ones wait for the requests that name them.
   */
  dropUnfinished(): void {
    const error = loggedPortError('invalid_params', 'remote.connectionEnded')
    for (const upload of [...this.uploads.values()]) {
      if (!upload.complete) this.drop(upload, error)
    }
  }

  /** The connection ended: every upload goes, and every file handed over not taken yet. */
  closeAll(): void {
    this.closed = true
    this.behind?.()
    this.behind = null
    const error = loggedPortError('invalid_params', 'remote.connectionEnded')
    for (const upload of [...this.uploads.values()]) this.drop(upload, error)
    for (const file of this.handed) void rm(file, { force: true }).catch(() => {})
    this.handed.clear()
  }

  /** The upload a request names, claimed at once so no other request may name it. */
  private claimed(stream: unknown): Upload {
    const upload = typeof stream === 'number' ? this.uploads.get(stream) : undefined
    if (!upload || upload.claimed) {
      const message = `Stream ${String(stream)} is no upload waiting on this connection`
      throw new UploadError({ code: 'invalid_params', message })
    }
    upload.claimed = true
    this.watch(upload)
    return upload
  }

  private start(stream: number, size: number): void {
    const file = path.join(this.options.folder, `${randomBytes(16).toString('hex')}.part`)
    let settle!: Upload['settle']
    const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    // An upload given up before a request names it has nobody to tell.
    done.catch(() => {})
    const upload: Upload = {
      stream,
      size,
      received: 0,
      file,
      writing: Promise.resolve(null),
      complete: false,
      claimed: false,
      timer: null,
      done,
      settle,
    }
    const { counts } = this.options
    // What the uploads before it have still to write is not on the disk yet either.
    const ahead = counts.promised
    counts.promise(size)
    upload.writing = this.roomFor(size, ahead)
      .then((room) => {
        if (room) return open(file, 'wx', 0o600)
        this.fail(upload, loggedPortError('unavailable', 'remote.uploadNoSpace', { size }))
        return null
      })
      .catch(() => {
        this.fail(upload, loggedPortError('internal', 'remote.uploadUnwritable'))
        return null
      })
    this.uploads.set(stream, upload)
    this.watch(upload)
  }

  /** Whether the disk has room for `size` more bytes past `ahead` and the margin it keeps. */
  private async roomFor(size: number, ahead: number): Promise<boolean> {
    const free = await (this.options.freeSpace ?? freeSpace)(this.options.folder)
    return free === null || free - ahead >= size + (this.options.freeMargin ?? FREE_MARGIN)
  }

  /**
   * Runs `step` on the upload's file after every step before it, while the upload is kept, then
   * `settled` whether it ran or not.
   */
  private queue(
    upload: Upload,
    step: (handle: FileHandle) => Promise<unknown>,
    settled?: () => void,
  ): void {
    upload.writing = upload.writing.then(async (handle) => {
      try {
        if (handle && this.uploads.get(upload.stream) === upload) await step(handle)
      } catch {
        this.fail(upload, loggedPortError('internal', 'remote.uploadUnwritable'))
      } finally {
        settled?.()
      }
      return handle
    })
  }

  /** The disk lags past the bound: the connection reads nothing until it is back within it. */
  private stopReading(): void {
    if (this.behind || this.closed) return
    const { transport, counts, deviceId } = this.options
    transport.pause()
    this.behind = counts.caughtUp(deviceId, () => {
      this.behind = null
      transport.resume()
    })
  }

  /** Restarts the minute an upload may wait for its next bytes or for a request to name it. */
  private watch(upload: Upload): void {
    if (upload.timer) clearTimeout(upload.timer)
    upload.timer = null
    if (upload.claimed && upload.complete) return
    upload.timer = setTimeout(() => {
      const key = upload.complete ? 'remote.uploadUnclaimed' : 'remote.uploadStalled'
      this.fail(upload, loggedPortError('invalid_params', key, { seconds: this.idleMs / 1000 }))
    }, this.idleMs)
  }

  private refuse(stream: number, error: PortError): void {
    this.options.cancelled(stream, error)
  }

  /** The host gives an upload up and tells the device why. */
  private fail(upload: Upload, error: PortError): void {
    if (this.uploads.get(upload.stream) !== upload) return
    this.drop(upload, error)
    this.options.cancelled(upload.stream, error)
  }

  /** Forgets an upload and deletes its file; a request waiting for it fails with `error`. */
  private drop(upload: Upload, error: PortError | null): void {
    if (this.uploads.get(upload.stream) !== upload) return
    this.uploads.delete(upload.stream)
    this.options.counts.release(this.options.deviceId)
    if (!upload.complete) this.options.counts.promise(-(upload.size - upload.received))
    if (upload.timer) clearTimeout(upload.timer)
    if (error) upload.settle.reject(new UploadError(error))
    const { file } = upload
    upload.writing = upload.writing
      .then((handle) => handle?.close())
      .catch(() => {})
      .then(() => rm(file, { force: true }))
      .then(
        () => null,
        () => null,
      )
  }
}

async function write(handle: FileHandle, data: Uint8Array): Promise<void> {
  let written = 0
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written)
    written += bytesWritten
  }
}

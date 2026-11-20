// Huli: the backup's zip files, written and read a file at a time so a data folder of any size
// never sits in memory. Entries are stored or deflated, named in UTF-8, and switch to zip64's
// fields past 4 GiB; the writer fills in each local header once its entry is written, so it needs
// no data descriptors, and the reader takes the central directory as the truth.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { PassThrough, Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const END64_SIGNATURE = 0x06064b50
const LOCATOR_SIGNATURE = 0x07064b50
const UTF8_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001
const ZIP64_EXTRA = 0x0001
const STORED = 0
const DEFLATED = 8
const MAX32 = 0xffffffff
const MAX16 = 0xffff
// An entry from this size on gets zip64's sizes in its local header; deflate can grow a little.
const ZIP64_FROM = 0xf0000000
const END_SIZE = 22
const LOCATOR_SIZE = 20
const END64_SIZE = 56
const MAX_COMMENT = 0xffff
/** The longest name an entry may have here; the format allows 64 KiB. */
export const MAX_NAME_BYTES = 1024

export type ZipMethod = typeof STORED | typeof DEFLATED

export interface ZipEntry {
  name: string
  method: ZipMethod
  crc: number
  size: number
  compressedSize: number
  /** Where its local header starts. */
  offset: number
  modified: Date
}

/** What an entry written held: its bytes as read, and their SHA-256 in hex. */
export interface WrittenEntry {
  size: number
  sha256: string
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function fromDos(time: number, date: number): Date {
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  )
}

function writeUInt64(buffer: Buffer, value: number, at: number): void {
  buffer.writeBigUInt64LE(BigInt(value), at)
}

function readUInt64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('A size in the zip is too large')
  return Number(value)
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** A name as an entry may carry it: relative, `/`-separated, without `.` or `..` parts. */
export function isEntryName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES) return false
  if (name.startsWith('/') || name.endsWith('/') || name.includes('\\') || name.includes('\0')) {
    return false
  }
  if (/^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

interface Pending {
  name: Buffer
  method: ZipMethod
  crc: number
  size: number
  compressedSize: number
  offset: number
  time: number
  date: number
  zip64: boolean
}

/** Writes a zip from the start of `file`, which it creates or empties. */
export class ZipWriter {
  private position = 0
  private readonly entries: Pending[] = []
  private readonly names = new Set<string>()
  private closed = false

  private constructor(private readonly handle: FileHandle) {}

  static async create(file: string): Promise<ZipWriter> {
    return new ZipWriter(await open(file, 'w'))
  }

  /** Bytes written so far. */
  get written(): number {
    return this.position
  }

  /** Adds a file read from disk; `expected` is its size when known, which picks zip64 early. */
  addFile(
    name: string,
    source: string,
    options: { compress: boolean; modified?: Date; expected?: number },
  ): Promise<WrittenEntry> {
    return this.add(
      name,
      () => createReadStream(source, { highWaterMark: 1 << 20 }),
      options.compress,
      options.modified ?? new Date(),
      options.expected ?? 0,
    )
  }

  addBuffer(
    name: string,
    data: Buffer,
    options: { compress: boolean; modified?: Date },
  ): Promise<WrittenEntry> {
    return this.add(
      name,
      () => Readable.from([data]),
      options.compress,
      options.modified ?? new Date(),
      data.length,
    )
  }

  private async write(data: Buffer, at: number): Promise<void> {
    let done = 0
    while (done < data.length) {
      const { bytesWritten } = await this.handle.write(data, done, data.length - done, at + done)
      done += bytesWritten
    }
  }

  private async add(
    name: string,
    source: () => Readable,
    compress: boolean,
    modified: Date,
    expected: number,
  ): Promise<WrittenEntry> {
    if (this.closed) throw new ZipError('The zip is closed')
    if (!isEntryName(name)) throw new ZipError(`Not a name an entry may have: ${name}`)
    if (this.names.has(name)) throw new ZipError(`Two entries named ${name}`)
    const encoded = Buffer.from(name, 'utf8')
    const zip64 = expected >= ZIP64_FROM
    const method: ZipMethod = compress ? DEFLATED : STORED
    const { time, date } = dosDateTime(modified)
    const offset = this.position
    const header = localHeader(encoded, method, time, date, zip64)
    await this.write(header, offset)
    let at = offset + header.length
    const hash = createHash('sha256')
    let crc = 0
    let size = 0
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk)
        crc = crc32(chunk, crc)
        size += chunk.length
        done(null, chunk)
      },
    })
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.write(chunk, at).then(() => {
          at += chunk.length
          done()
        }, done)
      },
    })
    if (compress) await pipeline(source(), tap, createDeflateRaw({ level: 6 }), sink)
    else await pipeline(source(), tap, sink)
    const compressedSize = at - offset - header.length
    if (!zip64 && (size > MAX32 || compressedSize > MAX32)) {
      throw new ZipError(`${name} grew past 4 GiB while it was read`)
    }
    const entry: Pending = {
      name: encoded,
      method,
      crc,
      size,
      compressedSize,
      offset,
      time,
      date,
      zip64,
    }
    await this.write(sizes(entry), offset + 14)
    if (zip64) {
      const extra = Buffer.alloc(16)
      writeUInt64(extra, size, 0)
      writeUInt64(extra, compressedSize, 8)
      await this.write(extra, offset + 30 + encoded.length + 4)
    }
    this.position = at
    this.entries.push(entry)
    this.names.add(name)
    return { size, sha256: hash.digest('hex') }
  }

  /** Writes the central directory and the end records, flushes the file and closes it. */
  async close(): Promise<void> {
    if (this.closed) return
    const start = this.position
    const parts: Buffer[] = this.entries.map(centralHeader)
    const directory = Buffer.concat(parts)
    await this.write(directory, start)
    let at = start + directory.length
    const count = this.entries.length
    const needs64 = count >= MAX16 || start >= MAX32 || directory.length >= MAX32
    if (needs64) {
      const record = Buffer.alloc(END64_SIZE)
      record.writeUInt32LE(END64_SIGNATURE, 0)
      writeUInt64(record, END64_SIZE - 12, 4)
      record.writeUInt16LE(45, 12)
      record.writeUInt16LE(45, 14)
      writeUInt64(record, count, 24)
      writeUInt64(record, count, 32)
      writeUInt64(record, directory.length, 40)
      writeUInt64(record, start, 48)
      const locator = Buffer.alloc(LOCATOR_SIZE)
      locator.writeUInt32LE(LOCATOR_SIGNATURE, 0)
      writeUInt64(locator, at, 8)
      locator.writeUInt32LE(1, 16)
      await this.write(Buffer.concat([record, locator]), at)
      at += END64_SIZE + LOCATOR_SIZE
    }
    const end = Buffer.alloc(END_SIZE)
    end.writeUInt32LE(END_SIGNATURE, 0)
    end.writeUInt16LE(Math.min(count, MAX16), 8)
    end.writeUInt16LE(Math.min(count, MAX16), 10)
    end.writeUInt32LE(Math.min(directory.length, MAX32), 12)
    end.writeUInt32LE(Math.min(start, MAX32), 16)
    await this.write(end, at)
    this.position = at + END_SIZE
    await this.handle.sync()
    await this.handle.close()
    this.closed = true
  }

  /** Closes the file without finishing it, as a failed backup does before removing it. */
  async abort(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close().catch(() => {})
  }
}

function localHeader(
  name: Buffer,
  method: ZipMethod,
  time: number,
  date: number,
  zip64: boolean,
): Buffer {
  const header = Buffer.alloc(30 + name.length + (zip64 ? 20 : 0))
  header.writeUInt32LE(LOCAL_SIGNATURE, 0)
  header.writeUInt16LE(zip64 ? 45 : 20, 4)
  header.writeUInt16LE(UTF8_FLAG, 6)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(zip64 ? 20 : 0, 28)
  name.copy(header, 30)
  if (zip64) {
    header.writeUInt16LE(ZIP64_EXTRA, 30 + name.length)
    header.writeUInt16LE(16, 32 + name.length)
  }
  return header
}

/** The CRC and the sizes, as they go at offset 14 of the entry's local header. */
function sizes(entry: Pending): Buffer {
  const buffer = Buffer.alloc(12)
  buffer.writeUInt32LE(entry.crc >>> 0, 0)
  buffer.writeUInt32LE(entry.zip64 ? MAX32 : entry.compressedSize, 4)
  buffer.writeUInt32LE(entry.zip64 ? MAX32 : entry.size, 8)
  return buffer
}

function centralHeader(entry: Pending): Buffer {
  const wide: number[] = []
  const size = entry.size >= MAX32 ? (wide.push(entry.size), MAX32) : entry.size
  const compressed =
    entry.compressedSize >= MAX32 ? (wide.push(entry.compressedSize), MAX32) : entry.compressedSize
  const offset = entry.offset >= MAX32 ? (wide.push(entry.offset), MAX32) : entry.offset
  const extra = wide.length > 0 ? Buffer.alloc(4 + wide.length * 8) : Buffer.alloc(0)
  if (wide.length > 0) {
    extra.writeUInt16LE(ZIP64_EXTRA, 0)
    extra.writeUInt16LE(wide.length * 8, 2)
    wide.forEach((value, i) => writeUInt64(extra, value, 4 + i * 8))
  }
  const version = entry.zip64 || wide.length > 0 ? 45 : 20
  const header = Buffer.alloc(46 + entry.name.length + extra.length)
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  header.writeUInt16LE(45, 4)
  header.writeUInt16LE(version, 6)
  header.writeUInt16LE(UTF8_FLAG, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc >>> 0, 16)
  header.writeUInt32LE(compressed, 20)
  header.writeUInt32LE(size, 24)
  header.writeUInt16LE(entry.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt32LE(offset, 42)
  entry.name.copy(header, 46)
  extra.copy(header, 46 + entry.name.length)
  return header
}

async function readAt(handle: FileHandle, at: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, at + done)
    if (bytesRead === 0) throw new ZipError('The zip ends early')
    done += bytesRead
  }
  return buffer
}

/** The entries of a zip, from its central directory, and their contents on demand. */
export class ZipReader {
  private constructor(
    private readonly file: string,
    private readonly handle: FileHandle,
    readonly entries: ZipEntry[],
  ) {}

  static async open(file: string): Promise<ZipReader> {
    const handle = await open(file, 'r')
    try {
      const entries = await readDirectory(handle)
      return new ZipReader(file, handle, entries)
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name)
  }

  /** The entry's bytes, inflated; checked against its CRC and size as they pass. */
  async stream(entry: ZipEntry): Promise<Readable> {
    const local = await readAt(this.handle, entry.offset, 30)
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError(`${entry.name} has no local header where the directory says`)
    }
    const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    const raw =
      entry.compressedSize === 0
        ? Readable.from([])
        : createReadStream(this.file, { start, end: start + entry.compressedSize - 1 })
    let crc = 0
    let size = 0
    const check = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        crc = crc32(chunk, crc)
        size += chunk.length
        if (size > entry.size) done(new ZipError(`${entry.name} holds more than it says`))
        else done(null, chunk)
      },
      flush(done) {
        if (size !== entry.size || crc >>> 0 !== entry.crc >>> 0) {
          done(new ZipError(`${entry.name} does not match its checksum`))
        } else done()
      },
    })
    const out = new PassThrough()
    const running =
      entry.method === STORED
        ? pipeline(raw, check, out)
        : pipeline(raw, createInflateRaw(), check, out)
    // The pipeline destroys every stage with its error, `out` too, which the reader then sees.
    running.catch(() => {})
    return out
  }

  /** The entry's whole content, refused past `max` bytes. */
  async read(entry: ZipEntry, max: number): Promise<Buffer> {
    if (entry.size > max) throw new ZipError(`${entry.name} is larger than ${max} bytes`)
    const chunks: Buffer[] = []
    for await (const chunk of await this.stream(entry)) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  close(): Promise<void> {
    return this.handle.close()
  }
}

async function readDirectory(handle: FileHandle): Promise<ZipEntry[]> {
  const { size: fileSize } = await handle.stat()
  if (fileSize < END_SIZE) throw new ZipError('Not a zip file')
  const tailLength = Math.min(fileSize, END_SIZE + MAX_COMMENT)
  const tailStart = fileSize - tailLength
  const tail = await readAt(handle, tailStart, tailLength)
  let endAt = -1
  for (let i = tail.length - END_SIZE; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === END_SIGNATURE &&
      i + END_SIZE + tail.readUInt16LE(i + 20) <= tail.length
    ) {
      endAt = i
      break
    }
  }
  if (endAt < 0) throw new ZipError('Not a zip file')
  let count = tail.readUInt16LE(endAt + 10)
  let directorySize = tail.readUInt32LE(endAt + 12)
  let directoryStart = tail.readUInt32LE(endAt + 16)
  if (count === MAX16 || directorySize === MAX32 || directoryStart === MAX32) {
    const locatorAt = tailStart + endAt - LOCATOR_SIZE
    if (locatorAt < 0) throw new ZipError('The zip64 end record is missing')
    const locator = await readAt(handle, locatorAt, LOCATOR_SIZE)
    if (locator.readUInt32LE(0) !== LOCATOR_SIGNATURE) {
      throw new ZipError('The zip64 end record is missing')
    }
    const record = await readAt(handle, readUInt64(locator, 8), END64_SIZE)
    if (record.readUInt32LE(0) !== END64_SIGNATURE) throw new ZipError('The zip64 end is damaged')
    count = readUInt64(record, 32)
    directorySize = readUInt64(record, 40)
    directoryStart = readUInt64(record, 48)
  }
  if (directoryStart + directorySize > fileSize) throw new ZipError('The zip is cut short')
  const directory = await readAt(handle, directoryStart, directorySize)
  const entries: ZipEntry[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipError('The zip directory is damaged')
    }
    const flags = directory.readUInt16LE(at + 8)
    const method = directory.readUInt16LE(at + 10)
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > directory.length) throw new ZipError('The zip directory is damaged')
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength)
    if (flags & ENCRYPTED_FLAG) throw new ZipError(`${name} is encrypted`)
    if (method !== STORED && method !== DEFLATED) {
      throw new ZipError(`${name} uses a compression this app does not read`)
    }
    let size = directory.readUInt32LE(at + 24)
    let compressedSize = directory.readUInt32LE(at + 20)
    let offset = directory.readUInt32LE(at + 42)
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e)
      const length = extra.readUInt16LE(e + 2)
      if (id === ZIP64_EXTRA) {
        let f = e + 4
        const take = (): number => {
          if (f + 8 > e + 4 + length) throw new ZipError(`${name} has a damaged zip64 field`)
          const value = readUInt64(extra, f)
          f += 8
          return value
        }
        if (size === MAX32) size = take()
        if (compressedSize === MAX32) compressedSize = take()
        if (offset === MAX32) offset = take()
      }
      e += 4 + length
    }
    if (offset + 30 > fileSize || offset + compressedSize > fileSize) {
      throw new ZipError(`${name} lies past the end of the zip`)
    }
    entries.push({
      name,
      method: method as ZipMethod,
      crc: directory.readUInt32LE(at + 16),
      size,
      compressedSize,
      offset,
      modified: fromDos(directory.readUInt16LE(at + 12), directory.readUInt16LE(at + 14)),
    })
    at = next
  }
  return entries
}

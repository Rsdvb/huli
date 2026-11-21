// Huli: a download in parts, put back together only from parts that are the ones asked for.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DownloadError, downloadFile, type DownloadDeps } from './file-download'
import type { FileBytes, FileStamp } from './files'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A host holding `file`, answering each part after `delay(offset)` ms, as `files.readBytes`. */
function host(
  file: { bytes: Uint8Array; stamp: FileStamp },
  options: { delay?: (offset: number) => number; limit?: number } = {},
) {
  const asked: { offset: number; length: number; expect?: FileStamp }[] = []
  const read: DownloadDeps['read'] = async (part, signal) => {
    asked.push(part)
    await new Promise((resolve) => setTimeout(resolve, options.delay?.(part.offset) ?? 0))
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    const { bytes, stamp } = file
    if (options.limit !== undefined && stamp.size > options.limit) {
      return { kind: 'too-large', name: 'a.pdf', size: stamp.size, limit: options.limit }
    }
    const expected = part.expect
    if (expected && (expected.size !== stamp.size || expected.mtimeMs !== stamp.mtimeMs)) {
      return { kind: 'changed', name: 'a.pdf', ...stamp }
    }
    const slice = bytes.slice(part.offset, part.offset + part.length)
    return {
      kind: 'part',
      name: 'a.pdf',
      ...stamp,
      offset: part.offset,
      sha256: sha(slice),
      bytes: slice.buffer,
    }
  }
  return { read, asked }
}

function sink() {
  const chunks: Uint8Array[] = []
  return {
    chunks,
    whole: () => Buffer.concat(chunks),
    write: async (bytes: Uint8Array) => void chunks.push(bytes),
    restart: async () => void chunks.splice(0),
    sha256: async (bytes: Uint8Array) => sha(bytes),
  }
}

const fileOf = (size: number, mtimeMs = 1) => ({
  bytes: Uint8Array.from({ length: size }, (_, i) => (i * 7) % 256),
  stamp: { size, mtimeMs },
})

describe('downloadFile', () => {
  it('writes the parts in order even when later ones come first', async () => {
    const file = fileOf(1000)
    // The parts asked for ahead answer in reverse, the last first.
    const { read } = host(file, { delay: (offset) => 30 - offset / 50 })
    const out = sink()
    const done = await downloadFile({ ...out, read, partBytes: 128, ahead: 4 })
    expect(done).toEqual({ kind: 'done', name: 'a.pdf', size: 1000, mtimeMs: 1 })
    expect(out.whole().equals(Buffer.from(file.bytes))).toBe(true)
  })

  it('downloads an empty file, and says when the file is too large to download', async () => {
    const out = sink()
    expect(await downloadFile({ ...out, read: host(fileOf(0)).read })).toMatchObject({
      kind: 'done',
      size: 0,
    })
    const big = host(fileOf(10), { limit: 5 })
    expect(await downloadFile({ ...out, read: big.read })).toEqual({
      kind: 'too-large',
      name: 'a.pdf',
      size: 10,
      limit: 5,
    })
    expect(big.asked).toHaveLength(1)
  })

  it('asks every part after the first for the file as the first found it', async () => {
    const file = fileOf(500, 42)
    const { read, asked } = host(file)
    await downloadFile({ ...sink(), read, partBytes: 100 })
    expect(asked[0]).toEqual({ offset: 0, length: 100 })
    expect(asked.slice(1).every((part) => part.expect?.mtimeMs === 42)).toBe(true)
    expect(asked.map((part) => part.offset)).toEqual([0, 100, 200, 300, 400])
  })

  it('starts over when the file changes, and fails when it keeps changing', async () => {
    const file = fileOf(400, 1)
    const { read } = host(file)
    const out = sink()
    let changes = 1
    const changing: DownloadDeps['read'] = async (part, signal) => {
      const answer = await read(part, signal)
      // The file is rewritten once, after its first part was read.
      if (part.offset === 0 && changes-- > 0) {
        file.bytes = Uint8Array.from({ length: 400 }, (_, i) => 255 - (i % 256))
        file.stamp = { size: 400, mtimeMs: 2 }
      }
      return answer
    }
    const done = await downloadFile({ ...out, read: changing, partBytes: 100 })
    expect(done).toMatchObject({ kind: 'done', mtimeMs: 2 })
    expect(out.whole().equals(Buffer.from(file.bytes))).toBe(true)

    let time = 10
    const always: DownloadDeps['read'] = async (part, signal) => {
      const answer = await read(part, signal)
      file.stamp = { size: 400, mtimeMs: time++ }
      return answer
    }
    await expect(downloadFile({ ...sink(), read: always, partBytes: 100 })).rejects.toMatchObject({
      name: 'DownloadError',
      code: 'changed',
    })
  })

  it('refuses a part that does not match its hash, its offset or its length', async () => {
    const file = fileOf(300)
    const { read } = host(file)
    const tamper = (change: (answer: Extract<FileBytes, { kind: 'part' }>) => FileBytes) =>
      (async (part, signal) => {
        const answer = await read(part, signal)
        return answer.kind === 'part' && part.offset === 100 ? change(answer) : answer
      }) satisfies DownloadDeps['read']
    const flipped = tamper((answer) => {
      const bytes = new Uint8Array(answer.bytes.slice(0))
      bytes[3] = bytes[3]! ^ 1
      return { ...answer, bytes: bytes.buffer }
    })
    const moved = tamper((answer) => ({ ...answer, offset: 200 }))
    const short = tamper((answer) => {
      const bytes = new Uint8Array(answer.bytes).slice(0, 50)
      return { ...answer, bytes: bytes.buffer, sha256: sha(bytes) }
    })
    for (const bad of [flipped, moved, short]) {
      const out = sink()
      const failed = downloadFile({ ...out, read: bad, partBytes: 100 })
      await expect(failed).rejects.toBeInstanceOf(DownloadError)
      await expect(failed).rejects.toMatchObject({ code: 'corrupt' })
      // Nothing past the bad part was written.
      expect(out.whole().length).toBe(100)
    }
  })

  it('stops when given up, leaving no part in flight', async () => {
    const file = fileOf(1000)
    const { read } = host(file, { delay: () => 5 })
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const out = sink()
    const failed = downloadFile({
      ...out,
      read: (part, signal) => {
        signals.push(signal)
        return read(part, signal)
      },
      partBytes: 100,
      signal: controller.signal,
      progress: (written) => {
        if (written >= 300) controller.abort()
      },
    })
    await expect(failed).rejects.toMatchObject({ name: 'AbortError' })
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(out.whole().length).toBeLessThan(1000)
  })
})

// A device's uploads on the remote host: the limits they are held to, the room the disk must have,
// handing an attachment's file over unread, and every file going with a cancel or a connection.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortError } from '@shared/port-rpc'
import { UPLOAD_FILE_NAME } from '@shared/remote/streams'

const reads = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: (file: string, ...rest: unknown[]) => {
      reads.files.push(String(file))
      return (fs.readFile as (...args: unknown[]) => Promise<Buffer>)(file, ...rest)
    },
  }
})

const { UploadCounts, Uploads, UploadError } = await import('./uploads')

let folder = ''

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'kettu-uploads-'))
  reads.files.length = 0
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function uploads(options: { free?: number | null; memoryBytes?: number; maxBytes?: number } = {}) {
  const cancelled: { stream: number; error: PortError }[] = []
  const counts = new UploadCounts()
  const made = new Uploads({
    folder,
    deviceId: 'phone',
    counts,
    transport: { pause: () => {}, resume: () => {} },
    cancelled: (stream, error) => cancelled.push({ stream, error }),
    freeSpace: async () => (options.free === undefined ? 10 * 1024 ** 3 : options.free),
    freeMargin: 1000,
    ...(options.memoryBytes ? { memoryBytes: options.memoryBytes } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  })
  return { uploads: made, counts, cancelled }
}

/** Sends `data` on a new upload `stream`, in parts, and ends it. */
function send(target: InstanceType<typeof Uploads>, stream: number, data: Uint8Array): void {
  expect(target.open(stream, data.length)).toBe(true)
  for (let at = 0; at < data.length; at += 1000) target.bytes(stream, data.subarray(at, at + 1000))
  target.end(stream)
}

const files = () => readdir(folder)
const bytes = (size: number) => new Uint8Array(size).map((_, i) => i % 251)

describe('uploads', () => {
  it('takes up to its largest and refuses one past it', () => {
    const { uploads: u, cancelled } = uploads({ maxBytes: 5000 })
    expect(u.open(1, 5000)).toBe(true)
    expect(u.open(3, 5001)).toBe(true)
    expect(cancelled).toEqual([
      {
        stream: 3,
        error: {
          code: 'invalid_params',
          message: 'An upload is at most 5000 bytes',
          log: 'An upload is at most 5000 bytes',
        },
      },
    ])
    u.closeAll()
  })

  it('refuses an upload the disk has no room for, past what other uploads still bring', async () => {
    const { uploads: u, cancelled, counts } = uploads({ free: 10_000 })
    u.open(1, 4000)
    expect(counts.promised).toBe(4000)
    // 10 000 free less 4000 coming leaves no room for 6000 more and the margin.
    u.open(3, 6000)
    await vi.waitFor(() => expect(cancelled.map((c) => c.stream)).toEqual([3]))
    expect(cancelled[0]!.error.code).toBe('unavailable')
    expect(cancelled[0]!.error.message).toContain('free disk space')
    expect(counts.promised).toBe(4000)
    u.closeAll()
    expect(counts.promised).toBe(0)
  })

  it('hands an attachment its file unread, and deletes what the agent host left of it', async () => {
    const { uploads: u, counts } = uploads()
    const data = bytes(4500)
    send(u, 1, data)
    const name = await u.claimFile(1)
    expect(name).toMatch(UPLOAD_FILE_NAME)
    expect(await files()).toEqual([name])
    expect(reads.files).toEqual([])
    // No longer the connection's: it counts as no upload, and a cancel cannot take it.
    expect(counts.of('phone')).toBe(0)
    u.cancel(1)
    expect(await files()).toEqual([name])
    u.settled([name])
    await vi.waitFor(async () => expect(await files()).toEqual([]))
  })

  it('reads an upload only within the memory bound', async () => {
    const { uploads: u } = uploads({ memoryBytes: 3000 })
    send(u, 1, bytes(2000))
    expect(new Uint8Array(await u.claim(1))).toEqual(bytes(2000))
    send(u, 3, bytes(3001))
    const refused = u.claim(3)
    await expect(refused).rejects.toBeInstanceOf(UploadError)
    await expect(refused).rejects.toMatchObject({ error: { code: 'invalid_params' } })
    expect(reads.files).toHaveLength(1)
    await vi.waitFor(async () => expect(await files()).toEqual([]))
  })

  it('deletes the file of an upload the device cancels', async () => {
    const { uploads: u } = uploads()
    u.open(1, 5000)
    u.bytes(1, bytes(1000))
    await vi.waitFor(async () => expect(await files()).toHaveLength(1))
    u.cancel(1)
    await vi.waitFor(async () => expect(await files()).toEqual([]))
  })

  it('keeps finished uploads through a drop and loses the unfinished', async () => {
    const { uploads: u } = uploads()
    send(u, 1, bytes(1000))
    u.open(3, 5000)
    u.bytes(3, bytes(1000))
    await vi.waitFor(async () => expect(await files()).toHaveLength(2))
    u.dropUnfinished()
    await vi.waitFor(async () => expect(await files()).toHaveLength(1))
    expect(await u.claimFile(1)).toMatch(UPLOAD_FILE_NAME)
    await expect(u.claimFile(3)).rejects.toMatchObject({ error: { code: 'invalid_params' } })
    u.closeAll()
  })

  it('deletes every file once the connection ends, handed over or not', async () => {
    const { uploads: u } = uploads()
    send(u, 1, bytes(1000))
    await u.claimFile(1)
    send(u, 3, bytes(1000))
    u.open(5, 5000)
    await vi.waitFor(async () => expect(await files()).toHaveLength(3))
    u.closeAll()
    await vi.waitFor(async () => expect(await files()).toEqual([]))
  })

  it('settles only files it handed over', async () => {
    const { uploads: u } = uploads()
    const other = path.join(folder, `${'a'.repeat(32)}.part`)
    await writeFile(other, 'not this one')
    u.settled([path.basename(other), '../outside.part'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await files()).toEqual([path.basename(other)])
  })
})

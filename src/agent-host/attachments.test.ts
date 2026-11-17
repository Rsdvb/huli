// A device's uploads as the agent host takes them: only a plain file of the remote host's upload
// folder, by its name; a large one moved in and linked unread, a small one added as bytes are.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_BYTES } from '@shared/attachments'
import { UPLOADS_FOLDER } from '@shared/remote/streams'

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

const { Attachments, sendAttachment } = await import('./attachments')

let dir = ''
let uploads = ''
let store: InstanceType<typeof Attachments>
let next = 0

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-attachments-'))
  uploads = path.join(dir, ...UPLOADS_FOLDER)
  await mkdir(uploads, { recursive: true })
  store = new Attachments({ userDataPath: dir, log: () => {} })
  await store.load()
  reads.files.length = 0
})

afterEach(async () => {
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

/** Puts `data` in the upload folder as the remote host names an upload's file. */
async function uploaded(data: Uint8Array): Promise<string> {
  const name = `${(next++).toString(16).padStart(32, '0')}.part`
  await writeFile(path.join(uploads, name), data)
  return name
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

describe('a device upload', () => {
  it('past the memory bound is moved in and linked, never read whole', async () => {
    const data = new Uint8Array(ATTACHMENT_BYTES + 1).fill(7)
    const upload = await uploaded(data)
    const attachment = await store.addUpload(
      { upload, mimeType: 'video/mp4', name: 'clip.mp4' },
      null,
    )
    expect(attachment).toMatchObject({ type: 'file', mimeType: 'video/mp4', size: data.length })
    expect(await readdir(uploads)).toEqual([])
    const saved = `${sha256(data)}.mp4`
    expect((await readdir(path.join(dir, 'attachments'))).sort()).toEqual([saved])

    const record = store.get(attachment.id)
    const sent = await sendAttachment(store, record, {
      image: true,
      embeddedContext: true,
    } as never)
    expect(sent.block).toMatchObject({ type: 'resource_link', name: 'clip.mp4', size: data.length })
    const copy = fileURLToPath((sent.block as { uri: string }).uri)
    expect(path.dirname(copy)).toBe(path.join(dir, 'attachments', 'sent'))
    expect((await stat(copy)).size).toBe(data.length)
    await expect(store.read(attachment.id)).rejects.toMatchObject({ code: 'invalid_params' })
    expect(reads.files).toEqual([])
  })

  it('within the memory bound is read once and added as bytes are', async () => {
    const upload = await uploaded(new TextEncoder().encode('# Notes\nline two\n'))
    const attachment = await store.addUpload(
      { upload, mimeType: 'text/x-markdown', name: 'notes.md' },
      null,
    )
    expect(attachment).toMatchObject({ type: 'text', mimeType: 'text/markdown', size: 17 })
    expect(reads.files).toHaveLength(1)
    expect(await readdir(uploads)).toEqual([])
    // Only the saved text stays; the file taken from the upload folder went.
    expect(await readdir(path.join(dir, 'attachments'))).toHaveLength(1)
  })

  it('is only a plain file of the upload folder, by a name the remote host gives', async () => {
    const outside = path.join(dir, 'secret.txt')
    await writeFile(outside, 'keep out')
    const add = (upload: string) =>
      store.addUpload({ upload, mimeType: 'text/plain', name: 'x' }, null)
    await expect(add('../secret.txt')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(add(outside)).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(add(`${'f'.repeat(32)}.part`)).rejects.toMatchObject({ code: 'not_found' })
    const folder = `${'e'.repeat(32)}.part`
    await mkdir(path.join(uploads, folder))
    await expect(add(folder)).rejects.toMatchObject({ code: 'invalid_params' })
    const linked = `${'d'.repeat(32)}.part`
    const made = await symlink(outside, path.join(uploads, linked)).then(
      () => true,
      () => false, // Windows without the right to make links.
    )
    if (made) await expect(add(linked)).rejects.toMatchObject({ code: 'invalid_params' })
    const empty = await uploaded(new Uint8Array(0))
    await expect(add(empty)).rejects.toMatchObject({ code: 'invalid_params' })
    expect(reads.files).toEqual([])
  })
})

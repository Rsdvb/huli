import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadFile } from '@shared/file-download'
import { copyName, FilesService } from './files'
import { createExec, type Exec } from './git/exec'
import { FILE_LINKS, linkFolder } from './testing/links'
import { tempFolder } from './testing/temp'

const noGit: Exec = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  failure: 'not-found',
  message: 'git is not installed',
})

async function setup(exec: Exec = noGit) {
  const base = await realpath(await tempFolder('kettu-files-'))
  const root = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const trashed: string[][] = []
  const files = new FilesService({
    exec,
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    media: async () => null,
    describeMedia: async () => null,
    trash: async (paths) => {
      trashed.push(paths)
    },
  })
  return { root, outside, files, trashed }
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

const rejectsWith = (run: Promise<unknown>, code: string) =>
  expect(run).rejects.toMatchObject({ code })

describe('copyName', () => {
  it('puts the copy before the extension, and not in a dot file or a folder', () => {
    expect(copyName('a.ts', 1, false)).toBe('a copy.ts')
    expect(copyName('a.test.ts', 2, false)).toBe('a.test copy 2.ts')
    expect(copyName('.env', 1, false)).toBe('.env copy')
    expect(copyName('v1.2', 1, true)).toBe('v1.2 copy')
  })
})

describe('FilesService file operations', () => {
  it('creates a file or folder with the folders above it, and never replaces one', async () => {
    const { root, files } = await setup()
    await files.create(root, 'a/b/c.ts', 'file')
    expect(await readFile(path.join(root, 'a/b/c.ts'), 'utf8')).toBe('')
    await files.create(root, 'a/d', 'folder')
    expect((await lstat(path.join(root, 'a/d'))).isDirectory()).toBe(true)
    await writeFile(path.join(root, 'a/b/c.ts'), 'kept')
    await rejectsWith(files.create(root, 'a/b/c.ts', 'file'), 'conflict')
    await rejectsWith(files.create(root, 'a/d', 'folder'), 'conflict')
    expect(await readFile(path.join(root, 'a/b/c.ts'), 'utf8')).toBe('kept')
  })

  it('refuses paths out of the project, the project itself and .git', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, '.git'))
    await linkFolder(outside, path.join(root, 'away'))
    for (const bad of ['../x', '/x', 'a/../../x', '', '.', '.git/config', 'a/.git']) {
      await rejectsWith(files.create(root, bad, 'file'), 'invalid_params')
    }
    await rejectsWith(files.create(root, 'away/x', 'file'), 'invalid_params')
    await rejectsWith(files.create(root, 'away/deeper/x', 'folder'), 'invalid_params')
    expect(await exists(path.join(outside, 'x'))).toBe(false)
    expect(await exists(path.join(outside, 'deeper'))).toBe(false)
  })

  it('renames and moves without replacing what is there', async () => {
    const { root, files } = await setup()
    await writeFile(path.join(root, 'a.ts'), 'a')
    await writeFile(path.join(root, 'b.ts'), 'b')
    await rejectsWith(files.rename(root, 'a.ts', 'b.ts'), 'conflict')
    expect(await readFile(path.join(root, 'b.ts'), 'utf8')).toBe('b')
    await files.rename(root, 'a.ts', 'src/lib/a2.ts')
    expect(await readFile(path.join(root, 'src/lib/a2.ts'), 'utf8')).toBe('a')
    expect(await exists(path.join(root, 'a.ts'))).toBe(false)
    await files.rename(root, 'b.ts', 'B.ts')
    expect(await readFile(path.join(root, 'B.ts'), 'utf8')).toBe('b')
    await rejectsWith(files.rename(root, 'missing.ts', 'm.ts'), 'not_found')
  })

  it('never moves a folder into itself, out of the project or into .git', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, 'src/inner'), { recursive: true })
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, 'f.ts'), 'f')
    await linkFolder(outside, path.join(root, 'away'))
    await rejectsWith(files.rename(root, 'src', 'src/inner/src'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', 'away/f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', '../f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, 'f.ts', '.git/f.ts'), 'invalid_params')
    await rejectsWith(files.rename(root, '.git', 'git'), 'invalid_params')
    expect(await exists(path.join(outside, 'f.ts'))).toBe(false)
    expect(await exists(path.join(root, 'f.ts'))).toBe(true)
  })

  it.skipIf(!FILE_LINKS)('moves a link itself, never what it points to', async () => {
    const { root, outside, files } = await setup()
    await writeFile(path.join(outside, 'secret'), 's')
    await symlink(path.join(outside, 'secret'), path.join(root, 'link'))
    await files.rename(root, 'link', 'moved')
    expect(await readlink(path.join(root, 'moved'))).toBe(path.join(outside, 'secret'))
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('s')
  })

  it('copies under a free name, links as links, and never a folder into itself', async () => {
    const { root, outside, files } = await setup()
    await mkdir(path.join(root, 'dir'))
    await writeFile(path.join(root, 'dir/a.ts'), 'a')
    await linkFolder(outside, path.join(root, 'dir/away'))
    expect(await files.copy(root, ['dir/a.ts'], 'dir')).toEqual(['dir/a copy.ts'])
    expect(await files.copy(root, ['dir/a.ts'], 'dir')).toEqual(['dir/a copy 2.ts'])
    expect(await files.copy(root, ['dir/a.ts', 'dir'], '')).toEqual(['a.ts', 'dir copy'])
    expect(await readFile(path.join(root, 'dir copy/a.ts'), 'utf8')).toBe('a')
    expect((await lstat(path.join(root, 'dir copy/away'))).isSymbolicLink()).toBe(true)
    await rejectsWith(files.copy(root, ['dir'], 'dir'), 'invalid_params')
    await rejectsWith(files.copy(root, ['dir/a.ts'], 'dir/away'), 'invalid_params')
    await rejectsWith(files.copy(root, ['dir/a.ts'], '..'), 'invalid_params')
  })

  it.skipIf(!FILE_LINKS)(
    'trashes absolute paths, deletes for good only when asked, and skips what is gone',
    async () => {
      const { root, outside, files, trashed } = await setup()
      await mkdir(path.join(root, 'dir'))
      await writeFile(path.join(root, 'dir/a.ts'), 'a')
      await writeFile(path.join(outside, 'kept'), 'k')
      await symlink(path.join(outside, 'kept'), path.join(root, 'link'))
      await files.delete(root, ['dir/a.ts', 'gone.ts', 'nowhere/gone.ts'], false)
      expect(trashed).toEqual([[path.join(root, 'dir', 'a.ts')]])
      expect(await exists(path.join(root, 'dir/a.ts'))).toBe(true)
      await files.delete(root, ['dir', 'link'], true)
      expect(await exists(path.join(root, 'dir'))).toBe(false)
      expect(await exists(path.join(root, 'link'))).toBe(false)
      expect(await readFile(path.join(outside, 'kept'), 'utf8')).toBe('k')
      await mkdir(path.join(root, '.git'))
      await rejectsWith(files.delete(root, ['.git'], true), 'invalid_params')
      await rejectsWith(files.delete(root, ['..'], true), 'invalid_params')
      await rejectsWith(files.delete(root, ['link/../..'], true), 'invalid_params')
      expect(await exists(path.join(root, '.git'))).toBe(true)
    },
  )
})

// Huli: a file's bytes, which a phone downloads a part at a time to preview a document.
describe('FilesService.readBytes', () => {
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

  async function setupBytes(limit = 1024 * 1024) {
    const base = await realpath(await tempFolder('kettu-bytes-'))
    const root = path.join(base, 'project')
    const outside = path.join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    const files = new FilesService({
      exec: noGit,
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      media: async () => null,
      describeMedia: async () => null,
      trash: async () => {},
      limits: { bytes: limit },
    })
    return { root, outside, files }
  }

  it('reads a part with its stamp and hash, and the stamp alone for no bytes', async () => {
    const { root, files } = await setupBytes()
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
    await mkdir(path.join(root, 'out'))
    await writeFile(path.join(root, 'out/report.pdf'), data)
    const part = await files.readBytes(root, 'out/report.pdf', { offset: 100, length: 300 })
    expect(part).toMatchObject({ kind: 'part', name: 'report.pdf', size: 1000, offset: 100 })
    if (part.kind !== 'part') throw new Error('no part')
    const bytes = new Uint8Array(part.bytes)
    expect(Buffer.from(bytes).equals(data.subarray(100, 400))).toBe(true)
    expect(part.sha256).toBe(sha(bytes))
    // The end of the file cuts the last part short; a part of none reads only the stamp.
    const tail = await files.readBytes(root, 'out/report.pdf', { offset: 900, length: 300 })
    expect(tail.kind === 'part' && tail.bytes.byteLength).toBe(100)
    const stamp = await files.readBytes(root, 'out/report.pdf', { offset: 0, length: 0 })
    expect(stamp).toMatchObject({ kind: 'part', size: 1000, sha256: sha(new Uint8Array()) })
    expect(stamp.kind === 'part' && stamp.bytes.byteLength).toBe(0)
    await rejectsWith(
      files.readBytes(root, 'out/report.pdf', { offset: 1001, length: 1 }),
      'invalid_params',
    )
  })

  it('reads nothing of a file larger than the limit', async () => {
    const { root, files } = await setupBytes(64)
    await writeFile(path.join(root, 'big.docx'), Buffer.alloc(65))
    await writeFile(path.join(root, 'fits.docx'), Buffer.alloc(64))
    expect(await files.readBytes(root, 'big.docx', { offset: 0, length: 10 })).toEqual({
      kind: 'too-large',
      name: 'big.docx',
      size: 65,
      limit: 64,
    })
    expect(await files.readBytes(root, 'fits.docx', { offset: 0, length: 10 })).toMatchObject({
      kind: 'part',
    })
  })

  it('says a file changed since the stamp it was expected to have', async () => {
    const { root, files } = await setupBytes()
    const file = path.join(root, 'a.pdf')
    await writeFile(file, 'first')
    const first = await files.readBytes(root, 'a.pdf', { offset: 0, length: 2 })
    if (first.kind !== 'part') throw new Error('no part')
    const stamp = { size: first.size, mtimeMs: first.mtimeMs }
    expect(
      await files.readBytes(root, 'a.pdf', { offset: 2, length: 2, expect: stamp }),
    ).toMatchObject({ kind: 'part', offset: 2 })
    await writeFile(file, 'second, longer')
    expect(
      await files.readBytes(root, 'a.pdf', { offset: 2, length: 2, expect: stamp }),
    ).toMatchObject({ kind: 'changed', size: 14 })
  })

  it('refuses a path out of the project, as reading its text does', async () => {
    const { root, outside, files } = await setupBytes()
    await writeFile(path.join(outside, 'secret.pdf'), 'secret')
    await mkdir(path.join(root, 'dir'))
    await linkFolder(outside, path.join(root, 'away'))
    const part = { offset: 0, length: 10 }
    for (const bad of ['../outside/secret.pdf', '/etc/hosts', 'a/../../outside/secret.pdf', '']) {
      await rejectsWith(files.readBytes(root, bad, part), 'invalid_params')
    }
    await rejectsWith(files.readBytes(root, 'away/secret.pdf', part), 'invalid_params')
    await rejectsWith(files.readBytes(root, 'dir', part), 'invalid_params')
    await rejectsWith(files.readBytes(root, 'missing.pdf', part), 'not_found')
  })

  it.skipIf(!FILE_LINKS)('refuses a link to a file out of the project', async () => {
    const { root, outside, files } = await setupBytes()
    await writeFile(path.join(outside, 'secret.pdf'), 'secret')
    await symlink(path.join(outside, 'secret.pdf'), path.join(root, 'leak.pdf'))
    await rejectsWith(
      files.readBytes(root, 'leak.pdf', { offset: 0, length: 10 }),
      'invalid_params',
    )
  })

  it('downloads a file whole through its parts, each checked against its hash', async () => {
    const { root, files } = await setupBytes()
    const data = createHash('sha512').update('seed').digest()
    const whole = Buffer.concat(Array.from({ length: 40 }, () => data))
    await writeFile(path.join(root, 'deck.pptx'), whole)
    const written: Uint8Array[] = []
    const progress: number[] = []
    const done = await downloadFile({
      read: (part) => files.readBytes(root, 'deck.pptx', part),
      sha256: async (bytes) => sha(bytes),
      write: async (bytes) => void written.push(bytes),
      restart: async () => void written.splice(0),
      progress: (count) => void progress.push(count),
      partBytes: 300,
    })
    expect(done).toMatchObject({ kind: 'done', name: 'deck.pptx', size: whole.length })
    expect(Buffer.concat(written).equals(whole)).toBe(true)
    expect(progress.at(-1)).toBe(whole.length)
    expect(progress.length).toBe(Math.ceil(whole.length / 300))
  })
})

// Runs git, which takes seconds to start on a busy Windows machine.
describe('FilesService empty folders', { timeout: 30_000 }, () => {
  it('lists the empty folders of a folder outside git', async () => {
    const { root, files } = await setup()
    await mkdir(path.join(root, 'a/empty'), { recursive: true })
    await mkdir(path.join(root, 'b'))
    await writeFile(path.join(root, 'b/file.ts'), '')
    expect(await files.list(root)).toEqual({
      paths: ['b/file.ts'],
      folders: ['a/empty'],
      truncated: false,
    })
  })

  it('lists empty untracked folders of a repository, not ones holding ignored files', async () => {
    const exec = createExec(() => process.env).exec
    const { root, files } = await setup(exec)
    const git = (...args: string[]) => exec('git', args, { cwd: root, timeoutMs: 10_000 })
    expect((await git('init', '-q')).code).toBe(0)
    await writeFile(path.join(root, '.gitignore'), '*.log\ntmp/\n')
    await mkdir(path.join(root, 'src/new'), { recursive: true })
    await mkdir(path.join(root, 'src/tmp'), { recursive: true })
    await writeFile(path.join(root, 'src/main.ts'), '')
    await mkdir(path.join(root, 'logs'))
    await writeFile(path.join(root, 'logs/a.log'), '')
    await mkdir(path.join(root, 'outer/inner'), { recursive: true })
    expect(await files.list(root)).toEqual({
      paths: ['.gitignore', 'src/main.ts'],
      folders: ['outer/inner', 'src/new'],
      truncated: false,
    })
  })

  it('lists a folder emptied of its tracked files', async () => {
    const exec = createExec(() => process.env).exec
    const { root, files } = await setup(exec)
    const git = (...args: string[]) => exec('git', args, { cwd: root, timeoutMs: 10_000 })
    await git('init', '-q')
    await mkdir(path.join(root, 'docs/deep'), { recursive: true })
    await writeFile(path.join(root, 'docs/deep/a.md'), '')
    await writeFile(path.join(root, 'kept.md'), '')
    await git('add', '-A')
    await rm(path.join(root, 'docs/deep/a.md'))
    expect(await files.list(root)).toEqual({
      paths: ['kept.md'],
      folders: ['docs/deep'],
      truncated: false,
    })
  })
})

import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import index from './fixtures/index.json'
import {
  binDirOf,
  installNode,
  listNodeInstalls,
  nodeProgram,
  pickSource,
  pruneNodeInstalls,
  RECORD_FILE,
  removeNodeInstalls,
  type InstallProgress,
  type NodeInstallOptions,
} from './install'
import { archiveFile, archiveFolder, nodeAsset, type NodeAsset } from './release'
import type { Transport } from './transport'

const platform = process.platform as Platform
const asset: NodeAsset = nodeAsset(platform, platform === 'darwin' ? 'arm64' : 'x64')!
const VERSION = 'v26.14.0'
const FILE = archiveFile(VERSION, asset)
const ARCHIVE = Buffer.from('the official archive')
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

type Served = string | Buffer | Error | { delayMs: number; body: string | Buffer | Error }

/** Serves fixed answers by URL, and remembers what was asked. */
function transport(served: Record<string, Served>): Transport & { asked: string[] } {
  const asked: string[] = []
  const answer = async (url: string, signal: AbortSignal): Promise<string | Buffer> => {
    asked.push(url)
    let value = served[url]
    if (value === undefined) throw new Error(`HTTP 404 for ${url}`)
    if (typeof value === 'object' && 'delayMs' in value) {
      const { delayMs, body } = value
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
      value = body
    }
    if (value instanceof Error) throw value
    return value
  }
  return {
    asked,
    async text(url, { signal }) {
      return (await answer(url, signal)).toString()
    },
    async file(url, file, { signal, onBytes }) {
      const body = Buffer.from(await answer(url, signal))
      onBytes?.(body.length / 2, body.length)
      onBytes?.(body.length, body.length)
      await writeFile(file, body)
      return { sha256: sha(body), bytes: body.length }
    },
  }
}

const official = 'https://nodejs.org/dist/'
const mirror = 'https://npmmirror.com/mirrors/node/'
const indexText = JSON.stringify(index)
const sums = (hash: string) => `${'0'.repeat(64)}  other.zip\n${hash}  ${FILE}\n`

function servedBy(base: string, overrides: Record<string, Served> = {}): Record<string, Served> {
  return {
    [`${base}index.json`]: indexText,
    [`${base}${VERSION}/SHASUMS256.txt`]: sums(sha(ARCHIVE)),
    [`${base}${VERSION}/${FILE}`]: ARCHIVE,
    ...overrides,
  }
}

let root: string
let extracted: string[]

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kite-node-'))
  extracted = []
})

afterEach(async () => {
  // The trash a prune moved aside is still being deleted in the background, which Windows can
  // hold for a moment.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** What the system's tar would leave: the archive's one folder, with its node. */
async function fakeExtract(_archive: string, dest: string): Promise<void> {
  extracted.push(dest)
  const node = nodeProgram(path.join(dest, archiveFolder(VERSION, asset)), platform)
  await mkdir(path.dirname(node), { recursive: true })
  await writeFile(node, '')
  if (platform !== 'win32') await chmod(node, 0o755)
}

function options(t: Transport, extra: Partial<NodeInstallOptions> = {}): NodeInstallOptions {
  return {
    root,
    platform,
    asset,
    required: '>=24.9.0',
    transport: t,
    extract: fakeExtract,
    version: async () => VERSION,
    headStartMs: 1_000,
    ...extra,
  }
}

/** A finished install of `version`, as an earlier run left it. */
async function installed(version: string, installedAt = 1): Promise<void> {
  const dir = path.join(root, version)
  const node = nodeProgram(dir, platform)
  await mkdir(path.dirname(node), { recursive: true })
  await writeFile(node, '')
  if (platform !== 'win32') await chmod(node, 0o755)
  await writeFile(
    path.join(dir, RECORD_FILE),
    JSON.stringify({ version, source: 'nodejs.org', installedAt }),
  )
}

describe('installNode', () => {
  it('installs the newest LTS release from nodejs.org into its own folder', async () => {
    const t = transport(servedBy(official))
    const phases: InstallProgress['phase'][] = []
    const result = await installNode(
      options(t, { onProgress: (p) => void (phases.at(-1) !== p.phase && phases.push(p.phase)) }),
    )
    expect(result).toMatchObject({ installed: true, source: 'nodejs.org' })
    expect(result.install.dir).toBe(path.join(root, VERSION))
    expect(result.install.binDir).toBe(binDirOf(path.join(root, VERSION), platform))
    expect(phases).toEqual(['checking', 'downloading', 'verifying', 'extracting'])
    expect(await readdir(root)).toEqual([VERSION])
    expect(t.asked).not.toContain(`${mirror}index.json`)
  })

  it('refuses an archive whose SHA-256 is not the one SHASUMS256.txt gives, leaving nothing', async () => {
    const t = transport(servedBy(official, { [`${official}${VERSION}/${FILE}`]: Buffer.from('x') }))
    await expect(installNode(options(t))).rejects.toThrow(/SHA-256/)
    expect(extracted).toEqual([])
    expect(await readdir(root)).toEqual([])
    expect(await listNodeInstalls(root, platform)).toEqual([])
  })

  it('refuses an archive SHASUMS256.txt does not list', async () => {
    const t = transport(
      servedBy(official, { [`${official}${VERSION}/SHASUMS256.txt`]: `${'1'.repeat(64)}  x.zip` }),
    )
    await expect(installNode(options(t))).rejects.toThrow(/SHASUMS256/)
    expect(await readdir(root)).toEqual([])
  })

  it('takes the mirror when nodejs.org cannot be reached, and checks with the mirror’s sums', async () => {
    const down = new Error('getaddrinfo ENOTFOUND nodejs.org')
    const t = transport({
      [`${official}index.json`]: down,
      [`${official}${VERSION}/SHASUMS256.txt`]: down,
      ...servedBy(mirror),
    })
    const result = await installNode(options(t))
    expect(result).toMatchObject({ installed: true, source: 'npmmirror' })
    expect(t.asked).toContain(`${mirror}${VERSION}/${FILE}`)
  })

  it('checks the mirror’s archive with nodejs.org’s sums while nodejs.org answers them', async () => {
    const t = transport({
      ...servedBy(mirror, { [`${mirror}${VERSION}/SHASUMS256.txt`]: sums(sha(Buffer.from('x'))) }),
      [`${official}index.json`]: new Error('ECONNRESET'),
      [`${official}${VERSION}/SHASUMS256.txt`]: sums(sha(ARCHIVE)),
    })
    await expect(installNode(options(t))).resolves.toMatchObject({ source: 'npmmirror' })
  })

  it('downloads from the other source when the first download fails', async () => {
    const t = transport({
      ...servedBy(official, { [`${official}${VERSION}/${FILE}`]: new Error('ECONNRESET') }),
      [`${mirror}${VERSION}/${FILE}`]: ARCHIVE,
    })
    await expect(installNode(options(t))).resolves.toMatchObject({ source: 'npmmirror' })
  })

  it('leaves nothing when the extracted node does not run', async () => {
    const t = transport(servedBy(official))
    await expect(installNode(options(t, { version: async () => null }))).rejects.toThrow(
      /does not run/,
    )
    expect(await readdir(root)).toEqual([])
  })

  it('downloads nothing when the newest release is installed already', async () => {
    await installed(VERSION)
    const t = transport(servedBy(official))
    const result = await installNode(options(t))
    expect(result.installed).toBe(false)
    expect(t.asked).toEqual([`${official}index.json`])
  })

  it('keeps the newest two installs', async () => {
    await installed('v22.21.1')
    await installed('v24.22.3')
    await installed('v26.13.1')
    expect((await listNodeInstalls(root, platform)).map((i) => i.version)).toEqual([
      'v26.13.1',
      'v24.22.3',
      'v22.21.1',
    ])
    await installNode(options(transport(servedBy(official))))
    expect((await listNodeInstalls(root, platform)).map((i) => i.version)).toEqual([
      VERSION,
      'v26.13.1',
    ])
    expect(await pruneNodeInstalls(root, platform, 1)).toEqual(['v26.13.1'])
  })

  it('counts no folder without its record or its node as an install', async () => {
    await mkdir(path.join(root, 'v26.13.1'))
    await installed('v24.22.3')
    await rm(nodeProgram(path.join(root, 'v24.22.3'), platform))
    await mkdir(path.join(root, '..evil'))
    expect(await listNodeInstalls(root, platform)).toEqual([])
  })

  it('removes every install', async () => {
    await installed('v24.22.3')
    await installed('v26.13.1')
    await removeNodeInstalls(root, platform)
    expect(await listNodeInstalls(root, platform)).toEqual([])
  })
})

describe('pickSource', () => {
  it('waits for nodejs.org through its head start', async () => {
    const t = transport({
      [`${official}index.json`]: { delayMs: 40, body: indexText },
      [`${mirror}index.json`]: indexText,
    })
    const picked = await pickSource(t, new AbortController().signal, 1_000)
    expect(picked.source.id).toBe('nodejs.org')
    expect(t.asked).toEqual([`${official}index.json`])
  })

  it('races the mirror once nodejs.org is slow', async () => {
    const t = transport({
      [`${official}index.json`]: { delayMs: 2_000, body: indexText },
      [`${mirror}index.json`]: indexText,
    })
    const picked = await pickSource(t, new AbortController().signal, 20)
    expect(picked.source.id).toBe('npmmirror')
  })

  it('says why when neither answers', async () => {
    const t = transport({
      [`${official}index.json`]: new Error('ETIMEDOUT'),
      [`${mirror}index.json`]: new Error('ECONNREFUSED'),
    })
    await expect(pickSource(t, new AbortController().signal, 20)).rejects.toThrow(
      /ETIMEDOUT.*ECONNREFUSED/,
    )
  })
})

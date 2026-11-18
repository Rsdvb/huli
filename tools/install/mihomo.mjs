// @ts-check
// Fetches mihomo (MetaCubeX's Clash Meta core), which agents' network can go through, for one
// platform and architecture into resources/mihomo/, with its license for the notices file. mihomo
// is a separate program under GPL-3.0: Kite runs it as a child process of the agent host, like
// cua-driver, and talks to it only over its local ports; it is not linked into Kite, and its
// license ships in the notices. Every download is pinned to the release and checked against its
// SHA-256 before it is used, and nothing downloaded is run. The release run calls it before the
// build; in a checkout, `pnpm fetch:mihomo`. No dependencies beyond the system's tar for the
// Windows zip.
//
// Usage: node tools/install/mihomo.mjs [--platform darwin|win32|linux] [--arch arm64|x64]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'

const VERSION = '1.19.34'
const RELEASE = `https://github.com/MetaCubeX/mihomo/releases/download/v${VERSION}`
/** The commit the release's tag names, for its license file. */
const COMMIT = '0455d0d28c4526937380505153e65a843d8612e8'
const SOURCE = `https://raw.githubusercontent.com/MetaCubeX/mihomo/${COMMIT}`

// The plain amd64 builds target x86-64-v3, which needs AVX2 and so fails on older Intel CPUs;
// the -compatible builds target x86-64-v1 and run on any x86-64 CPU, so the x64 targets take them.
/**
 * A .gz asset is the program alone, gzipped; a .zip holds it as `member`.
 * @type {Record<string, { asset: string, sha256: string, member?: string }>}
 */
const PROGRAMS = {
  'darwin-arm64': {
    asset: `mihomo-darwin-arm64-v${VERSION}.gz`,
    sha256: '1a7a20eca63fbbaec90137717465bfde488d0db2a3a79b8fadebf9b2545b6e4c',
  },
  'darwin-x64': {
    asset: `mihomo-darwin-amd64-compatible-v${VERSION}.gz`,
    sha256: '703bceaa494732fa456f47e6ac2f06bf0bc5593d4c927d5f61e10f1a31039c37',
  },
  'linux-x64': {
    asset: `mihomo-linux-amd64-compatible-v${VERSION}.gz`,
    sha256: '2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06',
  },
  'linux-arm64': {
    asset: `mihomo-linux-arm64-v${VERSION}.gz`,
    sha256: 'daaf78a6240a282cdfd75bcbf98fe321f6bd52765cc29e79f344191198f0b50f',
  },
  'win32-x64': {
    asset: `mihomo-windows-amd64-compatible-v${VERSION}.zip`,
    sha256: 'cd6738d4648cc1a5f48049a1343b697ab510889d648f045c5c780fc1ab443a79',
    member: 'mihomo-windows-amd64-compatible.exe',
  },
  'win32-arm64': {
    asset: `mihomo-windows-arm64-v${VERSION}.zip`,
    sha256: '076cb04a21377675bcf009b8d1dd83006ce2464aa537e37bce1faf6d3504f554',
    member: 'mihomo-windows-arm64.exe',
  },
}

const NOTICES = [
  {
    url: `${SOURCE}/LICENSE`,
    file: 'LICENSE',
    sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'resources', 'mihomo')

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The bytes at `url`, refused unless they hash to `expected`.
 * @param {string} url
 * @param {string} expected
 */
async function download(url, expected) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual}, expected ${expected}`)
  return bytes
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

/** @param {string} path */
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

const { values } = parseArgs({
  options: { platform: { type: 'string' }, arch: { type: 'string' } },
})
const platform = values.platform ?? process.platform
const arch = values.arch ?? process.arch
const key = `${platform}-${arch}`
const program = PROGRAMS[key]
if (!program) throw new Error(`mihomo ${VERSION} has no program for ${key}`)
const name = platform === 'win32' ? 'mihomo.exe' : 'mihomo'
const stamp = `${VERSION} ${key}\n`
const stampFile = join(out, 'version')

if (
  (await exists(join(out, name))) &&
  (await readFile(stampFile, 'utf8').catch(() => '')) === stamp
) {
  console.log(`mihomo ${VERSION} for ${key} is already in ${out}`)
} else {
  const work = await mkdtemp(join(tmpdir(), 'kettu-mihomo-'))
  try {
    const bytes = await download(`${RELEASE}/${program.asset}`, program.sha256)
    /** @type {Buffer} */
    let binary
    if (program.member) {
      const archive = join(work, program.asset)
      await writeFile(archive, bytes)
      const unpacked = join(work, 'unpacked')
      await mkdir(unpacked)
      // bsdtar reads zips; on Windows, name the system's, since Git's GNU tar may come first on
      // the path. macOS ships bsdtar as tar.
      const tar =
        process.platform === 'win32'
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          : 'tar'
      run(tar, ['-xf', archive, '-C', unpacked, program.member])
      const extracted = join(unpacked, program.member)
      if (!(await exists(extracted))) throw new Error(`${program.asset} holds no ${program.member}`)
      binary = await readFile(extracted)
    } else {
      binary = gunzipSync(bytes)
    }
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    const target = join(out, name)
    await writeFile(target, binary)
    await chmod(target, 0o755)
    for (const notice of NOTICES) {
      await writeFile(join(out, notice.file), await download(notice.url, notice.sha256))
    }
    await writeFile(stampFile, stamp)
    console.log(`Fetched mihomo ${VERSION} for ${key} into ${out}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// @ts-check
// Fetches Cua Driver's `cua-driver` program, which computer use runs, for one platform and
// architecture into resources/cua-driver/, with Cua's license and third-party notices for the
// notices file. Every download is pinned to the release and checked against its SHA-256 before it
// is used, and nothing downloaded is run. The release run calls it before the build; in a checkout,
// `pnpm fetch:cua-driver`. No dependencies beyond the system's tar, and lipo on macOS. It then
// builds Kite's own kite-computer-helper beside it from native/computer-helper (Windows and macOS).
//
// Usage: node tools/install/cua-driver.mjs [--platform darwin|win32|linux] [--arch arm64|x64]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildComputerHelper } from '../../native/computer-helper/build.mjs'

const VERSION = '0.58.1'
const RELEASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}`
/** The commit the release's tag names, for its license files. */
const COMMIT = '68210fe377a532e7e3b58fa03c95d7fe9d11339b'
const SOURCE = `https://raw.githubusercontent.com/trycua/cua/${COMMIT}`

/** @type {Record<string, { asset: string, sha256: string, lipo?: string }>} */
const PROGRAMS = {
  // One universal program for both Mac architectures, cut down to the target's.
  'darwin-arm64': {
    asset: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    sha256: '99b06af80422ba77be91932ce6c58fed4934a9565cb74bb5cde1fa0396ed1eb2',
    lipo: 'arm64',
  },
  'darwin-x64': {
    asset: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    sha256: '99b06af80422ba77be91932ce6c58fed4934a9565cb74bb5cde1fa0396ed1eb2',
    lipo: 'x86_64',
  },
  'linux-x64': {
    asset: `cua-driver-rs-${VERSION}-linux-x86_64-binary.tar.gz`,
    sha256: 'c6270d240330aa12a3d643689daec160ddd9cfd4b8ad85963158b5f281db317b',
  },
  'linux-arm64': {
    asset: `cua-driver-rs-${VERSION}-linux-arm64-binary.tar.gz`,
    sha256: 'ced2aae2b75cf0e716fe70b778f66e19b2cd2772f990bd3442b3491365b46bd1',
  },
  'win32-x64': {
    asset: `cua-driver-rs-${VERSION}-windows-x86_64-binary.zip`,
    sha256: '1fb6557e901300a7d045d1cc462ad1f4ad184ba88e3dcd2b673bc03948336466',
  },
  'win32-arm64': {
    asset: `cua-driver-rs-${VERSION}-windows-arm64-binary.zip`,
    sha256: '5ba0a610c20c642edf72d0828c8e1f4ce06a9eaa8f753c054e2020090190a613',
  },
}

const NOTICES = [
  {
    url: `${SOURCE}/LICENSE.md`,
    file: 'LICENSE.md',
    sha256: 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9',
  },
  {
    url: `${SOURCE}/libs/cua-driver/rust/THIRD_PARTY_NOTICES.md`,
    file: 'THIRD_PARTY_NOTICES.md',
    sha256: '5860ee54b73d3d84f8af8a3c3fc996739755297d91e259314416378548ee8f6d',
  },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'resources', 'cua-driver')

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
if (!program) throw new Error(`Cua Driver ${VERSION} has no program for ${key}`)
const name = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
const stamp = `${VERSION} ${key}\n`
const stampFile = join(out, 'version')

if (
  (await exists(join(out, name))) &&
  (await readFile(stampFile, 'utf8').catch(() => '')) === stamp
) {
  console.log(`Cua Driver ${VERSION} for ${key} is already in ${out}`)
} else {
  const work = await mkdtemp(join(tmpdir(), 'kettu-cua-driver-'))
  try {
    const archive = join(work, program.asset)
    await writeFile(archive, await download(`${RELEASE}/${program.asset}`, program.sha256))
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked)
    // bsdtar, which macOS and Windows ship as tar, reads the Windows zip too. On Windows it is
    // named by its path, since Git's GNU tar may come first on PATH and reads no zip.
    const tar =
      process.platform === 'win32' && process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'tar.exe')
        : 'tar'
    run(tar, ['-xf', archive, '-C', unpacked, name])
    const extracted = join(unpacked, name)
    if (!(await exists(extracted))) throw new Error(`${program.asset} holds no ${name}`)
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    const target = join(out, name)
    if (program.lipo && process.platform === 'darwin') {
      run('lipo', [extracted, '-thin', program.lipo, '-output', target])
      // Cutting the program voids Cua's signature; packaging signs it again with the app.
      run('codesign', ['--force', '--sign', '-', target])
    } else {
      await copyFile(extracted, target)
    }
    await chmod(target, 0o755)
    for (const notice of NOTICES) {
      await writeFile(join(out, notice.file), await download(notice.url, notice.sha256))
    }
    await writeFile(stampFile, stamp)
    console.log(`Fetched Cua Driver ${VERSION} for ${key} into ${out}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// The helper is built on the target's own system. A macOS build that fails leaves computer use
// without text recognition rather than failing the release, as no Mac checks it before the run.
if (platform === process.platform) {
  const code = buildComputerHelper(out, platform, arch)
  if (code !== 0 && platform !== 'darwin') throw new Error(`kite-computer-helper failed (${code})`)
  if (code !== 0)
    console.warn('kite-computer-helper: not built; computer use reads no text from pictures')
} else if (platform === 'win32' || platform === 'darwin') {
  console.warn(`kite-computer-helper: not built for ${platform} on ${process.platform}`)
}

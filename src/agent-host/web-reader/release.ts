// Huli: the Moli release Kite downloads, pinned with each archive's size and SHA-256 as GitHub
// lists them for v1.1.27. An archive whose hash differs is refused, so a changed release or a
// tampered download never runs. Huli's own; see tools/huli/README.md (Background web reading).

import path from 'node:path'
import type { Platform } from '@shared/platform'
import { MOLI_VERSION } from '@shared/web-reader'

export interface MoliAsset {
  /** The Rust target, which names the archive and the folder inside it. */
  target: string
  format: 'zip' | 'tar.gz'
  bytes: number
  sha256: string
}

const ASSETS: Readonly<Record<string, MoliAsset>> = {
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    format: 'zip',
    bytes: 43_791_379,
    sha256: '314e5833ddefad0b481ab11184ee12b5fdbfe1e433b6369914fbe68e08c83949',
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc',
    format: 'zip',
    bytes: 41_424_653,
    sha256: '74aa7312881522a2ef59f617161d3347ffb2e54e00ec4fd0d66c01667a8807a0',
  },
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    format: 'tar.gz',
    bytes: 41_793_115,
    sha256: '0a9334ad9c52fb79e2995e61ed35737839cd3a0a7b54c4292a1f413014d338df',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    format: 'tar.gz',
    bytes: 45_732_974,
    sha256: '8a2fc8540b30e244c71142086855886fea2ba96eb67ab4a4c11ce8f1bb52fb0d',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-gnu',
    format: 'tar.gz',
    bytes: 45_617_048,
    sha256: '2ede138ca107f16313183be06ef137c0760eaeb83598570d7f4a4263595cd1a6',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-gnu',
    format: 'tar.gz',
    bytes: 44_599_410,
    sha256: 'f33ce375155f36beea672f9f45785a09ab8913c69955b166c7a479712b8456ad',
  },
}

/** The archive for this system and processor; none on musl, which Moli builds nothing for. */
export function moliAsset(platform: Platform, arch: string, musl = false): MoliAsset | null {
  if (platform === 'linux' && musl) return null
  return ASSETS[`${platform}-${arch}`] ?? null
}

export function archiveName(asset: MoliAsset): string {
  return `moli-${asset.target}.${asset.format}`
}

export function releaseUrl(asset: MoliAsset): string {
  return `https://github.com/lexmount/moli/releases/download/v${MOLI_VERSION}/${archiveName(asset)}`
}

/** The folder the archive holds everything in. */
export function archiveFolder(asset: MoliAsset): string {
  return `moli-v${MOLI_VERSION}-${asset.target}`
}

export function moliProgram(dir: string, platform: Platform): string {
  return platform === 'win32' ? path.win32.join(dir, 'moli.exe') : path.posix.join(dir, 'moli')
}

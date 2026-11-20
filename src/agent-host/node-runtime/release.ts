// Huli: which official Node.js build Kite installs for itself, and where it comes from. Pure, so
// the choices are tested from fixtures. Huli's own; see tools/huli/README.md (Kite's own Node.js).

import type { Platform } from '@shared/platform'
import { satisfiesNode } from '../shell-env'
import { compareVersions } from '../versions'

/** Where a release is downloaded from, tried in this order. */
export interface NodeSource {
  id: 'nodejs.org' | 'npmmirror'
  /** The folder that holds `index.json` and one folder per version, ending in `/`. */
  base: string
}

export const OFFICIAL_SOURCE: NodeSource = { id: 'nodejs.org', base: 'https://nodejs.org/dist/' }
// The China mirror, for users who cannot reach nodejs.org or only slowly; it redirects to its CDN.
export const MIRROR_SOURCE: NodeSource = {
  id: 'npmmirror',
  base: 'https://npmmirror.com/mirrors/node/',
}
export const NODE_SOURCES: readonly NodeSource[] = [OFFICIAL_SOURCE, MIRROR_SOURCE]

/** The official binary archive for one platform and architecture. */
export interface NodeAsset {
  /** The name `index.json` lists under a release's `files` when the build exists. */
  key: string
  /** The archive's platform part, such as `win-x64` in `node-v24.11.1-win-x64.zip`. */
  name: string
  format: 'zip' | 'tar.gz'
}

const ASSETS: Readonly<Record<string, NodeAsset>> = {
  'win32-x64': { key: 'win-x64-zip', name: 'win-x64', format: 'zip' },
  'win32-arm64': { key: 'win-arm64-zip', name: 'win-arm64', format: 'zip' },
  'darwin-arm64': { key: 'osx-arm64-tar', name: 'darwin-arm64', format: 'tar.gz' },
  'darwin-x64': { key: 'osx-x64-tar', name: 'darwin-x64', format: 'tar.gz' },
  'linux-x64': { key: 'linux-x64', name: 'linux-x64', format: 'tar.gz' },
  'linux-arm64': { key: 'linux-arm64', name: 'linux-arm64', format: 'tar.gz' },
}

/**
 * The archive for this computer, or null where nodejs.org has none: another platform or
 * architecture, or Linux on musl, which the official glibc builds do not run on.
 */
export function nodeAsset(platform: Platform, arch: string, musl = false): NodeAsset | null {
  if (platform === 'linux' && musl) return null
  return ASSETS[`${platform}-${arch}`] ?? null
}

/** `node-v24.11.1-win-x64`: the archive's one top folder, and its name without the extension. */
export function archiveFolder(version: string, asset: NodeAsset): string {
  return `node-${version}-${asset.name}`
}

export function archiveFile(version: string, asset: NodeAsset): string {
  return `${archiveFolder(version, asset)}.${asset.format}`
}

export function releaseUrl(source: NodeSource, version: string, file: string): string {
  return `${source.base}${version}/${file}`
}

export function indexUrl(source: NodeSource): string {
  return `${source.base}index.json`
}

/** A release version as Kite names its folder: `v` and three numbers, nothing else. */
export const NODE_VERSION = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/

export function compareNodeVersions(a: string, b: string): number {
  return compareVersions(a.replace(/^v/, ''), b.replace(/^v/, ''))
}

/**
 * The strictest of the agents' `>=` requirements, such as `>=24.9.0`; null when none says. Every
 * requirement is a floor, so the highest one satisfies them all.
 */
export function strictestRequirement(requirements: readonly (string | undefined)[]): string | null {
  let strictest: string | null = null
  for (const requirement of requirements) {
    const floor = /^>=\s*v?(\d+(?:\.\d+){0,2})$/.exec(requirement?.trim() ?? '')?.[1]
    if (!floor) continue
    const version = `v${floor}${'.0'.repeat(2 - (floor.match(/\./g)?.length ?? 0))}`
    if (strictest === null || compareNodeVersions(version, strictest) > 0) strictest = version
  }
  return strictest === null ? null : `>=${strictest.slice(1)}`
}

/**
 * The newest LTS release in `index.json` that has the archive and meets `required`, or null.
 * Releases still in development (`lts: false`) and malformed entries are passed over.
 */
export function pickRelease(
  index: unknown,
  asset: NodeAsset,
  required: string | null,
): string | null {
  if (!Array.isArray(index)) return null
  let best: string | null = null
  for (const entry of index as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { version, lts, files } = entry as { version?: unknown; lts?: unknown; files?: unknown }
    if (typeof version !== 'string' || !NODE_VERSION.test(version)) continue
    if (lts === false || lts === undefined || lts === null || lts === '') continue
    if (!Array.isArray(files) || !files.includes(asset.key)) continue
    if (required && !satisfiesNode(version, required)) continue
    if (best === null || compareNodeVersions(version, best) > 0) best = version
  }
  return best
}

/** The SHA-256 that `SHASUMS256.txt` gives the file, lowercase, or null when it lists none. */
export function parseShasums(text: string, file: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match && match[2] === file) return match[1]!.toLowerCase()
  }
  return null
}

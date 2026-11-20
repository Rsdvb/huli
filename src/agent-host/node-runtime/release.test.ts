import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { buildCatalog } from '../catalog'
import index from './fixtures/index.json'
import {
  archiveFile,
  indexUrl,
  MIRROR_SOURCE,
  nodeAsset,
  OFFICIAL_SOURCE,
  parseShasums,
  pickRelease,
  releaseUrl,
  strictestRequirement,
} from './release'

const required = strictestRequirement(buildCatalog(null).map((def) => def.requiresNode))

describe('Kite’s own Node.js release', () => {
  it('needs what every built-in agent needs, DeepSeek’s 24.9 the highest', () => {
    expect(required).toBe('>=24.9.0')
    expect(strictestRequirement(['>=18', '>=22.13', undefined, '>=20.19'])).toBe('>=22.13.0')
    expect(strictestRequirement(['^20', 'latest'])).toBeNull()
  })

  it('names the official archive of each platform and architecture', () => {
    const cases: [Platform, string, string | null][] = [
      ['win32', 'x64', 'node-v26.13.1-win-x64.zip'],
      ['win32', 'arm64', 'node-v26.13.1-win-arm64.zip'],
      ['darwin', 'arm64', 'node-v26.13.1-darwin-arm64.tar.gz'],
      ['darwin', 'x64', 'node-v26.13.1-darwin-x64.tar.gz'],
      ['linux', 'x64', 'node-v26.13.1-linux-x64.tar.gz'],
      ['linux', 'arm64', 'node-v26.13.1-linux-arm64.tar.gz'],
      ['win32', 'ia32', null],
      ['linux', 'ppc64', null],
      ['freebsd', 'x64', null],
    ]
    for (const [platform, arch, file] of cases) {
      const asset = nodeAsset(platform, arch)
      expect(asset && archiveFile('v26.13.1', asset)).toBe(file)
    }
    expect(nodeAsset('linux', 'x64', true)).toBeNull()
  })

  it('picks the newest LTS release that has the archive and meets the agents’ needs', () => {
    const pick = (platform: Platform, arch: string) =>
      pickRelease(index, nodeAsset(platform, arch)!, required)
    // v27's alpha and v25 are no LTS releases; v26.14.0 has no Intel Mac archive.
    expect(pick('win32', 'x64')).toBe('v26.14.0')
    expect(pick('win32', 'arm64')).toBe('v26.14.0')
    expect(pick('darwin', 'arm64')).toBe('v26.14.0')
    expect(pick('linux', 'arm64')).toBe('v26.14.0')
    expect(pick('darwin', 'x64')).toBe('v26.13.1')
  })

  it('takes no LTS release below what the agents need', () => {
    const older = (index as { version: string }[]).filter((e) => !/^v2[5-9]\./.test(e.version))
    // v24.9.0 meets 24.9 but was no LTS release; v24.22.3 is.
    expect(pickRelease(older, nodeAsset('win32', 'x64')!, required)).toBe('v24.22.3')
    const below = older.filter((e) => e.version !== 'v24.22.3')
    expect(pickRelease(below, nodeAsset('win32', 'x64')!, required)).toBeNull()
    expect(pickRelease(below, nodeAsset('win32', 'x64')!, null)).toBe('v22.21.1')
  })

  it('reads nothing from an index that is not a list of releases', () => {
    const asset = nodeAsset('win32', 'x64')!
    expect(pickRelease({ version: 'v26.13.1' }, asset, null)).toBeNull()
    expect(pickRelease([null, 'v26.13.1', { version: 'v26.13.1' }], asset, null)).toBeNull()
    expect(
      pickRelease([{ version: 'v26.13.1; rm -rf /', lts: 'x', files: [asset.key] }], asset, null),
    ).toBeNull()
  })

  it('reads the archive’s SHA-256 from SHASUMS256.txt by its exact name', () => {
    const hash = 'E2EDDA75BFB089654705CF65A13B58933BFD5F57148E8EBDA916F58A2474F1F7'
    const text = [
      `${'0'.repeat(64)}  node-v26.13.1-win-x64.zip.sig`,
      `${'1'.repeat(64)}  node-v26.13.1-win-x64.7z`,
      `${hash}  node-v26.13.1-win-x64.zip`,
      'garbage line',
    ].join('\r\n')
    expect(parseShasums(text, 'node-v26.13.1-win-x64.zip')).toBe(hash.toLowerCase())
    expect(parseShasums(text, 'node-v26.13.1-darwin-arm64.tar.gz')).toBeNull()
  })

  it('downloads from nodejs.org, else its China mirror', () => {
    expect(indexUrl(OFFICIAL_SOURCE)).toBe('https://nodejs.org/dist/index.json')
    expect(releaseUrl(MIRROR_SOURCE, 'v26.13.1', 'SHASUMS256.txt')).toBe(
      'https://npmmirror.com/mirrors/node/v26.13.1/SHASUMS256.txt',
    )
  })
})

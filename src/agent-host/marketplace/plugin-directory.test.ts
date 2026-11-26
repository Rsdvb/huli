import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { COMMIT, tarball } from '../testing/tarball'
import {
  CHECK_MS,
  PluginDirectory,
  parsePluginDirectoryFile,
  type PluginDirectoryFile,
} from './plugin-directory'
import type { PluginSourceSpec } from './plugin-sources'

const MOVED = 'c'.repeat(40)
const log = () => {}

const SOURCES: PluginSourceSpec[] = [
  {
    owner: 'k',
    repo: 'plugins',
    branch: 'main',
    format: 'kettu',
    publisher: 'Kettu',
    trust: 'official',
    titles: { en: 'Kettu plugins' },
    license: 'MIT',
  },
  {
    owner: 'a',
    repo: 'market',
    branch: 'main',
    format: 'claude-code',
    publisher: 'A',
    trust: 'community',
    titles: { en: 'A market' },
    license: 'MIT',
  },
]

const MARKET = JSON.stringify({
  name: 'market',
  plugins: [
    { name: 'local', source: './plugins/local', description: 'In the repository.' },
    {
      name: 'away',
      source: { source: 'url', url: 'https://github.com/b/away.git', sha: MOVED },
      skills: ['./skills/x'],
    },
    { name: 'npm', source: { source: 'npm', package: 'x' } },
  ],
})

const KETTU_PLUGIN = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'ntfy',
  version: '1.0.0',
  description: 'Send notices to ntfy.',
  extensions: { 'sh.kettu': { format: 1, title: { en: 'ntfy', 'zh-CN': 'ntfy' } } },
})

/** GitHub as the directory reads it: the branch's commit, the raw files and the tarballs. */
function github(commit = COMMIT) {
  const state = { commit, asked: [] as string[], etags: [] as (string | null)[], down: false }
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    state.asked.push(url)
    if (state.down) throw new TypeError('fetch failed')
    if (url.startsWith('https://api.github.com/')) {
      const etag = new Headers(init?.headers).get('if-none-match')
      state.etags.push(etag)
      if (etag === `"${state.commit}"`) return new Response(null, { status: 304 })
      return new Response(state.commit, { headers: { etag: `"${state.commit}"` } })
    }
    if (
      url ===
      `https://raw.githubusercontent.com/a/market/${state.commit}/.claude-plugin/marketplace.json`
    ) {
      return new Response(MARKET)
    }
    if (url === `https://codeload.github.com/k/plugins/tar.gz/${state.commit}`) {
      return new Response(
        gzipSync(
          tarball([
            { name: 'plugins-x/ntfy/plugin.json', data: KETTU_PLUGIN },
            { name: 'plugins-x/broken/plugin.json', data: 'not json' },
            { name: 'plugins-x/.github/plugin.json', data: KETTU_PLUGIN },
            { name: 'plugins-x/README.md', data: '# Plugins' },
          ]),
        ),
      )
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { state, fetcher }
}

function directory(fetcher: typeof fetch, now = { at: 1_000_000 }) {
  let saved: PluginDirectoryFile = { version: 1, sources: {} }
  const dir = new PluginDirectory({
    file: {
      load: async () => structuredClone(saved),
      save: (value) => {
        saved = structuredClone(value)
      },
      flush: async () => {},
    },
    log,
    appVersion: '0.3.0',
    fetch: fetcher,
    sources: SOURCES,
    now: () => now.at,
  })
  return { dir, now, saved: () => saved }
}

describe('PluginDirectory', () => {
  it('reads each repository at its commit and lists what installs from github.com', async () => {
    const { fetcher } = github()
    const { dir } = directory(fetcher)
    const catalog = await dir.catalog()
    expect(catalog.sources.map((source) => [source.id, source.read, source.error])).toEqual([
      ['k/plugins', true, null],
      ['a/market', true, null],
    ])
    expect(catalog.sources[1]!.skipped).toBe(1)
    expect(catalog.plugins.map((plugin) => [plugin.id, plugin.format, plugin.url])).toEqual([
      ['k/plugins:ntfy', 'kettu', `https://github.com/k/plugins/tree/${COMMIT}/ntfy`],
      ['a/market:local', 'claude-code', `https://github.com/a/market/tree/${COMMIT}/plugins/local`],
      ['a/market:away', 'claude-code', `https://github.com/b/away/tree/${MOVED}`],
    ])
    expect(catalog.plugins.every((plugin) => /^p[0-9a-f]{12}$/.test(plugin.pluginId))).toBe(true)
  })

  it('asks GitHub again only after a while or on refresh, and downloads only what moved', async () => {
    const { state, fetcher } = github()
    const { dir, now } = directory(fetcher)
    await dir.catalog()
    const first = state.asked.length
    await dir.catalog()
    expect(state.asked).toHaveLength(first)
    now.at += CHECK_MS - 1
    await dir.catalog()
    expect(state.asked).toHaveLength(first)
    await dir.catalog(true)
    // Each repository's commit is asked with the last ETag, and nothing is downloaded.
    expect(state.asked.slice(first)).toEqual([
      'https://api.github.com/repos/k/plugins/commits/main',
      'https://api.github.com/repos/a/market/commits/main',
    ])
    expect(state.etags.slice(-2)).toEqual([`"${COMMIT}"`, `"${COMMIT}"`])
    state.commit = MOVED
    now.at += CHECK_MS
    const moved = await dir.catalog()
    expect(moved.plugins[1]!.url).toBe(`https://github.com/a/market/tree/${MOVED}/plugins/local`)
  })

  it('keeps the lists it had when GitHub cannot be reached, and says so', async () => {
    const { state, fetcher } = github()
    const { dir } = directory(fetcher)
    await dir.catalog()
    state.down = true
    const catalog = await dir.catalog(true)
    expect(catalog.plugins).toHaveLength(3)
    expect(catalog.sources.every((source) => source.error !== null)).toBe(true)
  })

  it('answers from its copy alone when cached, saying whether a read is due', async () => {
    const { state, fetcher } = github()
    const { dir } = directory(fetcher)
    const empty = await dir.catalog(false, true)
    expect(state.asked).toEqual([])
    expect(empty).toMatchObject({ plugins: [], stale: true })
    await dir.catalog()
    expect(await dir.catalog(false, true)).toMatchObject({ stale: false })
  })

  it('names the folder and the manifest an install of a listed plugin takes', async () => {
    const { fetcher } = github()
    const { dir } = directory(fetcher)
    await dir.catalog()
    expect(await dir.hint({ source: 'a/market', name: 'away' })).toEqual({
      url: `https://github.com/b/away/tree/${MOVED}`,
      hint: {
        name: 'away',
        format: 'claude-code',
        manifest: { name: 'away', skills: ['./skills/x'] },
      },
    })
    await expect(dir.hint({ source: 'a/market', name: 'gone' })).rejects.toMatchObject({
      code: 'not_found',
    })
    // Only the repositories it lists, or a link it read.
    await expect(dir.hint({ source: 'x/other', name: 'away' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('tells a link to a marketplace from one to a plugin', async () => {
    const { fetcher } = github()
    const { dir } = directory(fetcher)
    const market = await dir.link('https://github.com/a/market')
    expect(market.kind).toBe('marketplace')
    if (market.kind !== 'marketplace') return
    expect(market.source.id).toBe('link:a/market')
    expect(market.plugins.map((plugin) => plugin.id)).toEqual([
      'link:a/market:local',
      'link:a/market:away',
    ])
    expect((await dir.hint({ source: 'link:a/market', name: 'local' })).url).toBe(
      `https://github.com/a/market/tree/${COMMIT}/plugins/local`,
    )
    expect(await dir.link('https://github.com/a/plugin/tree/main/x')).toEqual({ kind: 'plugin' })
  })
})

describe('parsePluginDirectoryFile', () => {
  const entry = {
    name: 'x',
    title: 'X',
    titles: {},
    description: 'd',
    descriptions: {},
    author: null,
    category: null,
    version: null,
    homepage: 'https://x.example/',
    repository: 'a/b',
    url: `https://github.com/a/b/tree/${COMMIT}/x`,
    format: 'claude-code',
    icon: null,
    manifest: null,
  }
  const copy = (entries: unknown[]) => ({
    fetchedAt: 1,
    commit: COMMIT,
    etag: '"e"',
    skipped: 0,
    entries,
  })

  it('keeps the entries that read, and drops one that points anywhere else', () => {
    const parsed = parsePluginDirectoryFile({
      sources: {
        'a/b': copy([
          entry,
          { ...entry, name: 'gitlab', url: 'https://gitlab.com/a/b' },
          { ...entry, name: 'climbs', url: 'https://github.com/a/b/tree/main/x%5C..%5Cy' },
          { ...entry, name: '../x' },
          { ...entry, name: 'script', icon: 'javascript:alert(1)' },
          { ...entry, name: 'run', format: 'shell' },
          { ...entry, name: 'page', homepage: 'http://x.example/' },
        ]),
      },
    })
    expect(typeof parsed).not.toBe('string')
    if (typeof parsed === 'string') return
    const names = parsed.sources['a/b']!.entries.map((item) => [item.name, item.homepage])
    expect(names).toEqual([
      ['x', 'https://x.example/'],
      ['page', null],
    ])
  })

  it('refuses sources that are no repository, and copies that do not read', () => {
    expect(parsePluginDirectoryFile({ sources: { 'link:a/b': copy([]) } })).toMatch(/repository/)
    expect(parsePluginDirectoryFile({ sources: { '../b': copy([]) } })).toMatch(/repository/)
    expect(
      parsePluginDirectoryFile({ sources: { 'a/b': { ...copy([]), commit: 'main' } } }),
    ).toMatch(/commit/)
    expect(parsePluginDirectoryFile({ sources: [] })).toMatch(/sources/)
  })
})

// Huli: what a plugin repository on GitHub lists, read as untrusted input. A Claude Code
// marketplace's `.claude-plugin/marketplace.json` and a Codex one's `.agents/plugins/marketplace.json`
// give each plugin's name, description and where its files are; a Kettu repository holds each plugin
// in a folder with its plugin.json. Nothing here runs or writes anything: each entry is checked
// field by field, a path that could leave its repository drops the entry, and only plugins on
// github.com are kept, at the commit the marketplace pins when it pins one.

import type { CatalogPluginRef, PluginFormat } from '@shared/plugin-catalog'
import { CATALOG_PLUGIN_NAME } from '@shared/plugin-catalog'
import type { PluginTexts } from '@shared/plugins'
import { LocalizedError } from '../localized-error'
import type { PackageFile } from '../plugins/package'

/** The largest marketplace file read; Anthropic's community one is about 1.6 MB. */
export const MARKETPLACE_BYTES = 8 * 1024 * 1024
const MAX_PLUGINS = 5_000
const DESCRIPTION_CHARS = 600
const LINE_CHARS = 100
const URL_CHARS = 500
const OVERRIDE_BYTES = 64 * 1024
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/
const REF = /^[A-Za-z0-9_.-]{1,200}$/

export const CLAUDE_MARKETPLACE = '.claude-plugin/marketplace.json'
export const CODEX_MARKETPLACE = '.agents/plugins/marketplace.json'
const CLAUDE_MANIFEST = '.claude-plugin/plugin.json'

/**
 * The fields of a Claude Code marketplace entry that say what the plugin holds, passed to the
 * conversion as its manifest would give them. The conversion checks each path again.
 */
const COMPONENT_FIELDS = [
  'commands',
  'agents',
  'skills',
  'hooks',
  'mcpServers',
  'lspServers',
  'outputStyles',
] as const
/** What a manifest made from an entry takes of it besides those. */
const MANIFEST_FIELDS = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
] as const

/** A repository at a ref, and the folder in it a marketplace file sits in. */
export interface RepoAt {
  owner: string
  repo: string
  /** A commit, or a branch when GitHub did not say which commit. */
  ref: string
  /** '' for the repository's top. */
  path: string
}

/** A plugin as the catalog keeps it. */
export interface CatalogEntry {
  name: string
  title: string
  titles: PluginTexts
  description: string
  descriptions: PluginTexts
  author: string | null
  category: string | null
  version: string | null
  homepage: string | null
  /** `<owner>/<repo>` its files are in. */
  repository: string
  /** The github.com folder it installs from. */
  url: string
  format: PluginFormat
  icon: string | null
  /** A Claude Code entry's own manifest fields, which the install's conversion takes. */
  manifest: Record<string, unknown> | null
}

export interface ParsedCatalog {
  entries: CatalogEntry[]
  /** Entries left out: not on github.com, or not readable. */
  skipped: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One line of text, its whitespace collapsed and cut to `max`; null when there is none. */
function line(value: unknown, max = LINE_CHARS): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > URL_CHARS) return null
  const url = URL.parse(value.trim())
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null
  return url.href
}

function authorName(value: unknown): string | null {
  if (typeof value === 'string') return line(value.replace(/\s*[<(].*$/, ''))
  return isRecord(value) ? line(value.name) : null
}

/**
 * A relative folder inside a repository, as a marketplace writes one (`./plugins/x`, `plugins/x`,
 * `./`), joined under `base`; null when it is absolute or could climb out of the repository.
 */
export function innerPath(value: unknown, base = ''): string | null {
  if (typeof value !== 'string' || value.length > URL_CHARS) return null
  if (/[\\\0:]/.test(value) || value.startsWith('/') || /\p{Cc}/u.test(value)) return null
  const trimmed = value.replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '')
  if (trimmed === '') return base
  const parts = trimmed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part))) {
    return null
  }
  return base === '' ? trimmed : `${base}/${trimmed}`
}

/** `owner/repo`, `https://github.com/owner/repo` or the same with `.git`; null for any other host. */
export function githubRepo(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string' || value.length > URL_CHARS) return null
  const text = value.trim()
  let path: string
  if (/^[^/:@\s]+\/[^/:@\s]+$/.test(text)) path = text
  else {
    const url = URL.parse(text)
    if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    if (url.username || url.password || url.port || url.search || url.hash) return null
    path = url.pathname.replace(/^\/+|\/+$/g, '')
  }
  const [owner = '', rawRepo = '', ...rest] = path.split('/')
  const repo = rawRepo.replace(/\.git$/, '')
  if (rest.length > 0 || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    return null
  }
  return { owner, repo }
}

/** The ref a source pins: its commit, else its branch or tag, else the default branch. */
function pinnedRef(source: Record<string, unknown>): string | null {
  if (typeof source.sha === 'string' && SHA.test(source.sha)) return source.sha
  if (source.ref === undefined) return 'HEAD'
  if (typeof source.ref !== 'string' || !REF.test(source.ref) || source.ref.includes('..')) {
    return null
  }
  return source.ref
}

/** The github.com folder at a ref, as the plugins service reads one. */
export function folderUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://github.com/${owner}/${repo}/tree/${ref}${path === '' ? '' : `/${path}`}`
}

/** Where a Claude Code entry's files are, or null when they are not in a github.com repository. */
function entryFolder(
  source: unknown,
  at: RepoAt,
  pluginRoot: string,
): { owner: string; repo: string; ref: string; path: string } | null {
  if (typeof source === 'string') {
    const path = innerPath(source, pluginRoot)
    return path === null ? null : { owner: at.owner, repo: at.repo, ref: at.ref, path }
  }
  if (!isRecord(source)) return null
  const kind = source.source
  if (kind !== 'github' && kind !== 'url' && kind !== 'git-subdir') return null
  const repo = githubRepo(kind === 'github' ? source.repo : source.url)
  const ref = pinnedRef(source)
  if (!repo || ref === null) return null
  const path = kind === 'git-subdir' ? innerPath(source.path) : ''
  if (path === null) return null
  return { ...repo, ref, path }
}

/** The entry's own manifest fields, when they are few enough to keep. */
function manifestFields(raw: Record<string, unknown>): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {}
  for (const key of [...MANIFEST_FIELDS, ...COMPONENT_FIELDS, 'strict'] as const) {
    if (raw[key] !== undefined) kept[key] = raw[key]
  }
  const size = JSON.stringify(kept).length
  return size > OVERRIDE_BYTES ? null : kept
}

function parseJson(text: string, file: string): Record<string, unknown> {
  if (text.length > MARKETPLACE_BYTES) {
    throw new LocalizedError({ key: 'pluginCatalog.tooLarge', params: { file } })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new LocalizedError({ key: 'pluginCatalog.notJson', params: { file } })
  }
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) {
    throw new LocalizedError({ key: 'pluginCatalog.noList', params: { file } })
  }
  return raw
}

/** The plugins of a Claude Code marketplace file that are on github.com. */
export function parseClaudeMarketplace(text: string, at: RepoAt): ParsedCatalog {
  const raw = parseJson(text, CLAUDE_MARKETPLACE)
  const list = raw.plugins as unknown[]
  const metadata = isRecord(raw.metadata) ? raw.metadata : {}
  const pluginRoot =
    metadata.pluginRoot === undefined ? at.path : innerPath(metadata.pluginRoot, at.path)
  const entries: CatalogEntry[] = []
  const names = new Set<string>()
  let skipped = 0
  for (const item of list.slice(0, MAX_PLUGINS)) {
    const entry = isRecord(item) ? claudeEntry(item, at, pluginRoot) : null
    if (!entry || names.has(entry.name)) {
      skipped++
      continue
    }
    names.add(entry.name)
    entries.push(entry)
  }
  return { entries, skipped: skipped + Math.max(0, list.length - MAX_PLUGINS) }
}

function claudeEntry(
  item: Record<string, unknown>,
  at: RepoAt,
  pluginRoot: string | null,
): CatalogEntry | null {
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!CATALOG_PLUGIN_NAME.test(name)) return null
  // A relative source cannot be placed without the root the marketplace names.
  if (typeof item.source === 'string' && pluginRoot === null) return null
  const folder = entryFolder(item.source, at, pluginRoot ?? '')
  if (!folder) return null
  return {
    name,
    title: line(item.displayName) ?? name,
    titles: {},
    description: line(item.description, DESCRIPTION_CHARS) ?? '',
    descriptions: {},
    author: authorName(item.author),
    category: line(item.category, 50),
    version: line(item.version, 50),
    homepage: httpsUrl(item.homepage),
    repository: `${folder.owner}/${folder.repo}`,
    url: folderUrl(folder.owner, folder.repo, folder.ref, folder.path),
    format: 'claude-code',
    icon: null,
    manifest: manifestFields(item),
  }
}

/** The plugins of a Codex marketplace file, each a folder of the same repository. */
export function parseCodexMarketplace(text: string, at: RepoAt): ParsedCatalog {
  const raw = parseJson(text, CODEX_MARKETPLACE)
  const list = raw.plugins as unknown[]
  const entries: CatalogEntry[] = []
  const names = new Set<string>()
  let skipped = 0
  for (const item of list.slice(0, MAX_PLUGINS)) {
    const name = isRecord(item) && typeof item.name === 'string' ? item.name.trim() : ''
    const source = isRecord(item) && isRecord(item.source) ? item.source : null
    const path =
      source && (source.source === 'local' || source.source === undefined)
        ? innerPath(source.path, at.path)
        : null
    if (!CATALOG_PLUGIN_NAME.test(name) || path === null || names.has(name)) {
      skipped++
      continue
    }
    names.add(name)
    const face = isRecord(item) && isRecord(item.interface) ? item.interface : {}
    entries.push({
      name,
      title: line(face.displayName) ?? name,
      titles: {},
      description: line(face.shortDescription, DESCRIPTION_CHARS) ?? '',
      descriptions: {},
      author: null,
      category: isRecord(item) ? line(item.category, 50) : null,
      version: null,
      homepage: null,
      repository: `${at.owner}/${at.repo}`,
      url: folderUrl(at.owner, at.repo, at.ref, path),
      format: 'codex',
      icon: null,
      manifest: null,
    })
  }
  return { entries, skipped: skipped + Math.max(0, list.length - MAX_PLUGINS) }
}

/**
 * The Claude Code plugin's files with its manifest as the marketplace entry gives it: the entry
 * is the whole manifest when it says `strict: false` or the folder has none, as Claude Code then
 * takes the folder's own parts and its name; otherwise the folder's manifest stands, and the
 * entry adds the parts it names that the manifest does not.
 */
export function withEntryManifest(
  files: readonly PackageFile[],
  entry: Record<string, unknown> | null,
  name: string,
): PackageFile[] {
  const file = files.find((item) => item.path === CLAUDE_MANIFEST)
  if (file && !entry) return [...files]
  let own: Record<string, unknown> | null = null
  if (file && entry?.strict !== false) {
    try {
      const parsed = JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, '')) as unknown
      own = isRecord(parsed) ? parsed : null
    } catch {
      own = null
    }
  }
  const made: Record<string, unknown> = own ? { ...own } : { name }
  for (const key of own ? COMPONENT_FIELDS : [...MANIFEST_FIELDS, ...COMPONENT_FIELDS]) {
    if (made[key] === undefined && entry?.[key] !== undefined) made[key] = entry[key]
  }
  const data = Buffer.from(`${JSON.stringify(made, null, 2)}\n`)
  return [
    ...files.filter((item) => item.path !== CLAUDE_MANIFEST),
    { path: CLAUDE_MANIFEST, data, mode: 0o644 },
  ]
}

/**
 * Whether a folder without a manifest is a Claude Code plugin all the same: Claude Code finds a
 * plugin's parts in their default folders and names it after its folder.
 */
export function bareClaudePlugin(files: readonly { path: string }[]): boolean {
  return files.some((file) => {
    const parts = file.path.split('/')
    if (parts.length === 1) return parts[0] === '.mcp.json'
    if (parts.length === 2) {
      return (parts[0] === 'commands' || parts[0] === 'agents') && parts[1]!.endsWith('.md')
    }
    return parts.length === 3 && parts[0] === 'skills' && parts[2] === 'SKILL.md'
  })
}

/** What a folder that is no plugin holds instead, for a message that says what to do. */
export function notPlugin(files: readonly { path: string }[]): 'skill' | 'marketplace' | 'none' {
  const paths = new Set(files.map((file) => file.path))
  if (paths.has(CLAUDE_MARKETPLACE) || paths.has(CODEX_MARKETPLACE)) return 'marketplace'
  if (paths.has('SKILL.md')) return 'skill'
  return 'none'
}

/** A directory reference as text, for logs and the in-memory lookups. */
export const refKey = (ref: CatalogPluginRef): string => `${ref.source}:${ref.name}`

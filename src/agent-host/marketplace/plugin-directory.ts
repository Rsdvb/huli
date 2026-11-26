// Huli: the Plugins tab's directory. Each repository of PLUGIN_SOURCES is read from GitHub through
// the host's proxy when the tab asks, at most once in a while unless asked to refresh: GitHub is
// asked for the branch's commit with the ETag of the last answer, and the list is downloaded
// again only when the commit moved. The lists are kept on disk, and in memory only while the tab
// is in use. Reading a list runs nothing and installs nothing: an install goes through
// plugins.inspect and the consent card, with what this says of the plugin as its hint.

import path from 'node:path'
import type {
  CatalogPluginRef,
  ListedPlugin,
  MarketPluginCatalog,
  PluginCatalogSource,
  PluginFormat,
  PluginLink,
} from '@shared/plugin-catalog'
import { CATALOG_PLUGIN_NAME, CATALOG_SOURCE_ID } from '@shared/plugin-catalog'
import type { PluginTexts } from '@shared/plugins'
import { HostError } from '../errors'
import { t } from '../i18n'
import { LocalizedError, logText } from '../localized-error'
import { PACKAGE_LIMITS, readPackage, MANIFEST_FILE } from '../plugins/package'
import { pluginId, type InspectHint } from '../plugins/service'
import { JsonFile, type LogFn } from '../storage'
import {
  CLAUDE_MARKETPLACE,
  CODEX_MARKETPLACE,
  MARKETPLACE_BYTES,
  entryManifest,
  folderUrl,
  githubRepo,
  parseClaudeMarketplace,
  parseCodexMarketplace,
  refKey,
  type CatalogEntry,
  type ParsedCatalog,
  type RepoAt,
} from './plugin-catalog'
import { PLUGIN_SOURCES, sourceId, type PluginSourceSpec } from './plugin-sources'
import {
  branchHead,
  downloadTarball,
  folderFiles,
  githubSource,
  readTarball,
  tarballUrl,
  type TarLimits,
} from './tarball'

/** How long a list read in this run is taken as current when the tab opens again. */
export const CHECK_MS = 10 * 60_000
/** How long the lists stay in memory after the last request. */
const RELEASE_MS = 2 * 60_000
const RAW_MS = 60_000
const TAR_LIMITS: TarLimits = {
  downloadBytes: 16 * 1024 * 1024,
  unpackedBytes: 64 * 1024 * 1024,
  timeoutMs: 120_000,
}
const MAX_LINKS = 8
const ICON_CHARS = 200 * 1024
const TEXT_CHARS = 2_000
const MANIFEST_CHARS = 64 * 1024
const SHA = /^[0-9a-f]{40}$/
const FORMATS: readonly PluginFormat[] = ['kettu', 'claude-code', 'codex']

/** A repository's list as last read. */
export interface DirectoryCopy {
  /** When the list was last known to be its branch's: read, or the commit found unchanged. */
  fetchedAt: number | null
  commit: string | null
  /** GitHub's ETag for the branch's commit, sent back with the next check. */
  etag: string | null
  skipped: number
  entries: CatalogEntry[]
}

export interface PluginDirectoryFile {
  version: 1
  sources: Record<string, DirectoryCopy>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown, max = TEXT_CHARS): value is string =>
  typeof value === 'string' && value.length <= max

const textOrNull = (value: unknown, max = TEXT_CHARS): string | null =>
  isText(value, max) ? value : null

function textsOf(value: unknown): PluginTexts {
  if (!isRecord(value)) return {}
  const out: PluginTexts = {}
  for (const [key, text] of Object.entries(value)) {
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(key) && isText(text)) out[key] = text
  }
  return out
}

/** An entry as stored, or null when it does not read as one the parser could have made. */
function storedEntry(raw: unknown): CatalogEntry | null {
  if (!isRecord(raw)) return null
  const { name, title, description, repository, url, format, icon, manifest, homepage } = raw
  if (typeof name !== 'string' || !CATALOG_PLUGIN_NAME.test(name)) return null
  if (!isText(title, 200) || !isText(description)) return null
  if (typeof repository !== 'string' || !githubRepo(repository)) return null
  if (typeof url !== 'string' || !url.startsWith('https://github.com/') || !githubSource(url)) {
    return null
  }
  if (!FORMATS.includes(format as PluginFormat)) return null
  if (icon !== null && !(isText(icon, ICON_CHARS) && icon.startsWith('data:image/'))) return null
  if (
    manifest !== null &&
    !(isRecord(manifest) && JSON.stringify(manifest).length <= MANIFEST_CHARS)
  ) {
    return null
  }
  const page = textOrNull(homepage, 500)
  return {
    name,
    title,
    titles: textsOf(raw.titles),
    description,
    descriptions: textsOf(raw.descriptions),
    author: textOrNull(raw.author, 200),
    category: textOrNull(raw.category, 100),
    version: textOrNull(raw.version, 100),
    homepage: page !== null && page.startsWith('https://') ? page : null,
    repository,
    url,
    format: format as PluginFormat,
    icon: icon as string | null,
    manifest: manifest as Record<string, unknown> | null,
  }
}

function storedCopy(raw: unknown): DirectoryCopy | string {
  if (!isRecord(raw)) return 'is not an object'
  const { fetchedAt, commit, etag, skipped, entries } = raw
  if (fetchedAt !== null && typeof fetchedAt !== 'number') return 'fetchedAt is not a time'
  if (commit !== null && !(typeof commit === 'string' && SHA.test(commit))) {
    return 'commit is not a commit'
  }
  if (etag !== null && !isText(etag, 512)) return 'etag is not a string'
  if (typeof skipped !== 'number' || !Number.isSafeInteger(skipped) || skipped < 0) {
    return 'skipped is not a count'
  }
  if (!Array.isArray(entries)) return 'entries is not a list'
  const kept = entries.flatMap((item: unknown) => {
    const entry = storedEntry(item)
    return entry ? [entry] : []
  })
  return { fetchedAt, commit, etag, skipped, entries: kept }
}

export function parsePluginDirectoryFile(
  data: Record<string, unknown>,
): PluginDirectoryFile | string {
  if (!isRecord(data.sources)) return 'sources is not an object'
  const sources: Record<string, DirectoryCopy> = {}
  for (const [id, raw] of Object.entries(data.sources)) {
    if (!CATALOG_SOURCE_ID.test(id) || id.startsWith('link:') || !githubRepo(id)) {
      return `${id.slice(0, 100)} is not a repository`
    }
    const copy = storedCopy(raw)
    if (typeof copy === 'string') return `${id} ${copy}`
    sources[id] = copy
  }
  return { version: 1, sources }
}

export function pluginDirectoryFile(
  userDataPath: string,
  log: LogFn,
): JsonFile<PluginDirectoryFile> {
  return new JsonFile<PluginDirectoryFile>({
    file: path.join(userDataPath, 'state', 'market-plugin-directory.json'),
    version: 1,
    migrations: {},
    parse: parsePluginDirectoryFile,
    empty: () => ({ version: 1, sources: {} }),
    log,
    compact: true,
  })
}

/** Reads a file of a repository from GitHub's raw host; null when there is none. */
export async function rawFile(
  url: string,
  fetcher: typeof fetch,
  max = MARKETPLACE_BYTES,
): Promise<string | null> {
  const signal = AbortSignal.timeout(RAW_MS)
  let response: Response
  try {
    response = await fetcher(url, { signal, headers: { 'user-agent': 'Kettu' } })
  } catch (error) {
    if (signal.aborted) {
      throw new LocalizedError(
        { key: 'marketSkills.github.timeout', params: { seconds: RAW_MS / 1000 } },
        { cause: error },
      )
    }
    throw new LocalizedError(
      { key: 'marketSkills.github.unreachable', params: { reason: (error as Error).message } },
      { cause: error },
    )
  }
  if (response.status === 404) {
    void response.body?.cancel()
    return null
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new LocalizedError({
      key: 'marketSkills.github.status',
      params: { status: response.status },
    })
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel()
      throw new LocalizedError({ key: 'pluginCatalog.tooLarge', params: { file: url } })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const rawUrl = (at: RepoAt, file: string): string =>
  `https://raw.githubusercontent.com/${at.owner}/${at.repo}/${encodeURIComponent(at.ref)}/${
    at.path === '' ? '' : `${at.path.split('/').map(encodeURIComponent).join('/')}/`
  }${file}`

export interface PluginDirectoryDeps {
  file: Pick<JsonFile<PluginDirectoryFile>, 'load' | 'save' | 'flush'>
  log: LogFn
  appVersion: string
  fetch?: typeof fetch
  sources?: readonly PluginSourceSpec[]
  now?: () => number
}

/** A marketplace an Add link named, kept for the install that follows. */
interface LinkCatalog {
  source: PluginCatalogSource
  entries: CatalogEntry[]
}

export class PluginDirectory {
  private kept: PluginDirectoryFile | null = null
  private loading: Promise<PluginDirectoryFile> | null = null
  private readonly reading = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  /** When each repository was last read or checked in this run. */
  private readonly checked = new Map<string, number>()
  private readonly links = new Map<string, LinkCatalog>()
  private release: ReturnType<typeof setTimeout> | null = null
  /** Counts requests, so a release planned before one never drops what it read. */
  private turn = 0
  private readonly now: () => number
  private readonly fetcher: typeof fetch

  constructor(private readonly deps: PluginDirectoryDeps) {
    this.now = deps.now ?? Date.now
    this.fetcher = deps.fetch ?? fetch
  }

  private get specs(): readonly PluginSourceSpec[] {
    return this.deps.sources ?? PLUGIN_SOURCES
  }

  /**
   * Every repository's plugins. Each is checked when it was not in the last CHECK_MS or
   * `refresh` asks; `cached` checks none and says whether one is due.
   */
  async catalog(refresh = false, cached = false): Promise<MarketPluginCatalog> {
    try {
      const due = (spec: PluginSourceSpec) => {
        const at = this.checked.get(sourceId(spec))
        return refresh || at === undefined || this.now() - at >= CHECK_MS
      }
      if (!cached) {
        await Promise.all(this.specs.filter(due).map((spec) => this.read(spec)))
      }
      const file = await this.load()
      const sources = this.specs.map((spec) => this.sourceOf(spec, file.sources[sourceId(spec)]))
      const plugins = this.specs.flatMap((spec) =>
        (file.sources[sourceId(spec)]?.entries ?? []).map((entry) => listed(sourceId(spec), entry)),
      )
      return { sources, plugins, ...(cached && { stale: this.specs.some(due) }) }
    } finally {
      this.idle()
    }
  }

  /**
   * What a github.com link holds: a marketplace's plugins when it names one, kept for the install
   * that follows, else one plugin for plugins.inspect to read.
   */
  async link(url: string): Promise<PluginLink> {
    const github = githubSource(url)
    if (!github) throw new HostError('invalid_params', t('marketSkills.needsGithub'))
    const ref = github.ref ?? 'HEAD'
    const head = SHA.test(ref)
      ? null
      : await branchHead(
          { owner: github.owner, repo: github.repo, branch: ref },
          null,
          this.fetcher,
        )
    const at: RepoAt = {
      owner: github.owner,
      repo: github.repo,
      ref: head?.kind === 'commit' ? head.commit : ref,
      path: github.path,
    }
    let parsed: ParsedCatalog | null = null
    let format: PluginFormat = 'claude-code'
    try {
      const claude = await rawFile(rawUrl(at, CLAUDE_MARKETPLACE), this.fetcher)
      if (claude !== null) parsed = parseClaudeMarketplace(claude, at)
      else {
        const codex = await rawFile(rawUrl(at, CODEX_MARKETPLACE), this.fetcher)
        if (codex !== null) {
          parsed = parseCodexMarketplace(codex, at)
          format = 'codex'
        }
      }
    } catch (error) {
      throw new HostError('unavailable', (error as Error).message)
    }
    if (!parsed) return { kind: 'plugin' }
    const id = `link:${github.owner}/${github.repo}`
    const source: PluginCatalogSource = {
      id,
      titles: { en: `${github.owner}/${github.repo}` },
      publisher: github.owner,
      trust: 'community',
      format,
      url: `https://github.com/${github.owner}/${github.repo}`,
      license: null,
      commit: SHA.test(at.ref) ? at.ref : null,
      fetchedAt: this.now(),
      read: true,
      error: null,
      skipped: parsed.skipped,
    }
    this.links.delete(id)
    this.links.set(id, { source, entries: parsed.entries })
    while (this.links.size > MAX_LINKS) this.links.delete(this.links.keys().next().value!)
    return {
      kind: 'marketplace',
      source,
      plugins: parsed.entries.map((entry) => listed(id, entry)),
    }
  }

  /** The folder a plugin of the directory installs from, and what its install is told of it. */
  async hint(ref: CatalogPluginRef): Promise<{ url: string; hint: InspectHint }> {
    try {
      const entries = ref.source.startsWith('link:')
        ? this.links.get(ref.source)?.entries
        : this.specs.some((spec) => sourceId(spec) === ref.source)
          ? (await this.load()).sources[ref.source]?.entries
          : undefined
      const entry = entries?.find((item) => item.name === ref.name)
      if (!entry) {
        throw new HostError('not_found', t('pluginCatalog.noSuchPlugin', { name: ref.name }))
      }
      return {
        url: entry.url,
        hint: { name: entry.name, format: entry.format, manifest: entryManifest(entry) },
      }
    } finally {
      this.idle()
    }
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  private sourceOf(spec: PluginSourceSpec, copy: DirectoryCopy | undefined): PluginCatalogSource {
    const id = sourceId(spec)
    return {
      id,
      titles: spec.titles,
      publisher: spec.publisher,
      trust: spec.trust,
      format: spec.format,
      url: `https://github.com/${id}`,
      license: spec.license,
      commit: copy?.commit ?? null,
      fetchedAt: copy?.fetchedAt ?? null,
      read: copy !== undefined,
      error: this.failures.get(id) ?? null,
      skipped: copy?.skipped ?? 0,
    }
  }

  private read(spec: PluginSourceSpec): Promise<void> {
    const id = sourceId(spec)
    let reading = this.reading.get(id)
    if (!reading) {
      reading = this.readNow(spec).finally(() => {
        this.reading.delete(id)
        this.checked.set(id, this.now())
      })
      this.reading.set(id, reading)
    }
    return reading
  }

  /**
   * Asks GitHub for the branch's commit, with the last answer's ETag, and reads the list again
   * only when the commit moved; when GitHub would not say, the list before stays, and without one
   * the branch's list is read as it is.
   */
  private async readNow(spec: PluginSourceSpec): Promise<void> {
    const id = sourceId(spec)
    try {
      const copy = (await this.load()).sources[id]
      const head = await branchHead(spec, copy?.etag ?? null, this.fetcher)
      if (copy && head.kind === 'unchanged') {
        this.saveCopy(id, { ...copy, fetchedAt: this.now() })
      } else if (copy && head.kind === 'commit' && head.commit === copy.commit) {
        this.saveCopy(id, { ...copy, fetchedAt: this.now(), etag: head.etag })
      } else if (copy && head.kind === 'unknown') {
        throw new Error(head.reason)
      } else {
        const commit = head.kind === 'commit' ? head.commit : null
        const at: RepoAt = {
          owner: spec.owner,
          repo: spec.repo,
          ref: commit ?? spec.branch,
          path: '',
        }
        const parsed = await this.readList(spec, at)
        this.saveCopy(id, {
          fetchedAt: this.now(),
          commit,
          etag: head.kind === 'commit' ? head.etag : null,
          skipped: parsed.skipped,
          entries: parsed.entries,
        })
        if (parsed.skipped > 0) {
          this.deps.log('info', `The plugin directory left out ${parsed.skipped} of ${id}`)
        }
      }
      this.failures.delete(id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures.set(id, message)
      this.deps.log('warn', `The plugins of ${id} are from before: ${logText(error)}`)
    }
  }

  private async readList(spec: PluginSourceSpec, at: RepoAt): Promise<ParsedCatalog> {
    if (spec.format === 'claude-code') {
      const text = await rawFile(rawUrl(at, CLAUDE_MARKETPLACE), this.fetcher)
      if (text === null) {
        throw new LocalizedError({
          key: 'pluginCatalog.noFile',
          params: { file: CLAUDE_MARKETPLACE },
        })
      }
      return parseClaudeMarketplace(text, at)
    }
    return this.kettuPlugins(at)
  }

  /** The Kettu plugins of a repository: each folder at its top that holds a plugin.json. */
  private async kettuPlugins(at: RepoAt): Promise<ParsedCatalog> {
    const gz = await downloadTarball(
      tarballUrl({ owner: at.owner, repo: at.repo, ref: at.ref, path: '' }),
      TAR_LIMITS,
      this.fetcher,
    )
    const tarball = await readTarball(gz, TAR_LIMITS)
    const ref = tarball.commit ?? at.ref
    const folders = tarball.files
      .map((file) => file.path.split('/'))
      .filter(
        (parts) => parts.length === 2 && parts[1] === MANIFEST_FILE && !parts[0]!.startsWith('.'),
      )
      .map((parts) => parts[0]!)
      .sort()
    const entries: CatalogEntry[] = []
    let skipped = 0
    for (const folder of folders) {
      try {
        const { contents } = readPackage(
          folderFiles(tarball, folder, PACKAGE_LIMITS),
          this.deps.appVersion,
        )
        entries.push({
          name: contents.name,
          title: contents.title.slice(0, 200),
          titles: contents.titles,
          description: contents.description.slice(0, TEXT_CHARS),
          descriptions: contents.descriptions,
          author: contents.author,
          category: null,
          version: contents.version,
          homepage: contents.homepage?.startsWith('https://') ? contents.homepage : null,
          repository: `${at.owner}/${at.repo}`,
          url: folderUrl(at.owner, at.repo, ref, folder),
          format: 'kettu',
          icon: contents.icon && contents.icon.length <= ICON_CHARS ? contents.icon : null,
          manifest: null,
        })
      } catch (error) {
        skipped++
        this.deps.log(
          'warn',
          `The plugin directory left out ${at.owner}/${at.repo}/${folder}: ${logText(error)}`,
        )
      }
    }
    return { entries, skipped }
  }

  private saveCopy(id: string, copy: DirectoryCopy): void {
    const kept = this.kept ?? { version: 1, sources: {} }
    this.kept = { version: 1, sources: { ...kept.sources, [id]: copy } }
    this.deps.file.save(this.kept)
  }

  private load(): Promise<PluginDirectoryFile> {
    if (this.kept) return Promise.resolve(this.kept)
    this.loading ??= this.deps.file.load().then(
      (file) => (this.kept ??= file),
      (error: unknown) => {
        this.deps.log('warn', `Could not read the plugin directory: ${(error as Error).message}`)
        return (this.kept ??= { version: 1, sources: {} })
      },
    )
    return this.loading
  }

  /** Lets the lists go from memory a while after the last request, once they are on disk. */
  private idle(): void {
    if (this.release) clearTimeout(this.release)
    const turn = ++this.turn
    this.release = setTimeout(() => {
      this.release = null
      if (this.reading.size > 0) return this.idle()
      void this.deps.file.flush().then(() => {
        if (this.turn !== turn || this.reading.size > 0) return
        this.kept = null
        this.loading = null
      })
    }, RELEASE_MS)
    this.release.unref?.()
  }
}

/** An entry as the Plugins tab shows it. */
function listed(source: string, entry: CatalogEntry): ListedPlugin {
  return {
    id: refKey({ source, name: entry.name }),
    source,
    name: entry.name,
    title: entry.title,
    titles: entry.titles,
    description: entry.description,
    descriptions: entry.descriptions,
    author: entry.author,
    category: entry.category,
    version: entry.version,
    homepage: entry.homepage,
    repository: entry.repository,
    url: entry.url,
    format: entry.format,
    pluginId: pluginId({ kind: 'github', url: entry.url }),
    icon: entry.icon,
  }
}

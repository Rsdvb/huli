// Huli: the Plugins tab's directory, read from GitHub: Kettu's own plugins and the Claude Code
// marketplaces the host lists, each plugin with the github.com folder it installs from. A Claude
// Code or Codex plugin is converted into a Kettu plugin when it is installed.

import type { PluginTexts } from './plugins'

/** How far the publisher of a source is trusted: the tool's maker, or the community. */
export type PluginTrust = 'official' | 'community'

/** What a plugin is written for: Kettu's own format, or a harness's, which converts on install. */
export type PluginFormat = 'kettu' | 'claude-code' | 'codex'

/** A repository the directory reads, or one an Add link named. */
export interface PluginCatalogSource {
  /** `<owner>/<repo>`; `link:<owner>/<repo>` for a marketplace an Add link named. */
  id: string
  /** Its name by language, such as `en` and `zh-CN`. */
  titles: PluginTexts
  publisher: string
  trust: PluginTrust
  format: PluginFormat
  /** https://github.com/<owner>/<repo> */
  url: string
  /** The repository's license as checked when it was listed; null for a link's. */
  license: string | null
  /** The commit its list was read at; null when GitHub did not say. */
  commit: string | null
  /** When its list was last read or found unchanged; null before the first read. */
  fetchedAt: number | null
  /** Whether the host has its list. */
  read: boolean
  /** Why the last read failed; the plugins then come from the list before. */
  error: string | null
  /** The plugins it lists that are not on github.com, which the host cannot install. */
  skipped: number
}

/** A plugin of the directory. */
export interface ListedPlugin {
  /** `<source id>:<name>` */
  id: string
  /** Its source's id. */
  source: string
  name: string
  title: string
  /** Its title and description by language, from a Kettu plugin's manifest; empty otherwise. */
  titles: PluginTexts
  description: string
  descriptions: PluginTexts
  author: string | null
  category: string | null
  version: string | null
  /** An https address. */
  homepage: string | null
  /** The repository its files are in, `<owner>/<repo>`. */
  repository: string
  /** The github.com folder it installs from, at the commit its source pins when it pins one. */
  url: string
  format: PluginFormat
  /** The id an installed copy of it has. */
  pluginId: string
  /** A Kettu plugin's icon as a data URL. */
  icon: string | null
}

export interface MarketPluginCatalog {
  sources: PluginCatalogSource[]
  plugins: ListedPlugin[]
  /** A `cached` answer with a source that is due a read; a read without `cached` brings it in. */
  stale?: boolean
}

/** What a github.com link holds: one plugin, or a marketplace that lists plugins. */
export type PluginLink =
  { kind: 'plugin' } | { kind: 'marketplace'; source: PluginCatalogSource; plugins: ListedPlugin[] }

/** A plugin of the directory, as an install names it for the host to look up. */
export interface CatalogPluginRef {
  source: string
  name: string
}

export const CATALOG_SOURCE_ID = /^(?:link:)?[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
export const CATALOG_PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Whether a directory reference holds a source id and a plugin name the host can look up. */
export function isCatalogRef(value: CatalogPluginRef): boolean {
  return (
    CATALOG_SOURCE_ID.test(value.source) &&
    !/\/\.\.?$/.test(value.source) &&
    CATALOG_PLUGIN_NAME.test(value.name)
  )
}

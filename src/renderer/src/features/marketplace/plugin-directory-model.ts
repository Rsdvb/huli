// Huli: what the Plugins tab's directory rows share: the install they start, and the names,
// tiles and search of the directory's plugins.

import { createContext } from 'react'
import type { ListedPlugin, PluginCatalogSource } from '@shared/plugin-catalog'
import { pluginText } from '@shared/plugins'
import type { PluginInstall } from './plugin-install'
import { kettuPluginSubject, pluginSubject, type TileSubject } from './tile-art'

/** The install the Marketplace's page draws the consent card of, for the rows under it. */
export const PluginInstallContext = createContext<PluginInstall | null>(null)

export const HARNESS_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const

export function sourceTitle(source: PluginCatalogSource, locale: string): string {
  return pluginText(source.titles, source.id.replace(/^link:/, ''), locale)
}

export function listedTitle(plugin: ListedPlugin, locale: string): string {
  return pluginText(plugin.titles, plugin.title, locale)
}

export function listedSubject(plugin: ListedPlugin, source: PluginCatalogSource): TileSubject {
  return plugin.format === 'kettu'
    ? kettuPluginSubject({
        name: plugin.name,
        official: source.trust === 'official',
        icon: plugin.icon,
      })
    : pluginSubject({ harness: plugin.format, id: plugin.id, category: plugin.category })
}

/** Whether a plugin of the directory matches what the search field holds. */
export function listedMatches(plugin: ListedPlugin, query: string, locale: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [
    plugin.name,
    listedTitle(plugin, locale),
    pluginText(plugin.descriptions, plugin.description, locale),
    plugin.author ?? '',
    plugin.category ?? '',
    plugin.repository,
  ].some((text) => text.toLowerCase().includes(q))
}

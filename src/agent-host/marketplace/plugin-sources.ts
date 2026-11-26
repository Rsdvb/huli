// Huli: the GitHub repositories the Marketplace's Plugins tab lists, in the order it shows them.
// The owner may edit this list: each entry is a public repository whose license allows listing
// what it holds, and that is maintained. A plugin's own files come from wherever its entry says,
// at the commit the marketplace pins, and are converted on install when written for Claude Code.

import type { PluginTexts } from '@shared/plugins'
import type { PluginTrust } from '@shared/plugin-catalog'

export interface PluginSourceSpec {
  owner: string
  repo: string
  branch: string
  /**
   * `kettu`: each folder at the top with a plugin.json is a Kettu plugin. `claude-code`: the
   * plugins `.claude-plugin/marketplace.json` lists, as Claude Code reads it.
   */
  format: 'kettu' | 'claude-code'
  /** As GitHub shows the account's name. */
  publisher: string
  trust: PluginTrust
  titles: PluginTexts
  /** The repository's license, as checked when it was added here. */
  license: string
}

/**
 * Checked on 2026-11-26: each repository exists, was pushed to in the last week, and is licensed
 * as given. openai/plugins, Codex's own marketplace, is left out: its repository has no license,
 * only some of its plugins do.
 */
export const PLUGIN_SOURCES: readonly PluginSourceSpec[] = [
  {
    owner: 'KettuAI',
    repo: 'plugins',
    branch: 'main',
    format: 'kettu',
    publisher: 'Kettu',
    trust: 'official',
    titles: { en: "Kettu's plugins", 'zh-CN': 'Kettu 官方插件' },
    license: 'MIT',
  },
  {
    owner: 'anthropics',
    repo: 'claude-plugins-official',
    branch: 'main',
    format: 'claude-code',
    publisher: 'Anthropic',
    trust: 'official',
    titles: { en: 'Claude Code official marketplace', 'zh-CN': 'Claude Code 官方插件市场' },
    license: 'Apache-2.0',
  },
  {
    owner: 'anthropics',
    repo: 'claude-plugins-community',
    branch: 'main',
    format: 'claude-code',
    publisher: 'Anthropic',
    trust: 'community',
    titles: { en: 'Claude Code community marketplace', 'zh-CN': 'Claude Code 社区插件市场' },
    license: 'Apache-2.0',
  },
  {
    owner: 'obra',
    repo: 'superpowers-marketplace',
    branch: 'main',
    format: 'claude-code',
    publisher: 'Jesse Vincent',
    trust: 'community',
    titles: { en: 'Superpowers marketplace', 'zh-CN': 'Superpowers 插件市场' },
    license: 'MIT',
  },
  {
    owner: 'wshobson',
    repo: 'agents',
    branch: 'main',
    format: 'claude-code',
    publisher: 'Seth Hobson',
    trust: 'community',
    titles: {
      en: 'Claude Code workflows by Seth Hobson',
      'zh-CN': 'Seth Hobson 的 Claude Code 工作流插件',
    },
    license: 'MIT',
  },
]

export const sourceId = (spec: Pick<PluginSourceSpec, 'owner' | 'repo'>): string =>
  `${spec.owner}/${spec.repo}`

// The Marketplace's plugins and skills as the desktop's directory lists them: its sections, the
// reads of the harnesses' plugins and of the skills catalog, the skills Huli keeps in the host
// settings, and the agent choice an install asks for.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import {
  displayTitle,
  type CatalogPlugin,
  type CatalogSkill,
  type InstalledPlugin,
  type MarketPlugins,
  type MarketSkill,
  type MarketSkills,
  type PluginHarness,
  type SkillTrust,
} from '@shared/marketplace'
import type { HostLink } from '@shared/remote/link'
import { useHost } from '../host'
import { AgentGlyph } from '../ui/AgentAvatar'
import { haptic } from '../ui/haptics'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { baseName, call, fail, useHostSettings, useRead, type Read } from './kit'

/** Rows a section shows before it folds the rest under 显示更多. */
export const SECTION_ROWS = 6

const FEATURED_PLUGINS = 6
const FEATURED_SKILLS = 3
const FEATURED_SKILL_NAMES = ['pdf', 'docx', 'xlsx', 'pptx', 'skill-creator', 'webapp-testing']
const featuredRank = (name: string): number => {
  const rank = FEATURED_SKILL_NAMES.indexOf(name)
  return rank < 0 ? FEATURED_SKILL_NAMES.length : rank
}

export type Entry =
  | { kind: 'plugin'; key: string; title: string; plugin: CatalogPlugin }
  | { kind: 'skill'; key: string; title: string; skill: CatalogSkill }

export interface Section {
  id: string
  title: string
  entries: Entry[]
  /** A repository of the skills catalog that could not be read, with its id to read again. */
  failed?: { repository: string; text: string }
}

export const pluginEntry = (plugin: CatalogPlugin): Entry => ({
  kind: 'plugin',
  key: `plugin:${plugin.harness}:${plugin.id}`,
  title: plugin.title,
  plugin,
})

export const skillEntry = (skill: CatalogSkill): Entry => ({
  kind: 'skill',
  key: `skill:${skill.id}`,
  title: displayTitle(skill.name),
  skill,
})

/** A plugin's name without its marketplace: `code-review@claude-plugins` gives `code-review`. */
export function pluginName(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

export function matchesText(parts: (string | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return parts.filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
}

export function pluginMatches(plugin: CatalogPlugin, query: string): boolean {
  return matchesText(
    [plugin.title, plugin.name, plugin.publisher, plugin.description, plugin.category],
    query,
  )
}

export function skillMatches(skill: CatalogSkill | MarketSkill, query: string): boolean {
  return matchesText(
    [skill.name, 'publisher' in skill ? skill.publisher : null, skill.description],
    query,
  )
}

export function categoryTitle(category: string): string {
  const words = category.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

/** Most installed first; then their marketplace's picks, then by title. */
export function byInstalls(a: CatalogPlugin, b: CatalogPlugin): number {
  return (
    (b.installs ?? -1) - (a.installs ?? -1) ||
    Number(b.featured) - Number(a.featured) ||
    a.title.localeCompare(b.title)
  )
}

/** Huli: Anthropic's community plugin marketplace, which the 社区 section lists apart. */
export function isCommunityPlugin(plugin: CatalogPlugin): boolean {
  return plugin.harness === 'claude-code' && plugin.marketplace === 'claude-community'
}

export function fromAnthropic(plugin: CatalogPlugin): boolean {
  return (
    plugin.harness === 'claude-code' && plugin.official && /anthropic/i.test(plugin.publisher ?? '')
  )
}

export function skillFromAnthropic(skill: CatalogSkill): boolean {
  return /anthropic/i.test(skill.publisher) || skill.id.startsWith('anthropics/skills')
}

export function trustOf(skill: CatalogSkill): SkillTrust {
  return skill.trust ?? (skill.official ? 'official' : 'community')
}

export const TRUST_TEXT: Record<SkillTrust, string> = {
  official: '官方',
  verified: '认证发布者',
  community: '社区',
}

const TRUST_ORDER: Record<SkillTrust, number> = { official: 0, verified: 1, community: 2 }

/** Huli's 社区: Anthropic's community plugins by installs, and the community's skills on GitHub. */
function communitySections(
  plugins: MarketPlugins | null,
  skills: MarketSkills | null,
  kind: 'plugin' | 'skill' | null,
): Section[] {
  const fromPlugins =
    kind === 'skill'
      ? []
      : (plugins?.catalog ?? []).filter(isCommunityPlugin).sort(byInstalls).map(pluginEntry)
  const fromSkills =
    kind === 'plugin'
      ? []
      : (skills?.catalog ?? []).filter((s) => s.trust === 'community').map(skillEntry)
  const entries = [...fromPlugins, ...fromSkills]
  return entries.length > 0 ? [{ id: 'community', title: '社区', entries }] : []
}

/** The lists taken in turn, one item from each, so a section mixes its kinds. */
function interleave<T>(...lists: T[][]): T[] {
  const out: T[] = []
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!)
  }
  return out
}

/** 全部 without a query: 精选, 来自 Anthropic, 适用于 Codex, then 社区. */
export function allSections(plugins: MarketPlugins | null, skills: MarketSkills | null): Section[] {
  const sorted = [...(plugins?.catalog ?? [])].sort(byInstalls)
  const catalogSkills = skills?.catalog ?? []
  const featured = interleave(
    sorted
      .filter((p) => p.featured && !isCommunityPlugin(p))
      .slice(0, FEATURED_PLUGINS)
      .map(pluginEntry),
    catalogSkills
      .filter((s) => s.official)
      .sort((a, b) => featuredRank(a.name) - featuredRank(b.name))
      .slice(0, FEATURED_SKILLS)
      .map(skillEntry),
  )
  return [
    { id: 'featured', title: '精选', entries: featured },
    {
      id: 'anthropic',
      title: '来自 Anthropic',
      entries: [
        ...sorted.filter(fromAnthropic).map(pluginEntry),
        ...catalogSkills.filter(skillFromAnthropic).map(skillEntry),
      ],
    },
    {
      id: 'codex',
      title: '适用于 Codex',
      entries: sorted.filter((p) => p.harness === 'codex').map(pluginEntry),
    },
    ...communitySections(plugins, skills, null),
  ].filter((section) => section.entries.length > 0)
}

/** 插件 without a query: 精选, each category with the largest first, 其他插件, then 社区. */
export function pluginSections(plugins: MarketPlugins | null): Section[] {
  const list = [...(plugins?.catalog ?? [])].filter((p) => !isCommunityPlugin(p)).sort(byInstalls)
  const groups = new Map<string, CatalogPlugin[]>()
  for (const plugin of list) {
    const category = plugin.category?.trim().toLocaleLowerCase() ?? ''
    groups.set(category, [...(groups.get(category) ?? []), plugin])
  }
  const categories = [...groups]
    .sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : y.length - x.length))
    .map(([category, items]) => ({
      id: `category-${category}`,
      title: category ? categoryTitle(category) : '其他插件',
      entries: items.map(pluginEntry),
    }))
  return [
    {
      id: 'featured-plugins',
      title: '精选',
      entries: list.filter((p) => p.featured).map(pluginEntry),
    },
    ...categories,
    ...communitySections(plugins, null, 'plugin'),
  ].filter((section) => section.entries.length > 0)
}

/**
 * 技能 without a query: one section per publisher, the official ones first, then the verified; a
 * repository that could not be read says so with its id to read again.
 */
export function skillSections(skills: MarketSkills | null): Section[] {
  if (!skills) return []
  const groups = new Map<string, { skills: CatalogSkill[]; failed: string[]; trust: number[] }>()
  const group = (publisher: string) => {
    const found = groups.get(publisher) ?? { skills: [], failed: [], trust: [] }
    groups.set(publisher, found)
    return found
  }
  const errors = new Map<string, string>()
  for (const repository of skills.repositories ?? []) {
    const found = group(repository.publisher)
    found.trust.push(TRUST_ORDER[repository.trust])
    if (repository.error !== null) {
      found.failed.push(repository.id)
      errors.set(repository.id, repository.error)
    }
  }
  for (const skill of skills.catalog) {
    if (skill.trust === 'community') continue
    const found = group(skill.publisher)
    found.skills.push(skill)
    found.trust.push(TRUST_ORDER[trustOf(skill)])
  }
  const sections = [...groups]
    .filter(([, g]) => g.skills.length > 0 || g.failed.length > 0)
    .sort(([, a], [, b]) => Math.min(...a.trust) - Math.min(...b.trust))
    .map(([publisher, g]): Section => {
      const repository = g.failed[0]
      const error = repository ? errors.get(repository) : undefined
      return {
        id: `publisher-${publisher}`,
        title: `来自 ${publisher}`,
        entries: g.skills.map(skillEntry),
        ...(repository && error
          ? {
              failed: {
                repository,
                text:
                  g.skills.length > 0
                    ? `无法重新读取 ${repository}，下面的可能不是最新的：${error}`
                    : `无法读取 ${repository}：${error}`,
              },
            }
          : {}),
      }
    })
  return [...sections, ...communitySections(null, skills, 'skill')]
}

/** With a query: the plugins and skills that match, as the tab shows them. */
export function foundSections(
  plugins: MarketPlugins | null,
  skills: MarketSkills | null,
  tab: 'all' | 'plugins' | 'skills',
  query: string,
): Section[] {
  const sections: Section[] = []
  if (tab !== 'skills') {
    sections.push({
      id: 'found-plugins',
      title: '插件',
      entries: (plugins?.catalog ?? [])
        .filter((p) => pluginMatches(p, query))
        .sort(byInstalls)
        .map(pluginEntry),
    })
  }
  if (tab !== 'plugins') {
    sections.push({
      id: 'found-skills',
      title: '技能',
      entries: (skills?.catalog ?? []).filter((s) => skillMatches(s, query)).map(skillEntry),
    })
  }
  return sections.filter((section) => section.entries.length > 0)
}

/** The same install: one plugin in one agent's configuration, at one scope and project. */
export function samePlace(a: InstalledPlugin, b: InstalledPlugin): boolean {
  return (
    a.id === b.id &&
    a.agentId === b.agentId &&
    a.scope === b.scope &&
    (a.projectPath ?? null) === (b.projectPath ?? null)
  )
}

export function placeOf(plugin: InstalledPlugin) {
  return {
    agentId: plugin.agentId,
    pluginId: plugin.id,
    scope: plugin.scope,
    ...(plugin.projectPath ? { projectPath: plugin.projectPath } : {}),
  }
}

export function placeKey(plugin: InstalledPlugin): string {
  return `${plugin.agentId}|${plugin.id}|${plugin.scope}|${plugin.projectPath ?? ''}`
}

/** Where an installed plugin applies: 所有项目, or the project it is in. */
export function scopeLine(plugin: InstalledPlugin): string {
  if (plugin.scope === 'user') return '所有项目'
  const project = baseName(plugin.projectPath ?? '')
  return plugin.scope === 'local' ? `在 ${project} 中，仅自己可用` : `在 ${project} 中`
}

export const HARNESS_NAME: Record<PluginHarness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** The agents an install may go to, as the agent menu lists them; of one harness when given. */
export function useChoosableAgents(harness?: PluginHarness): AgentStatus[] {
  const host = useHost()
  return useMemo(
    () =>
      [...host.agents.values()].filter(
        (a) =>
          a.registered !== false &&
          !['not-installed', 'node-missing', 'node-outdated'].includes(a.state) &&
          !a.hidden &&
          !a.disabled &&
          (harness === undefined || a.harnessId === harness),
      ),
    [host.agents, harness],
  )
}

/** An agent's name as the computer gives it, else its id. */
export function useAgentName(): (id: AgentId) => string {
  const host = useHost()
  return useCallback((id) => host.agents.get(id)?.name ?? id, [host.agents])
}

/**
 * A list the host keeps a while: what it kept first, however old, then afresh when that is stale;
 * `refresh` reads afresh, as pull to refresh does.
 */
function useKeptList<T extends { stale?: boolean }>(
  key: string,
  read: (refresh: boolean) => (link: HostLink) => Promise<T>,
): { read: Read<T>; refresh(): Promise<void> } {
  const host = useHost()
  const list = useRead<T>(key, read(false))
  const renewed = useRef(false)
  const refresh = useCallback(async () => {
    if (!host.link) return
    if (list.value === null) return list.reload()
    try {
      const fresh = await read(true)(host.link)
      list.set(() => fresh)
    } catch (failure) {
      fail('没能刷新', failure)
    }
  }, [host.link, list, read])
  const stale = list.value?.stale === true
  useEffect(() => {
    if (!stale || renewed.current || !host.link) return
    renewed.current = true
    const link = host.link
    read(true)(link).then(
      (fresh) => list.set(() => fresh),
      () => {},
    )
  }, [stale, host.link, list, read])
  return { read: list, refresh }
}

const readPlugins = (refresh: boolean) => (link: HostLink) =>
  call(link, 'market.plugins', refresh ? { refresh: true } : { cached: true })

const readSkills = (refresh: boolean) => (link: HostLink) =>
  call(link, 'market.skills', refresh ? { refresh: true } : { cached: true })

/** Plugins from Claude Code's and Codex's marketplaces, and the ones each agent installed. */
export function useMarketPlugins() {
  return useKeptList<MarketPlugins>('market-plugins', readPlugins)
}

/** The skills catalog, each agent's own skills and Huli's built-in ones. */
export function useMarketSkills() {
  return useKeptList<MarketSkills>('market-skills', readSkills)
}

/** The skills Huli keeps, from the host settings, and writing that list whole. */
export function useKeptSkills() {
  const settings = useHostSettings()
  const kept = settings.value?.marketplace.skills ?? null
  const save = useCallback(
    async (change: (skills: MarketSkill[]) => MarketSkill[]) => {
      if (!settings.value) throw new Error('没能读取电脑上的设置。')
      await settings.update({ marketplace: { skills: change(settings.value.marketplace.skills) } })
    },
    [settings],
  )
  return { settings, kept, save }
}

export type AgentChoice = 'all' | AgentId[]

/** 所有 Agent, or the agents tapped; tapping the last one off goes back to all. */
export function AgentChoicePicker(props: {
  agents: AgentStatus[]
  value: AgentChoice
  onChange(value: AgentChoice): void
  /** One agent only, as a plugin install takes. */
  single?: boolean
}) {
  const { c } = useTokens()
  const chip = (key: string, label: string, on: boolean, onPress: () => void, agentId?: string) => (
    <Press
      key={key}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      accessibilityRole={props.single ? 'radio' : 'checkbox'}
      accessibilityState={{ checked: on }}
      style={[
        styles.chip,
        { backgroundColor: on ? c.tintSoft : c.fill, borderColor: on ? c.tint : 'transparent' },
      ]}
    >
      {agentId ? <AgentGlyph agentId={agentId} name={label} size={15} /> : null}
      <Text style={[typeScale.subhead, { color: on ? c.tint : c.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  )
  const { value, onChange } = props
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
      keyboardShouldPersistTaps="handled"
    >
      {props.single ? null : chip('all', '所有 Agent', value === 'all', () => onChange('all'))}
      {props.agents.map((agent) => {
        const on = value !== 'all' && value.includes(agent.id)
        return chip(
          agent.id,
          agent.name,
          on,
          () => {
            if (props.single) return onChange([agent.id])
            if (value === 'all') return onChange([agent.id])
            const next = on ? value.filter((id) => id !== agent.id) : [...value, agent.id]
            onChange(next.length === 0 ? 'all' : next)
          },
          agent.id,
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  chips: { gap: space.sm, paddingRight: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 36,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
})

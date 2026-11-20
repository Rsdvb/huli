// Settings › 插件市场: the plugins of Claude Code's and Codex's marketplaces and the skills catalog,
// in the desktop directory's sections, and what is installed: each agent's plugins, the skills Huli
// keeps, its built-in skills and the plugin marketplaces the agents read.

import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentId } from '@shared/agents'
import { displayTitle, type InstalledPlugin, type MarketSkill } from '@shared/marketplace'
import { Sheet } from '../../components/Sheet'
import {
  Button,
  call,
  confirm,
  Field,
  FieldLabel,
  FieldNote,
  FormSheet,
  GroupNote,
  homeShort,
  ManagePage,
  Notice,
  ReadState,
  SkeletonGroup,
  useActions,
} from '../../manage/kit'
import {
  AgentChoicePicker,
  allSections,
  foundSections,
  pluginName,
  pluginSections,
  placeKey,
  placeOf,
  samePlace,
  scopeLine,
  SECTION_ROWS,
  skillMatches,
  skillSections,
  useAgentName,
  useChoosableAgents,
  useKeptSkills,
  useMarketPlugins,
  useMarketSkills,
  type AgentChoice,
  type Entry,
  type Section,
} from '../../manage/market'
import { useHost } from '../../host'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { IconButton } from '../../ui/IconButton'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { PendingSwitch } from '../../ui/PendingSwitch'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { space, type as typeScale, useTokens } from '../../ui/tokens'

type Tab = 'all' | 'plugins' | 'skills' | 'installed'

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'plugins', label: '插件' },
  { key: 'skills', label: '技能' },
  { key: 'installed', label: '已安装' },
]

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+/i

export default function Market() {
  const host = useHost()
  const plugins = useMarketPlugins()
  const skills = useMarketSkills()
  const { settings, kept, save } = useKeptSkills()
  const actions = useActions()
  const agentName = useAgentName()
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [sheet, setSheet] = useState<'add' | 'marketplace' | 'skill' | null>(null)

  const pluginList = plugins.read.value
  const skillList = skills.read.value
  const searching = query.trim() !== ''

  const refresh = () =>
    Promise.all([plugins.refresh(), skills.refresh(), settings.reload()]).then(() => {})

  const openEntry = (entry: Entry) => {
    if (entry.kind === 'plugin') {
      router.push({
        pathname: '/settings/market-plugin',
        params: { harness: entry.plugin.harness, id: entry.plugin.id },
      })
    } else {
      router.push({ pathname: '/settings/market-skill', params: { id: entry.skill.id } })
    }
  }

  const installedPlugin = (entry: Entry): boolean =>
    entry.kind === 'plugin'
      ? !!pluginList?.installed.some(
          (p) => p.id === entry.plugin.id && p.harness === entry.plugin.harness,
        )
      : !!kept?.some((s) => s.id === entry.skill.id)

  const sectionView = (section: Section) => {
    const expanded = open.has(section.id) || searching
    const shown = expanded ? section.entries : section.entries.slice(0, SECTION_ROWS)
    const rest = section.entries.length - shown.length
    return (
      <View key={section.id} style={styles.section}>
        {section.failed ? (
          <Notice
            tone="warning"
            title={section.failed.text}
            actions={
              <Button
                label="重试"
                icon="refresh"
                busy={actions.busy(`repo:${section.failed.repository}`)}
                onPress={() => {
                  const id = section.failed!.repository
                  void actions.run(
                    `repo:${id}`,
                    async () => {
                      if (!host.link) return
                      const read = await call(host.link, 'market.skillRepository', {
                        id,
                        refresh: true,
                      })
                      skills.read.set((list) => ({
                        ...list,
                        catalog: [
                          ...list.catalog.filter((s) => !s.id.startsWith(`${id}:`)),
                          ...read.skills,
                        ],
                        repositories: (list.repositories ?? []).map((r) =>
                          r.id === id ? read.repository : r,
                        ),
                      }))
                    },
                    '没能读取',
                  )
                }}
              />
            }
          />
        ) : null}
        {shown.length > 0 ? (
          <ListGroup header={section.title}>
            {shown.map((entry) => {
              const line =
                entry.kind === 'plugin' ? entry.plugin.description : entry.skill.description
              return (
                <ListRow
                  key={entry.key}
                  title={entry.title}
                  subtitle={line || undefined}
                  icon={entry.kind === 'plugin' ? 'puzzle' : 'sparkles'}
                  value={installedPlugin(entry) ? '已安装' : undefined}
                  chevron
                  onPress={() => openEntry(entry)}
                />
              )
            })}
            {rest > 0 ? (
              <ListRow
                key="more"
                title={`显示更多（${rest}）`}
                action
                onPress={() => {
                  haptic.tap()
                  setOpen((ids) => new Set(ids).add(section.id))
                }}
              />
            ) : null}
          </ListGroup>
        ) : null}
      </View>
    )
  }

  const directory = () => {
    if (tab === 'skills' && skills.read.value === null) {
      return <ReadState read={skills.read} what="插件市场" icon="store" rows={6} />
    }
    if (tab !== 'skills' && plugins.read.value === null) {
      return <ReadState read={plugins.read} what="插件市场" icon="store" rows={6} />
    }
    const secondary = tab === 'all' ? skills.read : null
    const notes = (
      <>
        {pluginList?.errors.map((error) => (
          <GroupNote key={error.agentId} tone="error">
            {`无法读取 ${agentName(error.agentId)} 的插件：${error.message}`}
          </GroupNote>
        ))}
        {tab !== 'plugins' && skillList?.error ? (
          <GroupNote tone="error">{`无法读取技能目录，内容可能不是最新的：${skillList.error}`}</GroupNote>
        ) : null}
        {secondary && secondary.value === null ? (
          secondary.error ? (
            <Notice
              tone="error"
              title="无法读取技能目录"
              actions={<Button label="重试" onPress={() => void secondary.reload()} />}
            >
              {secondary.error}
            </Notice>
          ) : (
            <SkeletonGroup rows={2} />
          )
        ) : null}
      </>
    )
    const sections = searching
      ? foundSections(pluginList, skillList, tab === 'installed' ? 'all' : tab, query)
      : tab === 'plugins'
        ? pluginSections(pluginList)
        : tab === 'skills'
          ? skillSections(skillList)
          : allSections(pluginList, skillList)
    return (
      <>
        {notes}
        {sections.map(sectionView)}
        {sections.length === 0 ? (
          searching ? (
            <EmptyState
              icon="search"
              title="没有找到"
              message={`没有结果匹配“${query.trim()}”。`}
            />
          ) : tab === 'skills' ? (
            <EmptyState
              icon="sparkles"
              title="没有可显示的技能"
              message="技能目录是空的。可以用“添加”从 GitHub 加入技能。"
            />
          ) : (
            <EmptyState
              icon="puzzle"
              title="没有可显示的插件"
              message="Claude Code 和 Codex 还没有列出任何插件。可以用“添加”加入一个插件市场。"
            />
          )
        ) : null}
      </>
    )
  }

  const pluginTitle = (plugin: InstalledPlugin): string =>
    pluginList?.catalog.find((p) => p.harness === plugin.harness && p.id === plugin.id)?.title ??
    displayTitle(pluginName(plugin.id))

  const setPluginEnabled = (plugin: InstalledPlugin, enabled: boolean) =>
    actions.run(
      placeKey(plugin),
      async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        await call(host.link, 'market.setPluginEnabled', { ...placeOf(plugin), enabled })
        plugins.read.set((p) => ({
          ...p,
          installed: p.installed.map((x) => (samePlace(x, plugin) ? { ...x, enabled } : x)),
        }))
      },
      `无法修改 ${pluginTitle(plugin)}`,
    )

  const setSkillOn = (skill: MarketSkill, on: boolean) =>
    actions.run(
      `skill:${skill.id}`,
      () => save((list) => list.map((s) => (s.id === skill.id ? { ...s, on } : s))),
      `无法修改 ${skill.name}`,
    )

  const installed = () => {
    if (pluginList === null) {
      return <ReadState read={plugins.read} what="插件市场" icon="store" rows={4} />
    }
    const installedPlugins = pluginList.installed.filter((p) =>
      [pluginTitle(p), p.id, agentName(p.agentId)]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    const keptSkills = (kept ?? []).filter((s) => skillMatches(s, query))
    const builtIn = (skillList?.builtIn ?? []).filter((s) =>
      `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    const markets = pluginList.marketplaces.filter((m) =>
      `${m.name} ${m.source} ${agentName(m.agentId)}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    return (
      <>
        {pluginList.errors.map((error) => (
          <GroupNote key={error.agentId} tone="error">
            {`无法读取 ${agentName(error.agentId)} 的插件：${error.message}`}
          </GroupNote>
        ))}
        <View style={styles.section}>
          {installedPlugins.length === 0 ? (
            searching ? null : (
              <EmptyGroup header="插件" note="还没有 Agent 安装插件。可以在“插件”中安装。" />
            )
          ) : (
            <ListGroup header="插件">
              {installedPlugins.map((plugin) => (
                <ListRow
                  key={placeKey(plugin)}
                  title={pluginTitle(plugin)}
                  subtitle={[
                    agentName(plugin.agentId),
                    plugin.scope === 'user' ? null : scopeLine(plugin),
                    plugin.version,
                    plugin.enabled ? null : '已关闭',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  icon="puzzle"
                  trailing={
                    <PendingSwitch
                      value={plugin.enabled}
                      disabled={actions.busy(placeKey(plugin))}
                      onChange={(on) => {
                        haptic.select()
                        return setPluginEnabled(plugin, on)
                      }}
                      accessibilityLabel={`在 ${agentName(plugin.agentId)} 中启用 ${pluginTitle(plugin)}`}
                    />
                  }
                  onPress={() =>
                    router.push({
                      pathname: '/settings/market-plugin',
                      params: { harness: plugin.harness, id: plugin.id },
                    })
                  }
                />
              ))}
            </ListGroup>
          )}
        </View>

        {kept === null && settings.error === null ? (
          <SkeletonGroup rows={2} />
        ) : builtIn.length + keptSkills.length === 0 ? (
          searching ? null : (
            <EmptyGroup
              header="技能"
              note={
                settings.error
                  ? `没能读取电脑上的设置：${settings.error}`
                  : '纸鸢还没有保存任何技能。可以在“技能”中安装。'
              }
            />
          )
        ) : (
          <ListGroup header="技能">
            {builtIn.map((skill) => (
              <ListRow
                key={`builtin:${skill.name}`}
                title={displayTitle(skill.name)}
                subtitle={skill.description}
                icon="sparkles"
                value="内置"
              />
            ))}
            {keptSkills.map((skill) => (
              <ListRow
                key={skill.id}
                title={displayTitle(skill.name)}
                subtitle={[
                  skill.on ? null : '已关闭',
                  skill.agents === 'all' ? null : `用于 ${skill.agents.length} 个 Agent`,
                  skill.description,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon="sparkles"
                trailing={
                  <PendingSwitch
                    value={skill.on}
                    disabled={actions.busy(`skill:${skill.id}`)}
                    onChange={(on) => {
                      haptic.select()
                      return setSkillOn(skill, on)
                    }}
                    accessibilityLabel={`启用 ${skill.name}`}
                  />
                }
                onPress={() =>
                  router.push({ pathname: '/settings/market-skill', params: { id: skill.id } })
                }
              />
            ))}
          </ListGroup>
        )}

        {markets.length > 0 ? (
          <ListGroup
            header="插件市场"
            footer="每个 Agent 从这里查找插件。各自工具自带的插件市场会保留。"
          >
            {markets.map((market) => {
              const key = `market:${market.agentId}|${market.name}`
              return (
                <ListRow
                  key={key}
                  title={market.name}
                  subtitle={`${agentName(market.agentId)} · ${homeShort(market.source)}`}
                  icon="store"
                  value={market.official ? '内置' : undefined}
                  trailing={
                    market.official ? undefined : (
                      <Button
                        label="移除"
                        tone="danger"
                        busy={actions.busy(key)}
                        accessibilityLabel={`移除 ${market.name}`}
                        onPress={() => {
                          void confirm({
                            title: `移除 ${market.name}？`,
                            message: `${agentName(market.agentId)} 将不再列出其中的插件；已从这里安装的插件可能无法继续使用。`,
                            confirm: '移除',
                          }).then((yes) => {
                            if (!yes) return
                            void actions.run(
                              key,
                              async () => {
                                if (!host.link) throw new Error('电脑没有连上。')
                                await call(host.link, 'market.removeMarketplace', {
                                  agentId: market.agentId,
                                  name: market.name,
                                })
                                plugins.read.set((p) => ({
                                  ...p,
                                  marketplaces: p.marketplaces.filter(
                                    (m) =>
                                      !(m.agentId === market.agentId && m.name === market.name),
                                  ),
                                }))
                                void plugins.refresh()
                              },
                              `无法移除 ${market.name}`,
                            )
                          })
                        }}
                      />
                    )
                  }
                />
              )
            })}
          </ListGroup>
        ) : null}
      </>
    )
  }

  return (
    <ManagePage
      title="插件市场"
      intro="给你的 Agent 用的插件和技能，来自你所用工具的开发者，以及社区。"
      onRefresh={refresh}
      right={
        <IconButton
          icon="plus"
          label="添加"
          size={44}
          onPress={() => {
            haptic.tap()
            setSheet('add')
          }}
        />
      }
      overlay={
        <>
          <Sheet
            visible={sheet === 'add'}
            title="自己添加"
            items={[
              {
                key: 'marketplace',
                label: '插件市场…',
                detail: 'GitHub 仓库或 Git URL',
                onPress: () => setSheet('marketplace'),
              },
              {
                key: 'skill',
                label: '来自 GitHub 的技能…',
                detail: '一个仓库，或仓库中的一个文件夹',
                onPress: () => setSheet('skill'),
              },
            ]}
            onClose={() => setSheet((s) => (s === 'add' ? null : s))}
          />
          <AddMarketplace
            visible={sheet === 'marketplace'}
            onClose={() => setSheet(null)}
            onAdded={() => void plugins.refresh()}
          />
          <AddSkill visible={sheet === 'skill'} onClose={() => setSheet(null)} save={save} />
        </>
      }
    >
      <SegmentedControl
        segments={TABS}
        value={tab}
        onChange={(next) => {
          setTab(next)
          setOpen(new Set())
        }}
      />
      <Field
        value={query}
        onChangeText={setQuery}
        placeholder="搜索 Marketplace"
        clearButtonMode="while-editing"
        returnKeyType="search"
        accessibilityLabel="搜索 Marketplace"
        style={styles.search}
      />
      {tab === 'installed' ? installed() : directory()}
      <FieldNote>发布、工作流和 MCP 服务器目录在电脑上的纸鸢里管理。</FieldNote>
    </ManagePage>
  )
}

/** A group's heading over a line that says it holds nothing yet. */
function EmptyGroup(props: { header: string; note: string }) {
  const { c } = useTokens()
  return (
    <View style={styles.empty}>
      <Text style={[typeScale.headline, styles.emptyHeader, { color: c.textSecondary }]}>
        {props.header}
      </Text>
      <GroupNote>{props.note}</GroupNote>
    </View>
  )
}

/** 添加插件市场: an agent of Claude Code or Codex, and a GitHub repository or Git URL. */
function AddMarketplace(props: { visible: boolean; onClose(): void; onAdded(): void }) {
  const host = useHost()
  const agents = useChoosableAgents().filter(
    (a) => a.harnessId === 'claude-code' || a.harnessId === 'codex',
  )
  const [agent, setAgent] = useState<AgentChoice>('all')
  const [source, setSource] = useState('')
  const chosen: AgentId | null = agent === 'all' ? (agents[0]?.id ?? null) : (agent[0] ?? null)
  return (
    <FormSheet
      visible={props.visible}
      onClose={() => {
        props.onClose()
        setSource('')
        setAgent('all')
      }}
      title="添加插件市场"
      message="插件市场为 Claude Code 或 Codex 列出插件。你选择的 Agent 会把它保存在自己的配置中。"
      submitLabel="添加"
      canSubmit={chosen !== null && source.trim() !== ''}
      onSubmit={async () => {
        if (!host.link || !chosen) throw new Error('电脑没有连上。')
        await call(host.link, 'market.addMarketplace', { agentId: chosen, source: source.trim() })
        props.onAdded()
      }}
    >
      <FieldLabel>Agent</FieldLabel>
      {agents.length === 0 ? (
        <FieldNote>请先添加一个 Claude Code 或 Codex Agent。</FieldNote>
      ) : (
        <AgentChoicePicker
          agents={agents}
          single
          value={chosen ? [chosen] : 'all'}
          onChange={setAgent}
        />
      )}
      <FieldLabel>来源</FieldLabel>
      <Field
        value={source}
        onChangeText={setSource}
        placeholder="owner/repo"
        mono
        returnKeyType="done"
      />
      <FieldNote>GitHub 仓库（owner/repo），或 Git URL。</FieldNote>
    </FormSheet>
  )
}

/** 从 GitHub 添加技能: the computer copies it, then Huli keeps it for the agents chosen. */
function AddSkill(props: {
  visible: boolean
  onClose(): void
  save(change: (skills: MarketSkill[]) => MarketSkill[]): Promise<void>
}) {
  const host = useHost()
  const agents = useChoosableAgents()
  const [url, setUrl] = useState('')
  const [choice, setChoice] = useState<AgentChoice>('all')
  const typed = url.trim()
  const valid = GITHUB_URL.test(typed)
  return (
    <FormSheet
      visible={props.visible}
      onClose={() => {
        props.onClose()
        setUrl('')
        setChoice('all')
      }}
      title="从 GitHub 添加技能"
      message="纸鸢会把技能复制到电脑上，并交给你选择的 Agent。"
      submitLabel="添加"
      canSubmit={valid}
      onSubmit={async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        const full = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`
        const skill = await call(host.link, 'market.addSkill', {
          source: { kind: 'github', url: full },
        })
        await props.save((list) => [
          ...list.filter((s) => s.id !== skill.id),
          { ...skill, agents: choice, on: true },
        ])
      }}
    >
      <FieldLabel>URL</FieldLabel>
      <Field
        value={url}
        onChangeText={setUrl}
        placeholder="https://github.com/owner/repo"
        keyboardType="url"
        mono
      />
      <FieldNote error={typed !== '' && !valid}>
        {typed !== '' && !valid
          ? '请输入 github.com 的地址。'
          : '一个仓库，或其中含有 SKILL.md 的文件夹。'}
      </FieldNote>
      <FieldLabel>用于</FieldLabel>
      <AgentChoicePicker agents={agents} value={choice} onChange={setChoice} />
    </FormSheet>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  search: { marginTop: -space.md },
  empty: { gap: space.sm },
  emptyHeader: { marginLeft: space.lg },
})

// A plugin of Claude Code's or Codex's marketplaces: its logo and facts, what it adds to an agent,
// the agents it is installed in, each with its switch and Uninstall, and installing it in another.

import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { router, useLocalSearchParams } from 'expo-router'
import type { AgentId } from '@shared/agents'
import {
  displayTitle,
  type CatalogPlugin,
  type InstalledPlugin,
  type PluginHarness,
} from '@shared/marketplace'
import { useHost } from '../../host'
import {
  Button,
  Buttons,
  call,
  confirm,
  FieldLabel,
  FieldNote,
  FormSheet,
  GroupNote,
  ManagePage,
  Notice,
  ReadState,
  SkeletonGroup,
  useActions,
  useRead,
} from '../../manage/kit'
import {
  AgentChoicePicker,
  categoryTitle,
  HARNESS_NAME,
  placeKey,
  placeOf,
  pluginName,
  samePlace,
  scopeLine,
  useAgentName,
  useChoosableAgents,
  useMarketPlugins,
  type AgentChoice,
} from '../../manage/market'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { PendingSwitch } from '../../ui/PendingSwitch'
import { cacheFor } from '../../ui/memory'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { tokensText } from '../../ui/session/limits'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'
import { openUrl } from '../../system/openUrl'

const PARTS = [
  ['skills', '技能'],
  ['commands', '命令'],
  ['agents', '子 Agent'],
  ['hooks', 'Hook'],
  ['mcpServers', 'MCP 服务器'],
  ['lspServers', 'LSP 服务器'],
] as const

const HOOKS_WARNING = '包含 hook：它们会在电脑上自行运行命令，不受 Agent 沙盒限制。'

export default function MarketPlugin() {
  const params = useLocalSearchParams<{ harness: string; id: string }>()
  const harness: PluginHarness = params.harness === 'codex' ? 'codex' : 'claude-code'
  const id = params.id ?? ''
  const { c, scheme } = useTokens()
  const host = useHost()
  const plugins = useMarketPlugins()
  const actions = useActions()
  const agentName = useAgentName()
  const harnessAgents = useChoosableAgents(harness)
  const [installing, setInstalling] = useState(false)

  const list = plugins.read.value
  const plugin = list?.catalog.find((p) => p.harness === harness && p.id === id) ?? null
  const installs = (list?.installed ?? []).filter((p) => p.harness === harness && p.id === id)
  const title = plugin?.title ?? displayTitle(pluginName(id))
  const detailsAgent: AgentId | null = installs[0]?.agentId ?? harnessAgents[0]?.id ?? null

  const logo = useRead(`plugin-logo:${id}`, (link) =>
    call(link, 'market.pluginLogo', { pluginId: id }),
  )
  const details = useRead(detailsAgent ? `plugin-details:${detailsAgent}:${id}` : null, (link) =>
    call(link, 'market.pluginDetails', { agentId: detailsAgent!, pluginId: id }),
  )
  const hooks = (details.value?.hooks.length ?? 0) > 0
  const logoUri =
    (scheme === 'dark'
      ? (logo.value?.dark ?? logo.value?.light)
      : (logo.value?.light ?? logo.value?.dark)) ?? null

  const refresh = () =>
    Promise.all([plugins.refresh(), logo.reload(), details.reload()]).then(() => {})

  const setEnabled = (install: InstalledPlugin, enabled: boolean) =>
    actions.run(
      placeKey(install),
      async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        await call(host.link, 'market.setPluginEnabled', { ...placeOf(install), enabled })
        plugins.read.set((p) => ({
          ...p,
          installed: p.installed.map((x) => (samePlace(x, install) ? { ...x, enabled } : x)),
        }))
      },
      `无法修改 ${title}`,
    )

  const uninstall = async (install: InstalledPlugin) => {
    const agent = agentName(install.agentId)
    const yes = await confirm({
      title: `卸载 ${title}？`,
      message: `${agent} 会把它从自己的配置中移除，之后的会话不再带上它。`,
      confirm: '卸载',
    })
    if (!yes) return
    await actions.run(
      `uninstall:${placeKey(install)}`,
      async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        await call(host.link, 'market.uninstallPlugin', placeOf(install))
        plugins.read.set((p) => ({
          ...p,
          installed: p.installed.filter((x) => !samePlace(x, install)),
        }))
      },
      `无法卸载 ${title}`,
    )
  }

  if (list === null) {
    return (
      <ManagePage title="插件" onRefresh={refresh}>
        <ReadState read={plugins.read} what="插件" icon="puzzle" rows={4} />
      </ManagePage>
    )
  }

  if (!plugin && installs.length === 0) {
    return (
      <ManagePage title="插件" onRefresh={refresh}>
        <EmptyState
          icon="puzzle"
          title="找不到这个插件"
          message="它可能已从插件市场下架，或者已被卸载。"
          action={{ label: '返回插件市场', onPress: () => router.back() }}
        />
      </ManagePage>
    )
  }

  return (
    <ManagePage
      title={title}
      onRefresh={refresh}
      overlay={
        plugin ? (
          <InstallSheet
            visible={installing}
            plugin={plugin}
            hooks={hooks}
            onClose={() => setInstalling(false)}
            onInstalled={(installed) =>
              plugins.read.set((p) => ({
                ...p,
                installed: [...p.installed.filter((x) => !samePlace(x, installed)), installed],
              }))
            }
          />
        ) : null
      }
    >
      <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.heroHead}>
          {logoUri ? (
            <Image
              source={{ uri: logoUri }}
              style={styles.logo}
              contentFit="contain"
              cachePolicy={cacheFor(logoUri)}
              transition={120}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={[styles.logo, styles.tile, { backgroundColor: c.fill }]}>
              <Icon name="puzzle" size={26} color={c.textSecondary} />
            </View>
          )}
          <View style={styles.flex}>
            <Text style={[typeScale.title, { color: c.text }]} numberOfLines={2}>
              {title}
            </Text>
            <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={1}>
              {[plugin?.publisher, HARNESS_NAME[harness], plugin?.official ? '官方' : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
        {plugin?.description ? (
          <Text style={[typeScale.callout, { color: c.text }]} selectable>
            {plugin.description}
          </Text>
        ) : null}
        {plugin ? (
          <Buttons>
            <Button
              label={installs.length > 0 ? '为其他 Agent 安装' : '安装'}
              tone="primary"
              icon="download"
              disabled={host.state.kind !== 'connected'}
              onPress={() => setInstalling(true)}
            />
          </Buttons>
        ) : null}
      </View>

      {hooks ? <Notice tone="warning" title={HOOKS_WARNING} /> : null}

      {plugin ? (
        <ListGroup>
          {plugin.installs !== null ? (
            <ListRow title="安装次数" value={plugin.installs.toLocaleString('zh-CN')} />
          ) : null}
          {plugin.category ? <ListRow title="类别" value={categoryTitle(plugin.category)} /> : null}
          {plugin.version ? <ListRow title="版本" value={plugin.version} /> : null}
          <ListRow title="插件市场" value={plugin.marketplace} />
          <ListRow title="插件" value={plugin.id} />
          {plugin.homepage ? (
            <ListRow title="主页" external onPress={() => openUrl(plugin.homepage!)} />
          ) : null}
        </ListGroup>
      ) : null}

      {installs.length > 0 ? (
        <ListGroup header="已安装于">
          {installs.map((install) => {
            const agent = agentName(install.agentId)
            return (
              <ListRow
                key={placeKey(install)}
                title={agent}
                subtitle={[scopeLine(install), install.version, install.enabled ? null : '已关闭']
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <View style={styles.trailing}>
                    <Button
                      label="卸载"
                      tone="danger"
                      busy={actions.busy(`uninstall:${placeKey(install)}`)}
                      accessibilityLabel={`从 ${agent} 卸载 ${title}`}
                      onPress={() => void uninstall(install)}
                    />
                    <PendingSwitch
                      value={install.enabled}
                      disabled={actions.busy(placeKey(install))}
                      onChange={(on) => {
                        haptic.select()
                        return setEnabled(install, on)
                      }}
                      accessibilityLabel={`在 ${agent} 中启用 ${title}`}
                    />
                  </View>
                }
              />
            )
          })}
        </ListGroup>
      ) : null}

      {detailsAgent === null ? null : details.value === null ? (
        details.error ? (
          <GroupNote tone="error">{`无法读取它包含的内容：${details.error}`}</GroupNote>
        ) : (
          <SkeletonGroup rows={2} />
        )
      ) : (
        <PartsGroup
          added={installs.length > 0}
          parts={PARTS.map(([key, label]) => ({ label, items: details.value![key] }))}
          tokens={details.value.alwaysOnTokens}
        />
      )}
    </ManagePage>
  )
}

/** What the plugin adds, as its harness reports it, and what it takes from every session. */
function PartsGroup(props: {
  added: boolean
  parts: { label: string; items: string[] }[]
  tokens: number | null
}) {
  const shown = props.parts.filter((part) => part.items.length > 0)
  if (shown.length === 0 && props.tokens === null) return null
  return (
    <ListGroup
      header={props.added ? '包含' : '将会加入'}
      footer={
        props.tokens !== null ? `每个会话约占用 ${tokensText(props.tokens)} 个 token` : undefined
      }
    >
      {shown.map((part) => (
        <ListRow
          key={part.label}
          title={part.label}
          subtitle={part.items.join('、')}
          value={String(part.items.length)}
        />
      ))}
    </ListGroup>
  )
}

/** Installing in one agent of the plugin's harness, for every project or one. */
function InstallSheet(props: {
  visible: boolean
  plugin: CatalogPlugin
  hooks: boolean
  onClose(): void
  onInstalled(installed: InstalledPlugin): void
}) {
  const host = useHost()
  const agents = useChoosableAgents(props.plugin.harness)
  const [agent, setAgent] = useState<AgentChoice>('all')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [project, setProject] = useState<string | null>(null)
  const chosen: AgentId | null = agent === 'all' ? (agents[0]?.id ?? null) : (agent[0] ?? null)
  const scoped = props.plugin.harness === 'claude-code'
  const projects = host.projects.filter((p) => !p.missing)
  const harnessName = HARNESS_NAME[props.plugin.harness]
  const ready = chosen !== null && (scope === 'user' || project !== null)
  return (
    <FormSheet
      visible={props.visible}
      onClose={props.onClose}
      title={`安装 ${props.plugin.title}`}
      message={`由 ${harnessName} 安装到这个 Agent 自己的配置中，它的终端也能用上。`}
      submitLabel="安装"
      canSubmit={ready}
      onSubmit={async () => {
        if (!host.link || !chosen) throw new Error('电脑没有连上。')
        const installed = await call(host.link, 'market.installPlugin', {
          agentId: chosen,
          pluginId: props.plugin.id,
          scope,
          ...(scope === 'project' && project ? { projectPath: project } : {}),
        })
        props.onInstalled(installed)
      }}
    >
      <FieldLabel>Agent</FieldLabel>
      {agents.length === 0 ? (
        <FieldNote>{`请先添加一个 ${harnessName} Agent。`}</FieldNote>
      ) : (
        <AgentChoicePicker
          agents={agents}
          single
          value={chosen ? [chosen] : 'all'}
          onChange={setAgent}
        />
      )}
      {scoped ? (
        <>
          <FieldLabel>范围</FieldLabel>
          <SegmentedControl
            segments={[
              { key: 'user', label: '所有项目' },
              { key: 'project', label: '单个项目' },
            ]}
            value={scope}
            onChange={(next) => setScope(next)}
          />
          {scope === 'project' ? (
            projects.length === 0 ? (
              <FieldNote>电脑上还没有项目。</FieldNote>
            ) : (
              <>
                <FieldLabel>项目</FieldLabel>
                <ProjectChoice
                  projects={projects.map((p) => ({ path: p.path, name: p.name }))}
                  value={project}
                  onChange={setProject}
                />
              </>
            )
          ) : null}
        </>
      ) : null}
      {props.hooks ? <FieldNote error>{HOOKS_WARNING}</FieldNote> : null}
    </FormSheet>
  )
}

function ProjectChoice(props: {
  projects: { path: string; name: string }[]
  value: string | null
  onChange(path: string): void
}) {
  const { c } = useTokens()
  return (
    <View style={styles.projects}>
      {props.projects.map((p) => {
        const on = p.path === props.value
        return (
          <ListRow
            key={p.path}
            title={p.name}
            subtitle={p.path}
            icon="folder"
            plainIcon
            trailing={on ? <Icon name="check" size={18} color={c.tint} weight="semibold" /> : null}
            onPress={() => {
              haptic.select()
              props.onChange(p.path)
            }}
          />
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  hero: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.md,
  },
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  logo: { width: 56, height: 56, borderRadius: radius.md },
  tile: { alignItems: 'center', justifyContent: 'center' },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  projects: { borderRadius: radius.lg, overflow: 'hidden' },
})

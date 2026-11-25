// Settings › 插件市场: the skills catalog, in the desktop directory's sections, and what is
// installed: the skills Huli keeps and its built-in skills. Kettu took Claude Code's and Codex's
// plugins out of the Marketplace; its own plugins are managed on the computer.

import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { displayTitle, type MarketSkill } from '@shared/marketplace'
import { Sheet } from '../../components/Sheet'
import {
  Button,
  call,
  Field,
  FieldLabel,
  FieldNote,
  FormSheet,
  GroupNote,
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
  SECTION_ROWS,
  skillMatches,
  skillSections,
  useChoosableAgents,
  useKeptSkills,
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

type Tab = 'all' | 'skills' | 'installed'

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'skills', label: '技能' },
  { key: 'installed', label: '已安装' },
]

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+/i

export default function Market() {
  const host = useHost()
  const skills = useMarketSkills()
  const { settings, kept, save } = useKeptSkills()
  const actions = useActions()
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [sheet, setSheet] = useState<'add' | 'skill' | null>(null)

  const skillList = skills.read.value
  const searching = query.trim() !== ''

  const refresh = () => Promise.all([skills.refresh(), settings.reload()]).then(() => {})

  const openEntry = (entry: Entry) => {
    router.push({ pathname: '/settings/market-skill', params: { id: entry.skill.id } })
  }

  const installedSkill = (entry: Entry): boolean => !!kept?.some((s) => s.id === entry.skill.id)

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
            {shown.map((entry) => (
              <ListRow
                key={entry.key}
                title={entry.title}
                subtitle={entry.skill.description || undefined}
                icon="sparkles"
                value={installedSkill(entry) ? '已安装' : undefined}
                chevron
                onPress={() => openEntry(entry)}
              />
            ))}
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
    if (skills.read.value === null) {
      return <ReadState read={skills.read} what="插件市场" icon="store" rows={6} />
    }
    const notes = skillList?.error ? (
      <GroupNote tone="error">{`无法读取技能目录，内容可能不是最新的：${skillList.error}`}</GroupNote>
    ) : null
    const sections = searching
      ? foundSections(skillList, query)
      : tab === 'skills'
        ? skillSections(skillList)
        : allSections(skillList)
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
          ) : (
            <EmptyState
              icon="sparkles"
              title="没有可显示的技能"
              message="技能目录是空的。可以用“添加”从 GitHub 加入技能。"
            />
          )
        ) : null}
      </>
    )
  }

  const setSkillOn = (skill: MarketSkill, on: boolean) =>
    actions.run(
      `skill:${skill.id}`,
      () => save((list) => list.map((s) => (s.id === skill.id ? { ...s, on } : s))),
      `无法修改 ${skill.name}`,
    )

  const installed = () => {
    const keptSkills = (kept ?? []).filter((s) => skillMatches(s, query))
    const builtIn = (skillList?.builtIn ?? []).filter((s) =>
      `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    return (
      <>
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
      </>
    )
  }

  return (
    <ManagePage
      title="插件市场"
      intro="给你的 Agent 用的技能，来自你所用工具的开发者，以及社区。"
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
                key: 'skill',
                label: '来自 GitHub 的技能…',
                detail: '一个仓库，或仓库中的一个文件夹',
                onPress: () => setSheet('skill'),
              },
            ]}
            onClose={() => setSheet((s) => (s === 'add' ? null : s))}
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
        placeholder="搜索插件市场"
        clearButtonMode="while-editing"
        returnKeyType="search"
        accessibilityLabel="搜索插件市场"
        style={styles.search}
      />
      {tab === 'installed' ? installed() : directory()}
      <FieldNote>插件、发布、工作流和 MCP 服务器目录在电脑上的纸鸢里管理。</FieldNote>
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

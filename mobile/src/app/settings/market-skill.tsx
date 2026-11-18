// A skill: from the catalog, or one Huli keeps. Its publisher, licence and the tools it may use
// without asking; adding it for some agents or all, and for a kept one its switch, the agents it
// goes to and Remove.

import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { displayTitle, type CatalogSkill, type MarketSkill } from '@shared/marketplace'
import { useHost } from '../../host'
import {
  Button,
  Buttons,
  call,
  Code,
  confirm,
  FieldLabel,
  FieldNote,
  FormSheet,
  ManagePage,
  ReadState,
  SwitchRow,
  Tag,
  useActions,
} from '../../manage/kit'
import {
  AgentChoicePicker,
  TRUST_TEXT,
  trustOf,
  useAgentName,
  useChoosableAgents,
  useKeptSkills,
  useMarketSkills,
  type AgentChoice,
} from '../../manage/market'
import { BottomSheet } from '../../ui/BottomSheet'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

const SOURCE_TEXT: Record<MarketSkill['source'], string> = {
  catalog: '技能目录',
  github: 'GitHub',
  local: '文件夹',
  kettu: 'Marketplace',
}

export default function MarketSkillPage() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = params.id ?? ''
  const { c } = useTokens()
  const host = useHost()
  const skills = useMarketSkills()
  const { settings, kept, save } = useKeptSkills()
  const actions = useActions()
  const agentName = useAgentName()
  const [adding, setAdding] = useState(false)
  const [choosing, setChoosing] = useState(false)

  const catalog: CatalogSkill | null = skills.read.value?.catalog.find((s) => s.id === id) ?? null
  const mine: MarketSkill | null = kept?.find((s) => s.id === id) ?? null
  const name = mine?.name ?? catalog?.name ?? ''
  const title = displayTitle(name)
  const refresh = () => Promise.all([skills.refresh(), settings.reload()]).then(() => {})

  if (!catalog && !mine) {
    return (
      <ManagePage title="技能" onRefresh={refresh}>
        {skills.read.value === null ? (
          <ReadState read={skills.read} what="技能" icon="sparkles" rows={3} />
        ) : settings.value === null ? (
          <ReadState read={settings} what="技能" icon="sparkles" rows={3} />
        ) : (
          <EmptyState
            icon="sparkles"
            title="找不到这个技能"
            message="它可能已从技能目录下架，或者已被移除。"
            action={{ label: '返回 Marketplace', onPress: () => router.back() }}
          />
        )}
      </ManagePage>
    )
  }

  const taken =
    !mine && catalog
      ? (kept?.find((s) => s.name === catalog.name && s.id !== catalog.id) ?? null)
      : null
  const takenFrom = taken
    ? (skills.read.value?.catalog.find((s) => s.id === taken.id)?.publisher ?? taken.origin)
    : null
  const tools = catalog?.allowedTools ?? []
  const repository = catalog?.repository ?? (mine?.source === 'github' ? mine.origin : null)

  const change = (key: string, next: (skill: MarketSkill) => MarketSkill) =>
    actions.run(
      key,
      () => save((list) => list.map((s) => (s.id === id ? next(s) : s))),
      `无法修改 ${name}`,
    )

  const remove = async () => {
    const yes = await confirm({
      title: `移除 ${title}？`,
      message: 'Agent 的新会话将不再带上它，它的文件也会从电脑上删除。',
      confirm: '移除',
    })
    if (!yes) return
    const done = await actions.run(
      'remove',
      () => save((list) => list.filter((s) => s.id !== id)),
      `无法移除 ${name}`,
    )
    if (done) router.back()
  }

  return (
    <ManagePage
      title={title}
      onRefresh={refresh}
      overlay={
        <>
          {catalog ? (
            <AddSheet
              visible={adding}
              skill={catalog}
              tools={tools}
              onClose={() => setAdding(false)}
              onAdd={async (agents) => {
                if (!host.link) throw new Error('电脑没有连上。')
                const copied = await call(host.link, 'market.addSkill', {
                  source: { kind: 'catalog', id: catalog.id },
                })
                await save((list) => [
                  ...list.filter((s) => s.id !== copied.id),
                  { ...copied, agents, on: true },
                ])
              }}
            />
          ) : null}
          {mine ? (
            <AgentsSheet
              visible={choosing}
              title={`${title} 用于哪些 Agent`}
              value={mine.agents}
              onClose={() => setChoosing(false)}
              onSave={(agents) => change('agents', (s) => ({ ...s, agents }))}
            />
          ) : null}
        </>
      }
    >
      <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.heroHead}>
          <View style={[styles.tile, { backgroundColor: c.fill }]}>
            <Icon name="sparkles" size={26} color={c.textSecondary} />
          </View>
          <View style={styles.flex}>
            <Text style={[typeScale.title, { color: c.text }]} numberOfLines={2}>
              {title}
            </Text>
            <View style={styles.byline}>
              <Text
                style={[typeScale.footnote, styles.shrink, { color: c.textSecondary }]}
                numberOfLines={1}
              >
                {catalog?.publisher ?? mine?.origin ?? ''}
              </Text>
              {catalog ? (
                <Tag
                  label={TRUST_TEXT[trustOf(catalog)]}
                  tone={trustOf(catalog) === 'community' ? 'neutral' : 'tint'}
                />
              ) : null}
              {mine ? <Tag label="已安装" tone="success" /> : null}
            </View>
          </View>
        </View>
        {(mine?.description ?? catalog?.description) ? (
          <Text style={[typeScale.callout, { color: c.text }]} selectable>
            {mine?.description ?? catalog?.description}
          </Text>
        ) : null}
        {!mine && catalog ? (
          <Buttons>
            <Button
              label="添加"
              tone="primary"
              icon="plus"
              disabled={host.state.kind !== 'connected' || !!taken || settings.value === null}
              onPress={() => setAdding(true)}
            />
          </Buttons>
        ) : null}
        {taken ? (
          <FieldNote error>
            {`已经添加过名为 ${taken.name} 的技能，来自 ${takenFrom}。先移除它：同名的两个技能，Agent 只会保留一个。`}
          </FieldNote>
        ) : null}
      </View>

      {mine ? (
        <ListGroup>
          <SwitchRow
            title={`启用 ${title}`}
            value={mine.on}
            busy={actions.busy('on')}
            onChange={(on) => void change('on', (s) => ({ ...s, on }))}
          />
          <ListRow
            title="用于"
            value={
              mine.agents === 'all'
                ? '所有 Agent'
                : mine.agents.map((agent) => agentName(agent)).join('、')
            }
            chevron
            disabled={actions.busy('agents')}
            onPress={() => setChoosing(true)}
          />
        </ListGroup>
      ) : null}

      <ListGroup footer="Agent 只在任务需要时才读取技能，在那之前几乎不占用上下文。">
        {mine ? <ListRow title="来源" value={SOURCE_TEXT[mine.source]} /> : null}
        {mine && mine.source !== 'catalog' ? <ListRow title="复制自" value={mine.origin} /> : null}
        {catalog ? <ListRow title="文件夹" value={catalog.path} /> : null}
        {catalog?.license ? <ListRow title="许可证" value={catalog.license} /> : null}
        {(mine?.version ?? catalog?.version) ? (
          <ListRow title="版本" value={(mine?.version ?? catalog?.version ?? '').slice(0, 12)} />
        ) : null}
        {repository ? (
          <ListRow title="源代码" external onPress={() => void Linking.openURL(repository)} />
        ) : null}
      </ListGroup>

      {tools.length > 0 ? (
        <View style={styles.tools}>
          <FieldLabel>不经询问就能用的工具</FieldLabel>
          <Code>{tools.join('\n')}</Code>
        </View>
      ) : null}

      {mine ? (
        <ListGroup>
          <ListRow
            title="移除…"
            destructive
            disabled={actions.busy('remove')}
            onPress={() => void remove()}
          />
        </ListGroup>
      ) : null}
    </ManagePage>
  )
}

/** Adding a catalog skill: the tools it may use without asking, then the agents it goes to. */
function AddSheet(props: {
  visible: boolean
  skill: CatalogSkill
  tools: string[]
  onClose(): void
  onAdd(agents: AgentChoice): Promise<void>
}) {
  const agents = useChoosableAgents()
  const [choice, setChoice] = useState<AgentChoice>('all')
  useEffect(() => {
    if (props.visible) setChoice('all')
  }, [props.visible])
  return (
    <FormSheet
      visible={props.visible}
      onClose={props.onClose}
      title={`安装 ${displayTitle(props.skill.name)}`}
      message="由纸鸢保存在电脑上，在会话开始时交给这些 Agent。"
      submitLabel="安装"
      onSubmit={() => props.onAdd(choice)}
    >
      {props.tools.length > 0 ? (
        <>
          <FieldLabel>让 Agent 不经询问就能使用这些工具</FieldLabel>
          <Code>{props.tools.join('\n')}</Code>
        </>
      ) : null}
      <FieldLabel>用于</FieldLabel>
      <AgentChoicePicker agents={agents} value={choice} onChange={setChoice} />
    </FormSheet>
  )
}

/** Which agents a kept skill goes to: all of them, or the ones ticked. */
function AgentsSheet(props: {
  visible: boolean
  title: string
  value: AgentChoice
  onClose(): void
  onSave(agents: AgentChoice): Promise<boolean>
}) {
  const agents = useChoosableAgents()
  const [choice, setChoice] = useState<AgentChoice>(props.value)
  useEffect(() => {
    if (props.visible) setChoice(props.value)
  }, [props.visible, props.value])
  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      message="这些 Agent 的新会话会用上它；已打开的会话保持原样。"
    >
      <AgentChoicePicker agents={agents} value={choice} onChange={setChoice} />
      <Buttons style={styles.save}>
        <Button
          label="保存"
          tone="primary"
          wide
          onPress={() => {
            props.onClose()
            void props.onSave(choice)
          }}
        />
      </Buttons>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 4 },
  shrink: { flexShrink: 1 },
  hero: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.md,
  },
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tile: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  byline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tools: { gap: space.sm },
  save: { marginTop: space.sm },
})

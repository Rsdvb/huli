// Settings › 记忆: the switch, global memory and one project's, each entry opening a page of its own,
// and an offer to import what the agents remember on their own while there is any.

import { useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { MemoryEntry, MemoryImportScan, MemoryOverview, MemoryScope } from '@shared/memory'
import { Sheet } from '../../components/Sheet'
import { useHost } from '../../host'
import {
  Button,
  call,
  errorText,
  Field,
  GroupNote,
  ManagePage,
  Notice,
  ReadState,
  SkeletonGroup,
  SwitchRow,
  useConnected,
  useRead,
  type Read,
} from '../../manage/kit'
import { EntryEditor, memoryCall, scopeParam, useEntryLine } from '../../manage/memory'
import { AgentGlyph } from '../../ui/AgentAvatar'
import { BottomSheet } from '../../ui/BottomSheet'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { Press } from '../../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

const GLOBAL: MemoryScope = { layer: 'global' }
const CHANGED = ['memory.changed'] as const
/** A layer longer than this lists its latest `SHORT` entries and a row that shows the rest. */
const LONG = 12
const SHORT = 10

export default function MemorySettings() {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const overview = useRead<MemoryOverview>(
    'overview',
    (link) => memoryCall(() => call(link, 'memory.overview', undefined)),
    CHANGED,
  )
  const projects = overview.value?.projects ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const project =
    projects.find((p) => p.path === chosen) ??
    projects.find((p) => p.count > 0) ??
    projects[0] ??
    null
  const projectScope = useMemo<MemoryScope | null>(
    () => (project ? { layer: 'project', project: project.path } : null),
    [project],
  )
  const entries = useRead<MemoryEntry[]>(
    projectScope ? `project\n${scopeParam(projectScope)}` : null,
    (link) =>
      memoryCall(() =>
        call(link, 'memory.list', { scope: projectScope ?? GLOBAL }).then((list) =>
          [...list].sort((a, b) => b.updatedAt - a.updatedAt),
        ),
      ),
    CHANGED,
  )
  const [query, setQuery] = useState('')
  const [allOf, setAllOf] = useState<string | null>(null)
  const [switching, setSwitching] = useState<boolean | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [adding, setAdding] = useState<MemoryScope | null>(null)
  const line = useEntryLine()

  const needle = query.trim().toLowerCase()
  const matches = (entry: MemoryEntry) =>
    needle === '' ||
    `${entry.title}\n${entry.description}\n${entry.body}`.toLowerCase().includes(needle)

  const read = overview.value
  const setEnabled = async (enabled: boolean) => {
    if (!host.link) return
    setSwitching(enabled)
    try {
      await memoryCall(() => call(host.link!, 'memory.setEnabled', { enabled }))
      overview.set((o) => ({ ...o, enabled }))
    } catch (failure) {
      haptic.warning()
      setSwitchError(errorText(failure))
    } finally {
      setSwitching(null)
    }
  }

  const open = (scope: MemoryScope, entry: MemoryEntry) =>
    router.push({
      pathname: '/settings/memory-entry',
      params: { scope: scopeParam(scope), id: entry.id },
    })

  const entryRow = (scope: MemoryScope, entry: MemoryEntry) => (
    <ListRow
      key={entry.id}
      title={entry.title}
      subtitle={[entry.description, line(entry)].filter(Boolean).join('\n')}
      leading={
        <View style={[styles.who, { backgroundColor: c.fill }]}>
          {entry.source.agentId ? (
            <AgentGlyph agentId={entry.source.agentId} size={15} />
          ) : (
            <Icon name="person" size={14} color={c.textSecondary} />
          )}
        </View>
      }
      chevron
      onPress={() => open(scope, entry)}
    />
  )

  const globalShown = read ? read.global.filter(matches) : []
  const projectList = entries.value
  const projectFound = projectList ? projectList.filter(matches) : []
  const short =
    needle === '' && project !== null && allOf !== project.path && projectFound.length > LONG
  const projectShown = short ? projectFound.slice(0, SHORT) : projectFound

  return (
    <ManagePage
      title="记忆"
      intro="Agent 记下的关于你和各个项目的事，存在电脑上，交给每个 Agent。"
      onRefresh={() => Promise.all([overview.reload(), entries.reload()])}
      overlay={
        <>
          <Sheet
            visible={picking}
            title="项目"
            items={projects.map((p) => ({
              key: p.path,
              label: p.name,
              detail: `${p.count} 条`,
              checked: p.path === project?.path,
              onPress: () => {
                haptic.select()
                setChosen(p.path)
              },
            }))}
            onClose={() => setPicking(false)}
          />
          <ImportSheet
            visible={importing}
            onClose={() => setImporting(false)}
            onDone={() => void overview.reload()}
          />
          <EntryEditor
            visible={adding !== null}
            scope={adding ?? GLOBAL}
            entry={null}
            onClose={() => setAdding(null)}
            onSaved={() => {
              void overview.reload()
              void entries.reload()
            }}
          />
        </>
      }
    >
      {read === null ? (
        <ReadState read={overview} what="记忆" icon="brain" rows={3} />
      ) : (
        <>
          <ListGroup
            footer={
              switchError ??
              (read.enabled
                ? '打开时，每个 Agent 开会话都会拿到记忆，也能往里记。在纸鸢的会话里，Harness 自己的记忆会关掉。'
                : '已关上：各 Agent 回到自己原来的记忆，由各自的 Harness 保存。')
            }
          >
            <SwitchRow
              title="使用记忆"
              icon="brain"
              value={switching ?? read.enabled}
              busy={switching !== null}
              disabled={!connected}
              onChange={(on) => {
                setSwitchError(null)
                void setEnabled(on)
              }}
            />
          </ListGroup>

          {read.importable > 0 ? (
            <Notice
              title={`在 Agent 自己的记忆里找到 ${read.importable} 条`}
              actions={
                <Button
                  label="导入…"
                  tone="primary"
                  disabled={!connected}
                  onPress={() => setImporting(true)}
                />
              }
            >
              把它们导入纸鸢的记忆，每个 Agent 都能用上。原来的记忆保持不变。
            </Notice>
          ) : null}

          <View style={[styles.search, { backgroundColor: c.fill }]}>
            <Icon name="search" size={16} color={c.textTertiary} />
            <Field
              value={query}
              onChangeText={setQuery}
              placeholder="搜索记忆"
              accessibilityLabel="搜索记忆"
              clearButtonMode="while-editing"
              returnKeyType="search"
              style={styles.searchField}
            />
          </View>

          <View style={styles.layer}>
            <LayerHead
              title="全局"
              count={read.global.length}
              onAdd={read.global.length > 0 && connected ? () => setAdding(GLOBAL) : undefined}
            />
            {read.global.length === 0 && needle === '' ? (
              <EmptyLayer
                title="全局记忆里还没有内容"
                hint="Agent 会在工作中记下关于你的事，记之前会先问你。你也可以自己添加。"
                onAdd={connected ? () => setAdding(GLOBAL) : undefined}
              />
            ) : globalShown.length === 0 ? (
              <GroupNote>{`没有和“${query.trim()}”匹配的记忆`}</GroupNote>
            ) : (
              <ListGroup>{globalShown.map((entry) => entryRow(GLOBAL, entry))}</ListGroup>
            )}
          </View>

          <View style={styles.layer}>
            <LayerHead
              title="项目"
              count={projectList?.length ?? 0}
              picker={project ? project.name : undefined}
              onPick={projects.length > 1 ? () => setPicking(true) : undefined}
              onAdd={
                projectScope && projectList && projectList.length > 0 && connected
                  ? () => setAdding(projectScope)
                  : undefined
              }
            />
            {!project || !projectScope ? (
              <EmptyLayer title="还没有项目" hint="打开项目后，Agent 会在工作中记下关于它的事。" />
            ) : projectList === null ? (
              entries.error !== null ? (
                <Notice
                  tone="error"
                  title={`没能读取记忆：${entries.error}`}
                  actions={<Button label="重试" onPress={() => void entries.reload()} />}
                />
              ) : (
                <SkeletonGroup rows={3} header={false} />
              )
            ) : projectList.length === 0 ? (
              <EmptyLayer
                title={`还没有记下「${project.name}」的事`}
                hint="Agent 会在工作中记下怎么运行它、踩过的坑和做过的决定。你也可以自己添加。"
                onAdd={connected ? () => setAdding(projectScope) : undefined}
              />
            ) : projectFound.length === 0 ? (
              <GroupNote>{`没有和“${query.trim()}”匹配的记忆`}</GroupNote>
            ) : (
              <ListGroup>
                {projectShown.map((entry) => entryRow(projectScope, entry))}
                {short ? (
                  <ListRow
                    key="more"
                    title={`再显示 ${projectFound.length - projectShown.length} 条`}
                    action
                    onPress={() => setAllOf(project.path)}
                  />
                ) : null}
              </ListGroup>
            )}
          </View>
        </>
      )}
    </ManagePage>
  )
}

/** A layer's heading: its name and count, the project it shows, and Add. */
function LayerHead(props: {
  title: string
  count: number
  picker?: string
  onPick?: () => void
  onAdd?: () => void
}) {
  const { c } = useTokens()
  return (
    <View style={styles.head}>
      <Text style={[typeScale.headline, { color: c.textSecondary }]} accessibilityRole="header">
        {props.title}
        {props.count > 0 ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}> {props.count}</Text>
        ) : null}
      </Text>
      <View style={styles.headEnd}>
        {props.picker ? (
          <Press
            onPress={props.onPick}
            disabled={!props.onPick}
            accessibilityRole="button"
            accessibilityLabel={`项目：${props.picker}`}
            style={[styles.picker, { backgroundColor: c.fill }]}
          >
            <Text style={[typeScale.subhead, { color: c.text }]} numberOfLines={1}>
              {props.picker}
            </Text>
            {props.onPick ? (
              <Icon name="upDown" size={12} color={c.textTertiary} weight="semibold" />
            ) : null}
          </Press>
        ) : null}
        {props.onAdd ? (
          <Press
            onPress={props.onAdd}
            accessibilityRole="button"
            accessibilityLabel="添加"
            hitSlop={8}
            style={[styles.add, { backgroundColor: c.fill }]}
          >
            <Icon name="plus" size={15} color={c.tint} weight="semibold" />
          </Press>
        ) : null}
      </View>
    </View>
  )
}

function EmptyLayer(props: { title: string; hint: string; onAdd?: () => void }) {
  const { c } = useTokens()
  return (
    <View style={[styles.empty, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[typeScale.headline, { color: c.text }]}>{props.title}</Text>
      <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{props.hint}</Text>
      {props.onAdd ? (
        <Button label="添加" icon="plus" tone="primary" onPress={props.onAdd} />
      ) : null}
    </View>
  )
}

const entryCount = (scan: MemoryImportScan): number =>
  scan.sources.reduce((sum, source) => sum + source.entries.length, 0)

/**
 * The import: how many entries each agent remembers of each project, then those about the user,
 * each to put in global memory if switched on. Nothing starts switched on.
 */
function ImportSheet(props: { visible: boolean; onClose(): void; onDone(): void }) {
  const { c } = useTokens()
  const host = useHost()
  const scan: Read<MemoryImportScan> = useRead(props.visible ? 'import' : null, (link) =>
    memoryCall(() => call(link, 'memory.importScan', undefined)),
  )
  const [global, setGlobal] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const found = scan.value
  const aboutUser = found?.sources.flatMap((s) => s.entries.filter((e) => e.aboutUser)) ?? []
  const total = found ? entryCount(found) : 0

  const close = () => {
    props.onClose()
    setGlobal(new Set())
    setFailure(null)
    setDone(null)
  }

  const run = async () => {
    if (!found || busy || !host.link) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await memoryCall(() =>
        call(host.link!, 'memory.import', {
          sources: found.sources.map((s) => ({ agentId: s.agentId, project: s.project })),
          global: aboutUser.filter((e) => global.has(e.key)).map((e) => e.key),
        }),
      )
      haptic.success()
      setDone(
        result.skipped > 0
          ? `导入了 ${result.imported} 条，跳过了 ${result.skipped} 条重复的`
          : `导入了 ${result.imported} 条`,
      )
      props.onDone()
    } catch (caught) {
      haptic.warning()
      setFailure(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={close}
      title="导入 Agent 的记忆"
      message="这些是各 Agent 自己记下的、关于纸鸢里已有项目的事。每条会放进它所属项目的记忆，原来的保持不变。"
      maxHeight={640}
    >
      {done ? (
        <Notice tone="success" title={done} actions={<Button label="完成" onPress={close} />} />
      ) : found === null ? (
        scan.error !== null ? (
          <Notice
            tone="error"
            title={`没能读取 Agent 的记忆：${scan.error}`}
            actions={<Button label="重试" onPress={() => void scan.reload()} />}
          />
        ) : (
          <SkeletonGroup rows={2} header={false} />
        )
      ) : total === 0 ? (
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>没有要导入的了。</Text>
      ) : (
        <>
          <Text style={[typeScale.footnote, styles.sheetLabel, { color: c.textSecondary }]}>
            按 Agent 和项目
          </Text>
          <View style={[styles.sheetGroup, { backgroundColor: c.fill }]}>
            {found.sources.map((source) => (
              <View key={`${source.agentId}\n${source.project}`} style={styles.sheetRow}>
                <AgentGlyph agentId={source.agentId} name={source.agentName} size={16} />
                <Text style={[typeScale.body, styles.flex, { color: c.text }]} numberOfLines={1}>
                  {source.agentName} · {source.projectName}
                </Text>
                <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                  {source.entries.length} 条
                </Text>
              </View>
            ))}
          </View>
          {aboutUser.length > 0 ? (
            <>
              <Text style={[typeScale.footnote, styles.sheetLabel, { color: c.textSecondary }]}>
                关于你本人的
              </Text>
              <View style={[styles.sheetGroup, { backgroundColor: c.fill }]}>
                {aboutUser.map((entry) => (
                  <View key={entry.key} style={styles.sheetRow}>
                    <View style={styles.flex}>
                      <Text style={[typeScale.body, { color: c.text }]}>{entry.title}</Text>
                      {entry.description ? (
                        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                          {entry.description}
                        </Text>
                      ) : null}
                    </View>
                    <Switch
                      value={global.has(entry.key)}
                      disabled={busy}
                      onValueChange={(on) => {
                        haptic.select()
                        setGlobal((current) => {
                          const next = new Set(current)
                          if (on) next.add(entry.key)
                          else next.delete(entry.key)
                          return next
                        })
                      }}
                      trackColor={{ true: c.success }}
                      accessibilityLabel={`放进全局：${entry.title}`}
                    />
                  </View>
                ))}
              </View>
              <Text style={[typeScale.footnote, styles.sheetLabel, { color: c.textTertiary }]}>
                勾选的会放进全局记忆，每个会话都会用到；其余的放进所属项目的记忆。
              </Text>
            </>
          ) : null}
          {failure ? (
            <Text style={[typeScale.footnote, { color: c.danger }]} selectable>
              {failure}
            </Text>
          ) : null}
          <Press
            onPress={() => void run()}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.submit, { backgroundColor: c.accent }]}
          >
            {busy ? (
              <ActivityIndicator color={c.onAccent} />
            ) : (
              <Text style={[typeScale.headline, { color: c.onAccent }]}>导入</Text>
            )}
          </Press>
        </>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  layer: { gap: space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginLeft: space.lg,
    gap: space.sm,
  },
  headEnd: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    flexShrink: 1,
  },
  add: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  who: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.md + 2,
    borderRadius: radius.md,
  },
  searchField: { flex: 1, backgroundColor: 'transparent' },
  empty: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
    alignItems: 'flex-start',
  },
  sheetLabel: { marginLeft: space.xs },
  sheetGroup: { borderRadius: radius.lg, overflow: 'hidden' },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
})

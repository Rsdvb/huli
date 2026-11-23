// Huli: the recycle bin (回收站), the latest deletion first, with a kind filter and a search: swipe
// right to restore, left to delete for good; a tap offers both, and 选择 picks several. Deleting for
// good and emptying it ask twice on the phone. It reads the bin only while this screen shows.

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Animated, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { HostEvent } from '@shared/agent-host'
import {
  BIN_DAY_MS,
  BIN_KINDS,
  type BinItem,
  type BinKind,
  type BinList,
  type BinProjectChoice,
} from '@shared/recycle-bin'
import { Sheet } from '../components/Sheet'
import { call } from '../git'
import { useHost } from '../host'
import { errorText } from '../sessions'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { Icon, type IconName } from '../ui/Icon'
import { LargeTitle } from '../ui/LargeTitle'
import { NavBar } from '../ui/NavBar'
import { showNotice } from '../ui/NoticeBar'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { usePullRefresh } from '../ui/PullRefresh'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { SkeletonRows } from '../ui/Skeleton'
import { SwipeRow } from '../ui/SwipeRow'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

const KIND_TEXT: Record<BinKind, string> = {
  session: '会话',
  folder: '会话文件夹',
  project: '项目',
  task: '任务',
  routine: '定时任务',
  workflow: '工作流',
  memory: '记忆',
  artifact: '产物',
}

const KIND_ICON: Record<BinKind, IconName> = {
  session: 'message',
  folder: 'folder',
  project: 'box',
  task: 'check',
  routine: 'history',
  workflow: 'flow',
  memory: 'brain',
  artifact: 'canvas',
}

type Filter = BinKind | 'all'

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function agoText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function factsOf(item: BinItem, projectName: (path: string) => string): string {
  const parts = [KIND_TEXT[item.kind]]
  if (item.kind === 'memory' && item.scope === 'global') parts.push('全局记忆')
  else if (item.kind === 'session' && !item.projectPath) parts.push('无项目')
  else if (item.projectPath && item.kind !== 'project') parts.push(projectName(item.projectPath))
  if (item.count)
    parts.push(item.kind === 'session' ? `含 ${item.count} 个子会话` : `含 ${item.count} 个会话`)
  if (item.size !== null) parts.push(sizeText(item.size))
  return parts.join(' · ')
}

function whenText(item: BinItem, now: number): string {
  const left =
    item.purgeAt === null
      ? '不会自动删除'
      : `${Math.max(1, Math.ceil((item.purgeAt - now) / BIN_DAY_MS))} 天后永久删除`
  const project =
    item.project === 'binned'
      ? ' · 项目也在回收站里'
      : item.project === 'gone'
        ? ' · 项目已不在了'
        : ''
  return `${agoText(item.deletedAt, now)}删除 · ${left}${project}`
}

/** Asks twice before something is deleted for good from the phone. */
function confirmTwice(title: string, message: string, confirm: string, run: () => void): void {
  haptic.warning()
  Alert.alert(title, message, [
    { text: '取消', style: 'cancel' },
    {
      text: confirm,
      style: 'destructive',
      onPress: () =>
        Alert.alert('真的要永久删除吗？', '删除后在电脑和手机上都找不回来。', [
          { text: '取消', style: 'cancel' },
          { text: '永久删除', style: 'destructive', onPress: run },
        ]),
    },
  ])
}

export default function RecycleBin() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(() => load(), header)
  const insets = useSafeAreaInsets()
  const [list, setList] = useState<BinList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<BinItem | null>(null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [now, setNow] = useState(Date.now)
  const connected = host.state.kind === 'connected'

  const load = useCallback(async () => {
    if (!host.link) return
    try {
      setList(await call(host.link, 'bin.list', undefined))
      setNow(Date.now())
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [host.link])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  useEffect(() => {
    if (!host.link) return
    return host.link.onHostEvent((raw: unknown) => {
      if ((raw as HostEvent).type === 'bin.changed') void load()
    })
  }, [host.link, load])

  const projects = host.projects
  const projectName = useCallback(
    (path: string) => projects.find((p) => p.path === path)?.name ?? baseName(path),
    [projects],
  )

  const items = useMemo(() => list?.items ?? [], [list])
  const counts = useMemo(() => {
    const out = new Map<Filter, number>([['all', items.length]])
    for (const item of items) out.set(item.kind, (out.get(item.kind) ?? 0) + 1)
    return out
  }, [items])
  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.kind === filter) &&
          (needle === '' || (item.title ?? '').toLowerCase().includes(needle)),
      ),
    [items, filter, needle],
  )
  const chosen = shown.filter((item) => picked.has(item.key))

  const restore = (targets: BinItem[], project?: BinProjectChoice) => {
    if (!host.link || targets.length === 0) return
    call(host.link, 'bin.restore', {
      keys: targets.map((item) => item.key),
      ...(project ? { project } : {}),
    }).then(
      (result) => {
        haptic.success()
        setPicked(new Set())
        if (result.restored.length > 0) {
          showNotice({ text: `已恢复 ${targets.length - result.held.length} 项` })
        }
        if (result.held.length === 0) return
        const held = targets.filter((item) => result.held.some((h) => h.key === item.key))
        const binned = result.held.some((h) => h.project === 'binned')
        const name = baseName(result.held[0]!.projectPath)
        Alert.alert(
          held.length > 1
            ? `${held.length} 个会话的项目已被移除`
            : `“${held[0]?.title || '未命名'}”的项目已被移除`,
          binned
            ? `项目“${name}”也在回收站里。可以把项目一起恢复，或者把会话放到「无项目」下。`
            : `项目“${name}”已不在纸鸢里。可以重新添加这个项目，或者把会话放到「无项目」下。`,
          [
            { text: '取消', style: 'cancel' },
            { text: '放到「无项目」', onPress: () => restore(held, 'noProject') },
            {
              text: binned ? '一起恢复项目' : '重新添加项目',
              onPress: () => restore(held, 'restore'),
            },
          ],
        )
      },
      (failure: unknown) => Alert.alert('没能恢复', errorText(failure)),
    )
  }

  const purge = (targets: BinItem[]) => {
    if (targets.length === 0) return
    const one = targets.length === 1 ? targets[0] : undefined
    confirmTwice(
      one ? `永久删除“${one.title || '未命名'}”？` : `永久删除 ${targets.length} 项？`,
      '删除后无法恢复。会话在 Agent 自己本地历史里的那份也会一起删除。',
      '永久删除',
      () => {
        host.link?.request('bin.purge', { keys: targets.map((item) => item.key) }).then(
          () => {
            setPicked(new Set())
            showNotice({ text: `已永久删除 ${targets.length} 项` })
          },
          (failure: unknown) => Alert.alert('没能删除', errorText(failure)),
        )
      },
    )
  }

  const empty = () =>
    confirmTwice(
      `清空回收站里的 ${items.length} 项？`,
      '它们都会被永久删除，无法恢复。',
      '清空',
      () => {
        host.link?.request('bin.empty', undefined).then(
          () => showNotice({ text: '回收站已清空' }),
          (failure: unknown) => Alert.alert('没能清空', errorText(failure)),
        )
      },
    )

  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const keepDays = list?.keepDays
  const placeholder = () => {
    if (!connected && !list) return <EmptyState icon="trash" title="连上电脑后才能看回收站" />
    if (error && !list) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到回收站"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!list) return <SkeletonRows count={5} />
    if (items.length > 0) return <EmptyState icon="search" title="没有符合的项" />
    return (
      <EmptyState
        icon="trash"
        title="回收站是空的"
        message={
          keepDays === null
            ? '删掉的会话、项目、任务、记忆等会一直留在这里，直到你彻底删除。'
            : `删掉的会话、项目、任务、记忆等会在这里保留 ${keepDays ?? 30} 天。`
        }
      />
    )
  }

  const filters: Filter[] = ['all', ...BIN_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0)]

  return (
    <Screen>
      <Animated.FlatList
        data={shown}
        keyExtractor={(item) => item.key}
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + (picking ? 96 : space.xxxl),
        }}
        refreshControl={pull}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View style={styles.pad}>
            <LargeTitle
              title="回收站"
              subtitle={
                keepDays === null
                  ? '删掉的东西先放在这里，不会自动清空。右滑恢复，左滑永久删除。'
                  : `删掉的东西先放在这里，${keepDays ?? 30} 天后永久删除。右滑恢复，左滑永久删除。`
              }
            />
            {items.length > 0 ? (
              <>
                <View style={[styles.search, { backgroundColor: c.fill }]}>
                  <Icon name="search" size={16} color={c.textSecondary} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="搜索回收站"
                    placeholderTextColor={c.textTertiary}
                    autoCorrect={false}
                    autoCapitalize="none"
                    clearButtonMode="while-editing"
                    accessibilityLabel="搜索回收站"
                    style={[typeScale.body, styles.input, { color: c.text }]}
                  />
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chips}
                >
                  {filters.map((kind) => (
                    <Pill
                      key={kind}
                      size="sm"
                      tone={filter === kind ? 'tint' : 'fill'}
                      label={`${kind === 'all' ? '全部' : KIND_TEXT[kind]} ${counts.get(kind) ?? 0}`}
                      onPress={() => {
                        haptic.select()
                        setFilter(kind)
                      }}
                    />
                  ))}
                </ScrollView>
              </>
            ) : null}
          </View>
        }
        ListEmptyComponent={<View style={styles.pad}>{placeholder()}</View>}
        ListFooterComponent={
          items.length > 0 && connected ? (
            <View style={styles.footer}>
              <Press onPress={empty} accessibilityRole="button" style={styles.emptyButton}>
                <Text style={[typeScale.body, { color: c.danger }]}>清空回收站…</Text>
              </Press>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <BinRow
            item={item}
            facts={factsOf(item, projectName)}
            when={whenText(item, now)}
            connected={connected}
            picking={picking}
            picked={picked.has(item.key)}
            onPress={() => (picking ? toggle(item.key) : setMenu(item))}
            onRestore={() => restore([item])}
            onPurge={() => purge([item])}
          />
        )}
      />
      <NavBar
        header={header}
        title="回收站"
        right={
          items.length > 0 ? (
            <Press
              onPress={() => {
                haptic.select()
                setPicking((on) => !on)
                setPicked(new Set())
              }}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={[typeScale.body, { color: c.tint }]}>{picking ? '完成' : '选择'}</Text>
            </Press>
          ) : null
        }
      />
      {picking ? (
        <View
          style={[
            styles.bar,
            {
              paddingBottom: insets.bottom + space.sm,
              backgroundColor: c.surfaceRaised,
              borderColor: c.border,
            },
          ]}
        >
          <Press
            onPress={() => setPicked(new Set(shown.map((item) => item.key)))}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[typeScale.body, { color: c.tint }]}>全选</Text>
          </Press>
          <Text style={[typeScale.footnote, styles.barCount, { color: c.textSecondary }]}>
            已选 {chosen.length} 项
          </Text>
          <Press
            disabled={!connected || chosen.length === 0}
            onPress={() => restore(chosen)}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[typeScale.body, { color: chosen.length ? c.tint : c.textTertiary }]}>
              恢复
            </Text>
          </Press>
          <Press
            disabled={!connected || chosen.length === 0}
            onPress={() => purge(chosen)}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[typeScale.body, { color: chosen.length ? c.danger : c.textTertiary }]}>
              永久删除
            </Text>
          </Press>
        </View>
      ) : null}
      <Sheet
        visible={menu !== null}
        title={menu?.title || '未命名'}
        items={
          menu
            ? [
                {
                  key: 'restore',
                  label: '恢复',
                  disabled: !connected,
                  onPress: () => restore([menu]),
                },
                {
                  key: 'delete',
                  label: '永久删除',
                  destructive: true,
                  disabled: !connected,
                  onPress: () => purge([menu]),
                },
              ]
            : []
        }
        onClose={() => setMenu(null)}
      />
    </Screen>
  )
}

const BinRow = memo(function BinRow(props: {
  item: BinItem
  facts: string
  when: string
  connected: boolean
  picking: boolean
  picked: boolean
  onPress: () => void
  onRestore: () => void
  onPurge: () => void
}) {
  const { c } = useTokens()
  const { item } = props
  const row = (
    <Press
      onPress={props.onPress}
      scale={false}
      accessibilityRole="button"
      accessibilityHint={props.picking ? '选择或取消选择' : '恢复或永久删除'}
      accessibilityState={props.picking ? { selected: props.picked } : undefined}
      style={[styles.row, { backgroundColor: c.bg }]}
    >
      {props.picking ? (
        <View
          style={[
            styles.check,
            {
              borderColor: props.picked ? c.tint : c.border,
              backgroundColor: props.picked ? c.tint : 'transparent',
            },
          ]}
        >
          {props.picked ? <Icon name="check" size={14} color={c.onAccent} /> : null}
        </View>
      ) : null}
      <View style={[styles.tile, { backgroundColor: c.fill }]}>
        <Icon name={KIND_ICON[item.kind]} size={20} color={c.textSecondary} />
      </View>
      <View style={styles.body}>
        <Text style={[typeScale.rowTitle, { color: c.text }]} numberOfLines={1}>
          {item.title || '未命名'}
        </Text>
        <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={1}>
          {props.facts}
        </Text>
        <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
          {props.when}
        </Text>
      </View>
    </Press>
  )
  if (props.picking || !props.connected) return row
  return (
    <SwipeRow
      start={{ label: '恢复', icon: 'restore', color: c.tint, onPress: props.onRestore }}
      end={{ label: '删除', icon: 'trash', color: c.danger, onPress: props.onPurge }}
    >
      {row}
    </SwipeRow>
  )
})

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    marginTop: space.md,
    minHeight: 38,
  },
  input: { flex: 1, paddingVertical: space.sm },
  chips: { gap: space.sm, paddingVertical: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  footer: { alignItems: 'center', paddingVertical: space.xl },
  emptyButton: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barCount: { flex: 1 },
})

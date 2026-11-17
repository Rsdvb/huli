// Artifacts: what the agents made on the computer, as a grid of previews. A line says how many and
// of which kinds; chips pick a kind; sort and filter sheets, and search, narrow the grid. A card
// opens its sheet (preview, session, versions); Recently deleted sits at the end.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import type { ArtifactSummary } from '@shared/artifacts'
import { artifactKind, KIND_ICON, KIND_TEXT, KINDS, type ArtifactKind } from '../../artifacts'
import { ArtifactCard } from '../../components/ArtifactCard'
import { ArtifactSheet, confirmDelete } from '../../components/ArtifactSheet'
import { inFilter, TopBar, useScrollTopOnTabPress, useShell } from '../../components/shell'
import { Sheet, type SheetItem } from '../../components/Sheet'
import { useHost } from '../../host'
import { errorText } from '../../sessions'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { Skeleton } from '../../ui/Skeleton'
import {
  FONT_SCALE,
  radius,
  space,
  TAB_BAR_CLEARANCE,
  type as typeScale,
  useTokens,
} from '../../ui/tokens'

type Sort = 'updated' | 'created' | 'name'

const SORT_TEXT: Record<Sort, string> = {
  updated: '最近更新',
  created: '最近创建',
  name: '名称',
}

interface Row {
  key: string
  cells: ArtifactSummary[]
}

const collator = new Intl.Collator('zh-CN', { numeric: true })

export default function Artifacts() {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Row>>(null)
  const [items, setItems] = useState<ArtifactSummary[] | null>(null)
  const [deleted, setDeleted] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [kind, setKind] = useState<ArtifactKind | null>(null)
  const [sort, setSort] = useState<Sort>('updated')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [editingOnly, setEditingOnly] = useState(false)
  const [sheet, setSheet] = useState<'sort' | 'filter' | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [menu, setMenu] = useState<ArtifactSummary | null>(null)
  const connected = host.state.kind === 'connected'
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  const load = useCallback(async () => {
    if (!host.link) return
    try {
      const [live, gone] = await Promise.all([
        host.link.request('artifacts.list', {}) as Promise<ArtifactSummary[]>,
        host.link.request('artifacts.list', { deleted: true }) as Promise<ArtifactSummary[]>,
      ])
      setItems(live)
      setDeleted(gone.length)
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
      const event = raw as HostEvent
      if (event.type === 'artifacts.changed' || event.type === 'artifacts.version') void load()
    })
  }, [host.link, load])

  const agentOf = useCallback(
    (a: ArtifactSummary) => host.sessions.get(a.sessionId)?.agentId ?? null,
    [host.sessions],
  )

  const inProject = useMemo(
    () =>
      (items ?? [])
        .filter((a) => a.deletedAt === null)
        .filter((a) => inFilter(shell.filter, { scratch: a.scratch, path: a.project })),
    [items, shell.filter],
  )
  const kinds = useMemo(
    () => KINDS.filter((k) => inProject.some((a) => artifactKind(a) === k)),
    [inProject],
  )
  const agents = useMemo(() => {
    const ids = new Set<string>()
    for (const a of inProject) {
      const id = agentOf(a)
      if (id) ids.add(id)
    }
    return [...ids]
  }, [inProject, agentOf])

  const shown = useMemo(() => {
    const kept = inProject.filter(
      (a) =>
        (!kind || artifactKind(a) === kind) &&
        (!agentId || agentOf(a) === agentId) &&
        (!editingOnly || a.editing.length > 0),
    )
    return kept.sort((a, b) =>
      sort === 'name'
        ? collator.compare(a.title, b.title) || b.updatedAt - a.updatedAt
        : sort === 'created'
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt,
    )
  }, [inProject, kind, agentId, editingOnly, sort, agentOf])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (let i = 0; i < shown.length; i += 2) {
      const cells = shown.slice(i, i + 2)
      out.push({ key: cells.map((a) => a.id).join('|'), cells })
    }
    return out
  }, [shown])

  // A kind that is gone from the list no longer holds its chip.
  useEffect(() => {
    if (kind && items && !kinds.includes(kind)) setKind(null)
  }, [kind, kinds, items])

  const narrowed = kind !== null || agentId !== null || editingOnly
  const clearFilters = () => {
    setKind(null)
    setAgentId(null)
    setEditingOnly(false)
  }
  const open = items?.find((a) => a.id === openId) ?? null

  const summary = (
    <View style={styles.summary} accessibilityRole="header">
      {items && inProject.length === 0 ? (
        <Text style={[typeScale.lead, { color: c.textSecondary }]}>
          你的 Agent 还没做过 Artifact。
        </Text>
      ) : (
        <View
          style={styles.sentence}
          accessible
          accessibilityLabel={`你的 Agent 做了 ${inProject.length} 个 Artifact`}
        >
          <Text style={[typeScale.lead, { color: c.textSecondary }]}>你的 Agent 做了</Text>
          {kinds.length > 0 ? (
            <View style={[styles.kindIcons, { backgroundColor: c.fill, borderColor: c.border }]}>
              {kinds.slice(0, 3).map((k) => (
                <Icon key={k} name={KIND_ICON[k]} size={15} color={c.textSecondary} />
              ))}
            </View>
          ) : null}
          <Text style={[typeScale.lead, styles.count, { color: c.text }]}>
            {items ? inProject.length : '…'} 个 Artifact。
          </Text>
        </View>
      )}
    </View>
  )

  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <Press
      key={key}
      onPress={() => {
        if (on) return
        haptic.select()
        onPress()
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={[
        styles.chip,
        { backgroundColor: on ? c.fillStrong : 'transparent', borderColor: c.borderStrong },
      ]}
    >
      <Text
        maxFontSizeMultiplier={FONT_SCALE.dense}
        style={[typeScale.callout, { color: on ? c.text : c.textSecondary, fontWeight: '500' }]}
      >
        {label}
      </Text>
    </Press>
  )

  const controls = (
    <View style={styles.controls}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={styles.flex}
        accessibilityRole="tablist"
      >
        {chip('全部', kind === null, () => setKind(null), 'all')}
        {kinds.map((k) => chip(KIND_TEXT[k], kind === k, () => setKind(k), k))}
      </ScrollView>
      <Press
        onPress={() => setSheet('sort')}
        accessibilityRole="button"
        accessibilityLabel={`排序：${SORT_TEXT[sort]}`}
        style={[styles.square, { borderColor: c.borderStrong }]}
      >
        <Icon name="sort" size={18} color={sort !== 'updated' ? c.tint : c.text} />
      </Press>
      <Press
        onPress={() => setSheet('filter')}
        accessibilityRole="button"
        accessibilityLabel={agentId || editingOnly ? '筛选（已开启）' : '筛选'}
        style={[
          styles.square,
          {
            borderColor: c.borderStrong,
            backgroundColor: agentId || editingOnly ? c.tintSoft : 'transparent',
          },
        ]}
      >
        <Icon name="sliders" size={18} color={agentId || editingOnly ? c.tint : c.text} />
      </Press>
    </View>
  )

  const empty = () => {
    if (!connected && !items) {
      return (
        <EmptyState
          icon="box"
          title="连上电脑后才能看 Artifact"
          message="Huli 正在连接你的电脑。"
          action={{ label: '立即重连', onPress: () => host.retry() }}
        />
      )
    }
    if (error && !items) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到 Artifact"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!items) {
      return (
        <View style={styles.skeletonGrid} accessibilityLabel="正在加载">
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.skeletonCell, { borderColor: c.border }]}>
              <Skeleton width="70%" height={16} />
              <Skeleton width="45%" height={12} />
              <Skeleton height={90} radius={radius.sm} />
            </View>
          ))}
        </View>
      )
    }
    if (narrowed && inProject.length > 0) {
      return (
        <EmptyState
          icon="search"
          title="没有符合条件的 Artifact"
          action={{ label: '清除筛选', onPress: clearFilters }}
        />
      )
    }
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里还没有 Artifact"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="box"
        title="还没有 Artifact"
        message="让 Agent 做一份报告、一页原型或一套幻灯片，它们会出现在这里。"
        action={connected ? { label: '新会话', onPress: () => router.push('/new') } : undefined}
      />
    )
  }

  const footer =
    deleted !== null ? (
      <Press
        onPress={() => router.push('/artifacts-deleted')}
        scale={false}
        accessibilityRole="button"
        accessibilityLabel={`最近删除，${deleted} 个`}
        style={styles.deleted}
      >
        <View style={[styles.trash, { backgroundColor: c.fill }]}>
          <Icon name="trash" size={18} color={c.textSecondary} />
        </View>
        <Text style={[typeScale.rowTitle, styles.flex, { color: c.text }]}>最近删除</Text>
        <Text style={[typeScale.callout, styles.count, { color: c.textTertiary }]}>{deleted}</Text>
        <Icon name="chevronRight" size={13} color={c.textTertiary} weight="semibold" />
      </Press>
    ) : null

  const menuItems: SheetItem[] = menu
    ? [
        { key: 'open', label: '详情与版本', onPress: () => setOpenId(menu.id) },
        ...(host.sessions.has(menu.sessionId)
          ? [
              {
                key: 'session',
                label: '打开会话',
                onPress: () => router.push(`/session/${menu.sessionId}`),
              },
            ]
          : []),
        {
          key: 'delete',
          label: '删除',
          destructive: true,
          disabled: !connected,
          onPress: () => host.link && confirmDelete((m, p) => host.link!.request(m, p), menu),
        },
      ]
    : []

  const sortItems: SheetItem[] = (Object.keys(SORT_TEXT) as Sort[]).map((key) => ({
    key,
    label: SORT_TEXT[key],
    checked: sort === key,
    onPress: () => {
      haptic.select()
      setSort(key)
    },
  }))

  const filterItems: SheetItem[] = [
    {
      key: 'agents',
      section: 'Agent',
      label: '全部 Agent',
      checked: agentId === null,
      onPress: () => setAgentId(null),
    },
    ...agents.map((id) => ({
      key: id,
      label: host.agents.get(id)?.name ?? id,
      checked: agentId === id,
      onPress: () => {
        haptic.select()
        setAgentId(id)
      },
    })),
    {
      key: 'editing',
      section: '状态',
      label: '只看正在编辑的',
      detail: 'Agent 此刻正在改它',
      checked: editingOnly,
      onPress: () => {
        haptic.select()
        setEditingOnly((on) => !on)
      },
    },
  ]

  return (
    <Screen readable>
      <Animated.FlatList
        ref={list}
        data={items ? rows : []}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => (
          <View style={styles.row}>
            {item.cells.map((a) => (
              <ArtifactCard
                key={a.id}
                artifact={a}
                onPress={() => setOpenId(a.id)}
                onLongPress={() => {
                  haptic.tap()
                  setMenu(a)
                }}
              />
            ))}
            {item.cells.length === 1 ? <View style={styles.flex} /> : null}
          </View>
        )}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.textSecondary}
            progressViewOffset={header.height}
            onRefresh={() => {
              setRefreshing(true)
              host.retry()
              void load().finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.top}>
            {summary}
            {items && inProject.length > 0 ? controls : null}
          </View>
        }
        ListEmptyComponent={<View style={styles.pad}>{empty()}</View>}
        ListFooterComponent={footer ?? undefined}
      />
      <TopBar header={header} compact searchScope="artifacts" />
      <ArtifactSheet artifact={open} onClose={() => setOpenId(null)} />
      <Sheet
        visible={menu !== null}
        title={menu?.title}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
      <Sheet
        visible={sheet === 'sort'}
        title="排序"
        items={sortItems}
        onClose={() => setSheet(null)}
      />
      <Sheet
        visible={sheet === 'filter'}
        title="筛选"
        items={filterItems}
        onClose={() => setSheet(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { paddingHorizontal: space.xl },
  top: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    gap: space.lg,
    paddingBottom: space.lg,
  },
  summary: { paddingTop: space.md },
  kindIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingHorizontal: space.sm + 2,
    height: 30,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sentence: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chips: { gap: space.sm, paddingRight: space.xs },
  chip: {
    minHeight: 38,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  square: {
    width: 42,
    height: 38,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, paddingTop: space.md },
  skeletonCell: {
    width: '47%',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  deleted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    marginTop: space.sm,
  },
  trash: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { fontVariant: ['tabular-nums'] },
})

// Artifacts: what the agents made on the computer, newest first; one opens the session behind it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import type { ArtifactSummary } from '@shared/artifacts'
import {
  FilterNote,
  inFilter,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { useHost } from '../../host'
import { errorText, folder, listTime } from '../../sessions'
import { EmptyState } from '../../ui/EmptyState'
import { Icon, type IconName } from '../../ui/Icon'
import { LargeTitle } from '../../ui/LargeTitle'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { SkeletonRows } from '../../ui/Skeleton'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'

function kindOf(a: ArtifactSummary): { icon: IconName; text: string } {
  if (a.type === 'slides') return { icon: 'slides', text: '幻灯片' }
  if (a.canvas || a.pages > 1) return { icon: 'canvas', text: `画布 · ${a.pages} 页` }
  if (a.type === 'document') return { icon: 'doc', text: '文档' }
  return { icon: 'doc', text: '页面' }
}

export default function Artifacts() {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<ArtifactSummary>>(null)
  const [items, setItems] = useState<ArtifactSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const connected = host.state.kind === 'connected'
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  const load = useCallback(async () => {
    if (!host.link) return
    try {
      setItems((await host.link.request('artifacts.list', {})) as ArtifactSummary[])
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

  const projectNames = useMemo(
    () => new Map(host.projects.map((p) => [p.path, p.name])),
    [host.projects],
  )
  const visible = useMemo(
    () =>
      (items ?? [])
        .filter((a) => a.deletedAt === null)
        .filter((a) => inFilter(shell.filter, { scratch: a.scratch, path: a.project }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [items, shell.filter],
  )

  const empty = () => {
    if (!connected && !items) {
      return <EmptyState icon="box" title="连上电脑后才能看 Artifacts" />
    }
    if (error && !items) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到 Artifacts"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!items) return <SkeletonRows count={6} />
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里还没有 Artifacts"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="box"
        title="还没有 Artifacts"
        message="让智能体做一份报告、一页原型或一套幻灯片，它们会出现在这里。"
      />
    )
  }

  const renderItem = ({ item }: { item: ArtifactSummary }) => {
    const kind = kindOf(item)
    const session = host.sessions.get(item.sessionId)
    const editing = item.editing.length > 0
    const place = item.scratch ? '无项目' : (projectNames.get(item.project) ?? folder(item.project))
    const content = (
      <>
        <View style={[styles.tile, { backgroundColor: c.fill }]}>
          <Icon name={kind.icon} size={20} color={c.textSecondary} />
          {editing && (
            <View style={[styles.liveDot, { backgroundColor: c.success, borderColor: c.bg }]} />
          )}
        </View>
        <View style={styles.body}>
          <View style={styles.titleLine}>
            <Text style={[typeScale.rowTitle, styles.flex, { color: c.text }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[typeScale.subhead, styles.time, { color: c.textTertiary }]}>
              {listTime(item.updatedAt)}
            </Text>
          </View>
          <View style={styles.meta}>
            <Icon name="folder" size={13} color={c.textTertiary} />
            <Text
              style={[typeScale.footnote, styles.place, { color: c.textTertiary }]}
              numberOfLines={1}
            >
              {place}
            </Text>
            <Text
              style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}
              numberOfLines={1}
            >
              {kind.text} · v{item.version}
            </Text>
            {editing && (
              <Text style={[typeScale.footnote, { color: c.success, fontWeight: '500' }]}>
                正在编辑
              </Text>
            )}
          </View>
        </View>
      </>
    )
    if (!session) return <View style={styles.row}>{content}</View>
    return (
      <Press
        onPress={() => router.push(`/session/${session.id}`)}
        scale={false}
        accessibilityRole="button"
        accessibilityHint="打开做它的会话"
        style={styles.row}
      >
        {content}
      </Press>
    )
  }

  return (
    <Screen>
      <Animated.FlatList
        ref={list}
        data={items ? visible : []}
        keyExtractor={(a) => a.id}
        renderItem={renderItem}
        {...header.scrollProps}
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
              void load().finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.pad}>
            <LargeTitle title="Artifacts" subtitle="智能体做出的页面、文档、画布和幻灯片。" />
            <FilterNote what="Artifacts" />
            {visible.length > 0 && <SectionHeader title="最近" count={visible.length} />}
          </View>
        }
        ListEmptyComponent={<View style={styles.pad}>{empty()}</View>}
      />
      <TopBar header={header} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
  },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  time: { fontVariant: ['tabular-nums'], fontWeight: '400' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  place: { flexShrink: 1, maxWidth: '45%' },
})

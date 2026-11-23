// Recently deleted artifacts, the latest deletion first: swipe right to restore, left to delete for
// good; a tap offers both.

import { useCallback, useEffect, useState } from 'react'
import { Alert, Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import type { ArtifactSummary } from '@shared/artifacts'
import { artifactKind, daysLeft, KIND_ICON, KIND_TEXT } from '../artifacts'
import { Sheet } from '../components/Sheet'
import { useHost } from '../host'
import { errorText } from '../sessions'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { LargeTitle } from '../ui/LargeTitle'
import { NavBar } from '../ui/NavBar'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { usePullRefresh } from '../ui/PullRefresh'
import { SkeletonRows } from '../ui/Skeleton'
import { SwipeRow } from '../ui/SwipeRow'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

function leftText(deletedAt: number, purgeAt: number | null | undefined): string {
  const left = daysLeft(deletedAt, Date.now(), purgeAt)
  return left === null ? '不会自动删除' : `${left} 天后永久删除`
}

export default function DeletedArtifacts() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(() => load(), header)
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<ArtifactSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<ArtifactSummary | null>(null)
  const connected = host.state.kind === 'connected'

  const load = useCallback(async () => {
    if (!host.link) return
    try {
      const list = (await host.link.request('artifacts.list', {
        deleted: true,
      })) as ArtifactSummary[]
      setItems(list.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)))
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
      if ((raw as HostEvent).type === 'artifacts.changed') void load()
    })
  }, [host.link, load])

  const restore = (a: ArtifactSummary) => {
    if (!host.link) return
    host.link.request('artifacts.undelete', { id: a.id }).then(
      () => {
        haptic.success()
        setItems((list) => list?.filter((x) => x.id !== a.id) ?? null)
      },
      (failure: unknown) => Alert.alert('没能恢复', errorText(failure)),
    )
  }

  const destroy = (a: ArtifactSummary) => {
    haptic.warning()
    Alert.alert(`永久删除「${a.title || '未命名'}」？`, '它的所有版本都会删除，无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '永久删除',
        style: 'destructive',
        onPress: () => {
          host.link?.request('artifacts.delete', { id: a.id, permanently: true }).then(
            () => setItems((list) => list?.filter((x) => x.id !== a.id) ?? null),
            (failure: unknown) => Alert.alert('没能删除', errorText(failure)),
          )
        },
      },
    ])
  }

  const empty = () => {
    if (!connected && !items) return <EmptyState icon="trash" title="连上电脑后才能看最近删除" />
    if (error && !items) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到最近删除"
          message={error}
          action={{ label: '重试', onPress: () => void load() }}
        />
      )
    }
    if (!items) return <SkeletonRows count={4} />
    return <EmptyState icon="trash" title="最近删除里是空的" message="删除的产物会先放在这里。" />
  }

  return (
    <Screen>
      <Animated.FlatList
        data={items ?? []}
        keyExtractor={(a) => a.id}
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + space.xxxl,
        }}
        refreshControl={pull}
        ListHeaderComponent={
          <View style={styles.pad}>
            <LargeTitle
              title="最近删除"
              subtitle="删除的产物先进回收站，按电脑上设的天数保留。右滑恢复，左滑永久删除。"
            />
            <Press
              onPress={() => router.push('/recycle-bin')}
              accessibilityRole="link"
              hitSlop={8}
              style={styles.binLink}
            >
              <Text style={[typeScale.subhead, { color: c.tint }]}>在回收站里看全部删掉的东西</Text>
            </Press>
          </View>
        }
        ListEmptyComponent={<View style={styles.pad}>{empty()}</View>}
        renderItem={({ item }) => {
          const kind = artifactKind(item)
          return (
            <SwipeRow
              start={
                connected
                  ? { label: '恢复', icon: 'restore', color: c.tint, onPress: () => restore(item) }
                  : undefined
              }
              end={
                connected
                  ? { label: '删除', icon: 'trash', color: c.danger, onPress: () => destroy(item) }
                  : undefined
              }
            >
              <Press
                onPress={() => setMenu(item)}
                scale={false}
                accessibilityRole="button"
                accessibilityHint="恢复或永久删除"
                style={[styles.row, { backgroundColor: c.bg }]}
              >
                <View style={[styles.tile, { backgroundColor: c.fill }]}>
                  <Icon name={KIND_ICON[kind]} size={20} color={c.textSecondary} />
                </View>
                <View style={styles.body}>
                  <Text style={[typeScale.rowTitle, { color: c.text }]} numberOfLines={1}>
                    {item.title || '未命名'}
                  </Text>
                  <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
                    {KIND_TEXT[kind]} · {leftText(item.deletedAt ?? Date.now(), item.purgeAt)}
                  </Text>
                </View>
              </Press>
            </SwipeRow>
          )
        }}
      />
      <NavBar header={header} title="最近删除" />
      <Sheet
        visible={menu !== null}
        title={menu?.title}
        items={
          menu
            ? [
                {
                  key: 'restore',
                  label: '恢复',
                  disabled: !connected,
                  onPress: () => restore(menu),
                },
                {
                  key: 'delete',
                  label: '永久删除',
                  destructive: true,
                  disabled: !connected,
                  onPress: () => destroy(menu),
                },
              ]
            : []
        }
        onClose={() => setMenu(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
  binLink: { alignSelf: 'flex-start', marginTop: space.sm, marginBottom: space.md },
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
  body: { flex: 1, gap: 3 },
})

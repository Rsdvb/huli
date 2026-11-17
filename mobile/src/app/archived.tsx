// Archived sessions, the latest archived first, to open, restore or delete.

import { useMemo } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { useSessionActions } from '../components/SessionActions'
import { SessionRow } from '../components/SessionRow'
import { useHost } from '../host'
import { EmptyState } from '../ui/EmptyState'
import { LargeTitle } from '../ui/LargeTitle'
import { NavBar } from '../ui/NavBar'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { space, useTokens } from '../ui/tokens'

export default function Archived() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const actions = useSessionActions('archive')
  const connected = host.state.kind === 'connected'

  const archived = useMemo(
    () =>
      [...host.sessions.values()]
        .filter((s) => s.parentId === null && s.archivedAt !== null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [host.sessions],
  )
  const projectNames = useMemo(
    () => new Map(host.projects.map((p) => [p.path, p.name])),
    [host.projects],
  )

  return (
    <Screen>
      <Animated.FlatList
        data={archived}
        keyExtractor={(s: SessionSummary) => s.id}
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + space.xxxl,
        }}
        ListHeaderComponent={
          <View style={styles.pad}>
            <LargeTitle
              title="已归档"
              subtitle={archived.length > 0 ? '左滑恢复，长按重命名或删除。' : undefined}
            />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="archive"
            title={connected ? '没有归档的会话' : '连上电脑后才能看到归档的会话'}
            message={connected ? '在会话列表里左滑一个会话就能归档。' : undefined}
          />
        }
        renderItem={({ item }: { item: SessionSummary }) => (
          <SessionRow
            session={item}
            agentName={host.agents.get(item.agentId)?.name}
            projectName={projectNames.get(item.projectPath)}
            time={item.archivedAt ?? item.updatedAt}
            onPress={() => router.push(`/session/${item.id}`)}
            onLongPress={() => actions.open(item)}
            end={
              connected
                ? {
                    label: '恢复',
                    icon: 'inbox',
                    color: c.tint,
                    onPress: () => actions.restore(item),
                  }
                : undefined
            }
          />
        )}
      />
      <NavBar header={header} title="已归档" />
      {actions.element}
    </Screen>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
})

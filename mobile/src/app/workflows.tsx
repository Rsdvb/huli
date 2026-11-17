// The workflow library on the computer, read-only: those waiting for the user's approval first,
// then those that can start tasks, then those that cannot. A workflow opens its page.

import { useState } from 'react'
import { Animated, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { WireWorkflowEntry } from '@shared/workflow'
import { useHost } from '../host'
import { entryName, entryProblem, ENTRY_STATE_TEXT, sourceText, useWorkflowLibrary } from '../tasks'
import { EmptyState } from '../ui/EmptyState'
import { LargeTitle } from '../ui/LargeTitle'
import { ListGroup, ListRow } from '../ui/ListRow'
import { NavBar } from '../ui/NavBar'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { SkeletonRows } from '../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

export default function Workflows() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const library = useWorkflowLibrary()
  const [refreshing, setRefreshing] = useState(false)

  const waiting = library.entries.filter((e) => {
    const p = entryProblem(e)
    return p === 'pending' || p === 'changed'
  })
  const usable = library.entries.filter((e) => entryProblem(e) === null)
  const broken = library.entries.filter((e) => {
    const p = entryProblem(e)
    return p === 'problems' || p === 'unreadable'
  })

  const row = (entry: WireWorkflowEntry) => {
    const problem = entryProblem(entry)
    const steps = entry.workflow?.steps.length
    return (
      <ListRow
        key={entry.id}
        title={entryName(entry)}
        subtitle={[steps ? `${steps} 步` : null, sourceText(entry)].filter(Boolean).join(' · ')}
        trailing={
          problem ? (
            <Text
              style={[
                typeScale.caption,
                styles.badge,
                {
                  color: problem === 'pending' || problem === 'changed' ? c.warning : c.danger,
                  backgroundColor: c.fill,
                },
              ]}
            >
              {ENTRY_STATE_TEXT[problem]}
            </Text>
          ) : undefined
        }
        chevron
        onPress={() => router.push(`/workflow/${encodeURIComponent(entry.id)}`)}
      />
    )
  }

  let body
  if (library.error && !library.loaded) {
    body = (
      <EmptyState
        tone="error"
        icon="warning"
        title="没能读到工作流"
        message={library.error}
        action={{ label: '重试', onPress: () => void library.reload() }}
      />
    )
  } else if (!library.loaded) {
    body =
      host.state.kind === 'connected' ? (
        <SkeletonRows count={4} avatar={false} />
      ) : (
        <EmptyState
          icon="flow"
          title="连上电脑后才能看工作流"
          action={{ label: '立即重连', onPress: () => host.retry() }}
        />
      )
  } else if (library.entries.length === 0) {
    body = (
      <EmptyState
        icon="flow"
        title="还没有工作流"
        message="在任意会话里让 Agent 帮你写一个，它会在这里等你批准；也可以在电脑上的 Marketplace 里添加。"
      />
    )
  } else {
    body = (
      <>
        {waiting.length > 0 ? <ListGroup header="等你批准">{waiting.map(row)}</ListGroup> : null}
        {usable.length > 0 ? <ListGroup header="可以用">{usable.map(row)}</ListGroup> : null}
        {broken.length > 0 ? <ListGroup header="不能开始需求">{broken.map(row)}</ListGroup> : null}
      </>
    )
  }

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.textSecondary}
            progressViewOffset={header.height}
            onRefresh={() => {
              setRefreshing(true)
              void library.reload().finally(() => setRefreshing(false))
            }}
          />
        }
      >
        <View style={styles.title}>
          <LargeTitle
            title="工作流"
            subtitle="工作流是一张流程图，让几个 Agent 合作完成一件事。每一步由谁来做，在它开始时由交棒给它的 Agent 选，除非你固定了一个。"
          />
        </View>
        {body}
      </Animated.ScrollView>
      <NavBar header={header} title="工作流" />
    </Screen>
  )
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: space.xs },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.xs,
    overflow: 'hidden',
  },
})

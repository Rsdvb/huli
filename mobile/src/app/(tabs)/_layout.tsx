// The four tabs under their floating glass bar, once the phone has a computer; pairing until then.
// The tabs belong to the active computer: switching computers mounts them afresh, so no tab shows
// one computer's lists while the other's load.

import { useWindowDimensions, View } from 'react-native'
import { router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { SessionRowSkeleton } from '../../components/SessionRow'
import { useHost } from '../../host'
import { PairScreen } from '../../screens/PairScreen'
import { GlassTabBar, type TabItem } from '../../ui/GlassTabBar'
import { LIST_COLUMN, READABLE_WIDTH, SPLIT_MIN_WIDTH } from '../../ui/layout'
import { Screen } from '../../ui/Screen'
import { space, useTokens } from '../../ui/tokens'

const TABS: Record<string, TabItem> = {
  index: { icon: 'inbox', label: '会话' },
  artifacts: { icon: 'box', label: 'Artifacts' },
  routines: { icon: 'history', label: '定时任务' },
  usage: { icon: 'chart', label: '用量' },
}

export default function TabsLayout() {
  const { c } = useTokens()
  const host = useHost()
  const { width } = useWindowDimensions()
  const wide = width >= SPLIT_MIN_WIDTH

  if (host.phase === 'loading') {
    return (
      <Screen edges={['top']}>
        <View style={{ paddingTop: space.xxxl * 2 }}>
          <SessionRowSkeleton count={6} />
        </View>
      </Screen>
    )
  }
  if (host.phase === 'pair') {
    return (
      <PairScreen
        notice={host.notice}
        onPaired={(saved, key, paired) => void host.paired(saved, key, paired)}
      />
    )
  }

  const connected = host.state.kind === 'connected'
  return (
    <Tabs
      key={host.host?.id}
      tabBar={(props) => {
        const focused = props.state.routes[props.state.index]?.name
        // On a wide window the bar sits under the session list, or under the centered column.
        const frame = !wide
          ? undefined
          : focused === 'index'
            ? { left: 0, width: LIST_COLUMN }
            : { left: (width - Math.min(width, READABLE_WIDTH)) / 2, width: READABLE_WIDTH }
        return (
          <GlassTabBar
            {...props}
            items={TABS}
            onPlus={() => router.push('/new')}
            plusDisabled={!connected}
            {...(frame ? { frame } : {})}
          />
        )
      }}
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      {Object.entries(TABS).map(([name, item]) => (
        <Tabs.Screen key={name} name={name} options={{ title: item.label }} />
      ))}
    </Tabs>
  )
}

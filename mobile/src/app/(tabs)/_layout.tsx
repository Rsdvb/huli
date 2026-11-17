// The four tabs under their floating glass bar, once the phone has a computer; pairing until then.

import { View } from 'react-native'
import { router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { useHost } from '../../host'
import { PairScreen } from '../../screens/PairScreen'
import { GlassTabBar, type TabItem } from '../../ui/GlassTabBar'
import { Screen } from '../../ui/Screen'
import { SkeletonRows } from '../../ui/Skeleton'
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

  if (host.phase === 'loading') {
    return (
      <Screen edges={['top']}>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.xxxl * 2 }}>
          <SkeletonRows count={5} />
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
      tabBar={(props) => (
        <GlassTabBar
          {...props}
          items={TABS}
          onPlus={() => router.push('/new')}
          plusDisabled={!connected}
        />
      )}
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

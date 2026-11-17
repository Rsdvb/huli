// The four tabs under the system's own tab bar, once the phone has a computer; pairing until then.
// The third, 任务, holds tasks and routines.
// The tabs belong to the active computer: switching computers mounts them afresh, so no tab shows
// one computer's lists while the other's load.
//
// On iOS this is UITabBarController: Liquid Glass on iOS 26, minimizing as a list scrolls down,
// and on iOS 27 the new-session button on a surface of its own beside the tabs. Android gets
// Material's bottom navigation.

import { View } from 'react-native'
import { NativeTabs } from 'expo-router/native-tabs'
import { SessionRowSkeleton } from '../../components/SessionRow'
import { useHost } from '../../host'
import { PairScreen } from '../../screens/PairScreen'
import { Screen } from '../../ui/Screen'
import { rememberTab } from '../../ui/lastTab'
import { space, useTokens } from '../../ui/tokens'

export default function TabsLayout() {
  const { c } = useTokens()
  const host = useHost()

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
    <NativeTabs
      key={host.host?.id}
      minimizeBehavior="onScrollDown"
      tintColor={c.tint}
      backgroundColor={c.bg}
      indicatorColor={c.tintSoft}
      screenListeners={({ route }) => ({
        focus: () => rememberTab(route.name),
      })}
    >
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: c.bg }}>
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        <NativeTabs.Trigger.Label>会话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="artifacts" contentStyle={{ backgroundColor: c.bg }}>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'shippingbox', selected: 'shippingbox.fill' }}
          md="deployed_code"
        />
        <NativeTabs.Trigger.Label>Artifacts</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="routines" contentStyle={{ backgroundColor: c.bg }}>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'flowchart', selected: 'flowchart.fill' }}
          md="account_tree"
        />
        <NativeTabs.Trigger.Label>任务</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="usage" contentStyle={{ backgroundColor: c.bg }}>
        <NativeTabs.Trigger.Icon sf="chart.bar.fill" md="bar_chart" />
        <NativeTabs.Trigger.Label>用量</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      {/* Not a page: choosing it opens New session over the tab that was showing. */}
      <NativeTabs.Trigger
        name="compose"
        prominent
        disabled={!connected}
        accessibilityLabel="新会话"
        contentStyle={{ backgroundColor: c.bg }}
      >
        <NativeTabs.Trigger.Icon sf="plus" md="add" />
        <NativeTabs.Trigger.Label hidden>新会话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}

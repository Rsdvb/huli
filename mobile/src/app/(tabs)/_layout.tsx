// The four tabs under the system's own tab bar, once the phone has a computer; pairing until then.
// The third, 任务, holds tasks and routines.
// Each tab's content belongs to the active computer and mounts afresh when it changes, so no tab
// shows one computer's lists while the other's load; the tabs themselves stay, on the tab that
// shows. Home in 全部电脑 lists every computer and stays as it is.
//
// On iOS this is UITabBarController: Liquid Glass on iOS 26, minimizing as a list scrolls down,
// and on iOS 27 the new-session button on a surface of its own beside the tabs. Android gets
// Material's bottom navigation.

import { View } from 'react-native'
import { router } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { SessionRowSkeleton } from '../../components/SessionRow'
import { getHost, sameFields, useHostActions, useHostSelector, type HostData } from '../../host'
import { linkProblem } from '../../linkInfo'
import { PairScreen } from '../../screens/PairScreen'
import { haptic } from '../../ui/haptics'
import { showNotice } from '../../ui/NoticeBar'
import { Screen } from '../../ui/Screen'
import { rememberTab } from '../../ui/lastTab'
import { space, useTokens } from '../../ui/tokens'

const pickPhase = (d: HostData) => ({ phase: d.phase, notice: d.notice })
// New session works offline too once the agents are known, its session made when the link is back;
// a link that stopped never comes back by itself.
const pickCompose = (d: HostData) =>
  d.state.kind === 'connected' || (d.loaded && d.state.kind !== 'stopped')

export default function TabsLayout() {
  const { c } = useTokens()
  const host = useHostSelector(pickPhase, sameFields)
  const { paired } = useHostActions()
  const canCompose = useHostSelector(pickCompose)

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
        onPaired={(saved, key, adopt) => void paired(saved, key, adopt)}
      />
    )
  }

  return (
    <NativeTabs
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
      {/* Not a page: the tab bar never selects it, and its press opens New session over the tab
          that is showing. Selected, it had to switch back to that tab from JS while the native
          tab bar settled, which now and then lost the switch and left its empty page showing. */}
      <NativeTabs.Trigger
        name="compose"
        prominent
        disabled
        listeners={{
          tabPress: () => {
            if (canCompose) {
              router.push('/new')
              return
            }
            // It cannot open yet: say why rather than ignore the press.
            haptic.warning()
            const { state } = getHost()
            showNotice({
              tone: 'warning',
              text:
                state.kind === 'stopped'
                  ? `${linkProblem(state) ?? '电脑的连接已断开。'}现在不能开新会话。`
                  : '正在连接电脑，连上后就能开新会话。',
            })
          },
        }}
        accessibilityLabel="新会话"
        contentStyle={{ backgroundColor: c.bg }}
      >
        <NativeTabs.Trigger.Icon sf="plus" md="add" />
        <NativeTabs.Trigger.Label hidden>新会话</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}

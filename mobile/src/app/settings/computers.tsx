// Settings › 已配对的电脑: every computer this phone is paired with, which one the app shows, and
// adding, switching, renaming and unpairing them.

import { Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import {
  ComputerRow,
  useComputerActions,
  useComputerLine,
  useReach,
} from '../../components/ComputerSheet'
import { useHost } from '../../host'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

export default function Computers() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const reach = useReach(true)
  const lineOf = useComputerLine(reach)
  const actions = useComputerActions()

  return (
    <Screen readable>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
      >
        <View style={styles.groupWrap}>
          <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
            {host.computers.map((h, i) => (
              <View key={h.id}>
                {i > 0 && <View style={[styles.separator, { backgroundColor: c.border }]} />}
                <ComputerRow
                  computer={h}
                  line={lineOf(h)}
                  active={h.id === host.host?.id}
                  busy={actions.busy.has(h.id)}
                  onPress={() =>
                    router.push({ pathname: '/settings/computer', params: { id: h.id } })
                  }
                  menu={actions.menu(h)}
                />
              </View>
            ))}
          </View>
          <Text style={[typeScale.footnote, styles.footer, { color: c.textTertiary }]}>
            纸鸢一次只连一台电脑：会话、产物、定时任务、用量和通知设置都跟着正在使用的那台。
            每台电脑分别给这台手机发通知，点开通知会先切换到发出它的电脑。
          </Text>
        </View>

        <ListGroup>
          <ListRow
            title="添加电脑"
            icon="plus"
            plainIcon
            action
            onPress={() => router.push('/pair')}
          />
        </ListGroup>
      </Animated.ScrollView>
      <NavBar header={header} title="已配对的电脑" titleAlways />
      {actions.element}
    </Screen>
  )
}

const styles = StyleSheet.create({
  groupWrap: { gap: space.sm },
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 64 },
  footer: { marginHorizontal: space.lg },
})

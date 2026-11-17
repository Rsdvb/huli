// Settings › 致谢: what Huli is a fork of, under which license, and the open-source work it ships.

import { Animated, Linking, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GITHUB_URL, KETTU_URL, LIBRARIES, MARKS, type Credit } from '../../about'
import { HuliIcon } from '../../ui/HuliMark'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

function creditRow(credit: Credit) {
  return (
    <ListRow
      key={credit.name}
      title={credit.name}
      subtitle={credit.note}
      value={credit.license}
      external
      onPress={() => void Linking.openURL(credit.url)}
    />
  )
}

export default function Licenses() {
  const { c } = useTokens()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
      >
        <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
          <HuliIcon size={48} />
          <Text style={[typeScale.callout, { color: c.text }]}>
            Huli 是 Kettu 的一个分支。和 Kettu 一样，它以 GNU Affero 通用公共许可证第 3
            版（AGPL-3.0）发布，并附带 Kettu 为 affectUI 给出的额外许可。你可以在 GitHub
            上取得它的全部源代码。
          </Text>
        </View>

        <ListGroup>
          <ListRow
            title="Huli 源代码"
            value="AGPL-3.0"
            external
            onPress={() => void Linking.openURL(GITHUB_URL)}
          />
          <ListRow
            title="Kettu"
            subtitle="Huli 基于它而来"
            value="AGPL-3.0"
            external
            onPress={() => void Linking.openURL(KETTU_URL)}
          />
        </ListGroup>

        <ListGroup header="开源库">{LIBRARIES.map(creditRow)}</ListGroup>

        <ListGroup
          header="智能体标志"
          footer="各家智能体的标志归各自所有者，按上面列出的条款使用。"
        >
          {MARKS.map(creditRow)}
        </ListGroup>
      </Animated.ScrollView>
      <NavBar header={header} title="致谢" titleAlways />
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
})

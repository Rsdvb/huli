// A tab's large title and the line under it, which scroll away beneath the floating header.

import { StyleSheet, Text, View } from 'react-native'
import { space, type as typeScale, useTokens } from './tokens'

export function LargeTitle(props: { title: string; subtitle?: string }) {
  const { c } = useTokens()
  return (
    <View style={styles.wrap} accessibilityRole="header">
      <Text style={[typeScale.hero, { color: c.text }]}>{props.title}</Text>
      {props.subtitle ? (
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>{props.subtitle}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs, paddingTop: space.md, paddingBottom: space.xs },
})

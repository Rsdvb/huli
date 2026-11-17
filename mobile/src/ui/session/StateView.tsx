// What a session screen shows in place of its content: a spinner while it loads, or a line saying
// why there is nothing, with a retry after an error.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { G, Icon, type IconSpec } from './icons'
import { useSessionTokens } from './palette'
import { PressScale } from './Press'

export function StateView(props: {
  loading?: boolean
  text?: string
  icon?: IconSpec
  tone?: 'plain' | 'danger'
  retry?: () => void
}) {
  const { c } = useSessionTokens()
  if (props.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    )
  }
  const color = props.tone === 'danger' ? c.danger : c.textSecondary
  return (
    <View style={styles.center}>
      <Icon
        icon={props.icon ?? (props.tone === 'danger' ? G.warning : G.info)}
        size={26}
        color={color}
      />
      <Text style={[styles.text, { color }]}>{props.text}</Text>
      {props.retry && (
        <PressScale
          onPress={props.retry}
          hitSlop={8}
          accessibilityRole="button"
          style={[styles.retry, { backgroundColor: c.fillStrong }]}
        >
          <Text style={[styles.retryText, { color: c.text }]}>重试</Text>
        </PressScale>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  text: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  retry: {
    borderRadius: 999,
    paddingHorizontal: 20,
    height: 38,
    justifyContent: 'center',
    marginTop: 4,
  },
  retryText: { fontSize: 15, fontWeight: '600' },
})

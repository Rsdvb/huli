// What a screen shows in place of its content: a spinner while it loads, or a line saying why
// there is nothing, with a retry after an error.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Theme } from '../theme'

export function Loading(props: { theme: Theme }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={props.theme.accent} />
    </View>
  )
}

export function Message(props: { text: string; theme: Theme; color?: string; retry?: () => void }) {
  const { text, theme, color, retry } = props
  return (
    <View style={styles.center}>
      <Text style={{ color: color ?? theme.muted, fontSize: 15, textAlign: 'center' }}>{text}</Text>
      {retry && (
        <Pressable onPress={retry} hitSlop={8} style={{ marginTop: 14 }}>
          <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600' }}>重试</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
})

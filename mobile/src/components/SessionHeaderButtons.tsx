// The session screen's header buttons: its changes, Stop while a turn runs, and the session's menu.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme'
import { ChangesButton } from './ChangesButton'

export function SessionHeaderButtons(props: {
  sessionId: string
  running: boolean
  onStop(): void
  onMenu: (() => void) | undefined
}) {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <ChangesButton sessionId={props.sessionId} theme={theme} />
      {props.running && (
        <Pressable onPress={props.onStop} hitSlop={8}>
          <Text style={{ color: theme.danger, fontSize: 16, fontWeight: '600' }}>停止</Text>
        </Pressable>
      )}
      <Pressable
        onPress={props.onMenu}
        disabled={!props.onMenu}
        hitSlop={8}
        accessibilityLabel="会话菜单"
        style={{ opacity: props.onMenu ? 1 : 0.4 }}
      >
        <Text style={{ color: theme.accent, fontSize: 22, lineHeight: 24, fontWeight: '700' }}>
          ⋯
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 18 },
})

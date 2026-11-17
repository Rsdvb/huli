// The session list's notice of a newer Android build; closing it hides that version for good.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { dismissUpdate, openUpdate, UPDATES_SUPPORTED, useUpdate } from '../update'
import { useTheme } from '../theme'

export function UpdateBanner() {
  const theme = useTheme()
  const { latest, dismissed } = useUpdate()
  if (!UPDATES_SUPPORTED || !latest || dismissed === latest.version) return null

  return (
    <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.accent }]}>
      <Pressable
        onPress={() => openUpdate(latest)}
        style={({ pressed }) => [styles.text, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={{ color: theme.text, fontSize: 14 }}>
          Huli 有新版本 {latest.version}，点击下载
        </Text>
      </Pressable>
      <Pressable
        onPress={() => dismissUpdate(latest.version)}
        hitSlop={10}
        accessibilityLabel="关闭"
      >
        <Text style={{ color: theme.muted, fontSize: 16 }}>✕</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  text: { flex: 1 },
})

// The session list's notice of a newer Android build; closing it hides that version for good.

import { StyleSheet, Text, View } from 'react-native'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { dismissUpdate, openUpdate, UPDATES_SUPPORTED, useUpdate } from '../update'

export function UpdateBanner() {
  const { c } = useTokens()
  const { latest, dismissed } = useUpdate()
  if (!UPDATES_SUPPORTED || !latest || dismissed === latest.version) return null

  return (
    <View style={[styles.banner, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Press
        onPress={() => openUpdate(latest)}
        scale={false}
        accessibilityRole="button"
        containerStyle={styles.flex}
        style={styles.text}
      >
        <View style={[styles.badge, { backgroundColor: c.accent }]}>
          <Icon name="download" size={16} color={c.onAccent} />
        </View>
        <View style={styles.flex}>
          <Text style={[typeScale.subhead, { color: c.text }]}>
            Huli {latest.version} 可以更新了
          </Text>
          <Text style={[typeScale.footnote, { color: c.textSecondary }]}>点按下载新版本</Text>
        </View>
      </Press>
      <IconButton
        icon="close"
        tone="plain"
        size={32}
        iconSize={14}
        color={c.textTertiary}
        label="不再提示这个版本"
        onPress={() => dismissUpdate(latest.version)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badge: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

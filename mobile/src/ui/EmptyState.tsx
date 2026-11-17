// What a list shows with nothing in it, or when it could not load: an icon, a sentence, and at
// most one thing to do about it.

import { StyleSheet, Text, View } from 'react-native'
import { Icon, type IconName } from './Icon'
import { Pill } from './Pill'
import { radius, space, type as typeScale, useTokens } from './tokens'

export function EmptyState(props: {
  icon: IconName
  title: string
  message?: string
  action?: { label: string; onPress(): void }
  tone?: 'neutral' | 'error'
}) {
  const { c } = useTokens()
  const error = props.tone === 'error'
  return (
    <View style={styles.wrap}>
      <View style={[styles.badge, { backgroundColor: error ? c.removedBg : c.fill }]}>
        <Icon name={props.icon} size={28} color={error ? c.danger : c.textSecondary} />
      </View>
      <Text style={[typeScale.headline, styles.center, { color: c.text }]}>{props.title}</Text>
      {props.message ? (
        <Text style={[typeScale.callout, styles.center, { color: c.textSecondary }]}>
          {props.message}
        </Text>
      ) : null}
      {props.action && (
        <Pill
          label={props.action.label}
          tone="tint"
          onPress={props.action.onPress}
          style={styles.action}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxxl,
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  center: { textAlign: 'center' },
  action: { alignSelf: 'center', marginTop: space.md },
})

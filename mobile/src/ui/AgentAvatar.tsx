// An agent in a round avatar: its harness's mark on a quiet disc, or its initial when the phone has
// no mark for it. A dot on the edge tells a running session (breathing), one that waits for the
// user, or one that failed.

import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import Svg from 'react-native-svg'
import { markFor } from './agent-marks'
import { useReduceMotion } from './Press'
import { size as sizes, useTokens } from './tokens'

export type AvatarBadge = 'live' | 'waiting' | 'error' | 'unread' | null

export function AgentAvatar(props: {
  agentId: string
  /** The agent's name, whose initial stands in for a missing mark. */
  name?: string
  size?: number
  badge?: AvatarBadge
}) {
  const { c, scheme } = useTokens()
  const side = props.size ?? sizes.avatar
  const mark = markFor(props.agentId)
  const glyph = Math.round(side * 0.52)
  return (
    <View style={{ width: side, height: side }}>
      <View
        style={[
          styles.disc,
          { width: side, height: side, borderRadius: side / 2, backgroundColor: c.avatar },
        ]}
      >
        {mark ? (
          <Svg width={glyph} height={glyph} viewBox={mark.viewBox}>
            <mark.Body ink={{ scheme, text: c.text }} />
          </Svg>
        ) : (
          <Text style={{ color: c.text, fontSize: side * 0.42, fontWeight: '600' }}>
            {(props.name ?? props.agentId).trim().charAt(0).toUpperCase() || '?'}
          </Text>
        )}
      </View>
      {props.badge ? <Badge kind={props.badge} side={side} /> : null}
    </View>
  )
}

/** An agent's mark on its own, at text size, as a card's byline shows it. */
export function AgentGlyph(props: { agentId: string; name?: string; size?: number }) {
  const { c, scheme } = useTokens()
  const side = props.size ?? 14
  const mark = markFor(props.agentId)
  if (mark) {
    return (
      <Svg width={side} height={side} viewBox={mark.viewBox}>
        <mark.Body ink={{ scheme, text: c.text }} />
      </Svg>
    )
  }
  return (
    <Text style={{ color: c.textSecondary, fontSize: side * 0.9, fontWeight: '700' }}>
      {(props.name ?? props.agentId).trim().charAt(0).toUpperCase() || '?'}
    </Text>
  )
}

function Badge(props: { kind: Exclude<AvatarBadge, null>; side: number }) {
  const { c } = useTokens()
  const reduce = useReduceMotion()
  const halo = useRef(new Animated.Value(0)).current
  const color = {
    live: c.success,
    waiting: c.warning,
    error: c.danger,
    unread: c.tint,
  }[props.kind]
  const dot = Math.max(8, Math.round(props.side * 0.28))

  useEffect(() => {
    if (props.kind !== 'live' || reduce) return
    const loop = Animated.loop(
      Animated.timing(halo, { toValue: 1, duration: 1400, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [props.kind, reduce, halo])

  return (
    <View
      style={[styles.badge, { width: dot, height: dot, right: -1, bottom: -1 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.kind === 'live' && !reduce && (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: dot / 2,
              backgroundColor: color,
              opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
              transform: [
                { scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) },
              ],
            },
          ]}
        />
      )}
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: color,
          borderWidth: 2,
          borderColor: c.bg,
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
})

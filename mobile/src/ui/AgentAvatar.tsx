// An agent in a round avatar: its harness's mark on a quiet disc, or its initial when the phone has
// no mark for it. A dot on the edge tells a running session (breathing), one that waits for the
// user, or one that failed; a still grey one, a session that was running when last heard of.

import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import Svg from 'react-native-svg'
import { markFor } from './agent-marks'
import { useReduceMotion } from './Press'
import { size as sizes, useTokens } from './tokens'

export type AvatarBadge = 'live' | 'stale' | 'waiting' | 'error' | 'unread' | null

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

/** A running session's mark: a small bubble whose three dots pulse in turn, as a typing one does. */
function Typing(props: { side: number }) {
  const { c } = useTokens()
  const reduce = useReduceMotion()
  const phase = useRef(new Animated.Value(0)).current
  const height = Math.max(11, Math.round(props.side * 0.4))
  const width = Math.round(height * 1.9)
  const dot = Math.max(2.5, height * 0.22)

  useEffect(() => {
    if (reduce) return
    const loop = Animated.loop(
      Animated.timing(phase, { toValue: 3, duration: 1200, useNativeDriver: true }),
    )
    loop.start()
    return () => loop.stop()
  }, [reduce, phase])

  return (
    <View
      style={[
        styles.typing,
        {
          width,
          height,
          borderRadius: height / 2,
          right: -Math.round(width * 0.35),
          bottom: -Math.round(height * 0.25),
          backgroundColor: c.surfaceRaised,
          borderColor: c.bg,
          gap: dot * 0.8,
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: c.danger,
            opacity: reduce
              ? 0.8
              : phase.interpolate({
                  inputRange: [0, i, i + 0.5, i + 1, 3],
                  outputRange: [0.35, 0.35, 1, 0.35, 0.35],
                  extrapolate: 'clamp',
                }),
          }}
        />
      ))}
    </View>
  )
}

function Badge(props: { kind: Exclude<AvatarBadge, null>; side: number }) {
  if (props.kind === 'live') return <Typing side={props.side} />
  return <Dot kind={props.kind} side={props.side} />
}

function Dot(props: { kind: Exclude<AvatarBadge, null>; side: number }) {
  const { c } = useTokens()
  const reduce = useReduceMotion()
  const halo = useRef(new Animated.Value(0)).current
  const color = {
    live: c.success,
    stale: c.textTertiary,
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
  typing: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
})

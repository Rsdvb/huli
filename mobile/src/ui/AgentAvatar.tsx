// An agent in a round avatar: its harness's mark on a quiet disc, or its initial when the phone has
// no mark for it. A dot on the edge tells a running session (breathing), one that waits for the
// user, or one that failed; a still grey one, a session that was running when last heard of.
// A running one's typing bubble steps on the step clock (steps.ts).

import { StyleSheet, Text, View } from 'react-native'
import Svg from 'react-native-svg'
import { markFor } from './agent-marks'
import { StepOpacity } from './StepMarks'
import { stepsIn, useSteps } from './steps'
import { size as sizes, useTokens } from './tokens'

export type AvatarBadge = 'live' | 'stale' | 'waiting' | 'error' | 'unread' | null

export function AgentAvatar(props: {
  agentId: string
  /** The agent's name, whose initial stands in for a missing mark. */
  name?: string
  size?: number
  badge?: AvatarBadge
  /**
   * What the avatar sits on, which the badge's ring takes so it cuts the badge from the disc:
   * the screen by default, a card's surface on a card, where the screen's color read as a halo.
   */
  ring?: string
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
      {props.badge ? <Badge kind={props.badge} side={side} ring={props.ring ?? c.bg} /> : null}
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

// The typing bubble's loop: each dot bright in turn, 1.5 s round, in steps.
const TYPING = (() => {
  const n = stepsIn(1500)
  return [0, 1, 2].map((i) =>
    Array.from({ length: n }, (_, k) => {
      const at = (3 * k) / n
      const d = Math.abs(at - (i + 0.5))
      return d >= 0.5 ? 0.35 : 1 - (d / 0.5) * 0.65
    }),
  )
})()

/**
 * A running session's mark: a small bubble whose three dots pulse in turn, as a typing one does,
 * stepped on the step clock.
 */
function Typing(props: { side: number; ring: string }) {
  const { c } = useTokens()
  const steps = useSteps()
  const height = Math.max(11, Math.round(props.side * 0.4))
  const width = Math.round(height * 1.9)
  const dot = Math.max(2.5, height * 0.22)
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
          borderColor: props.ring,
          gap: dot * 0.8,
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {TYPING.map((frames, i) => (
        <StepOpacity
          key={i}
          steps={steps}
          // Held still, the bubble shows its dots evenly lit.
          frames={steps ? frames : STILL_TYPING}
          style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: c.danger }}
        />
      ))}
    </View>
  )
}

const STILL_TYPING = [0.8]

function Badge(props: { kind: Exclude<AvatarBadge, null>; side: number; ring: string }) {
  if (props.kind === 'live') return <Typing side={props.side} ring={props.ring} />
  return <Dot kind={props.kind} side={props.side} ring={props.ring} />
}

function Dot(props: { kind: Exclude<AvatarBadge, 'live' | null>; side: number; ring: string }) {
  const { c } = useTokens()
  const color = {
    stale: c.textTertiary,
    waiting: c.warning,
    error: c.danger,
    unread: c.tint,
  }[props.kind]
  const dot = Math.max(8, Math.round(props.side * 0.28))
  return (
    <View
      style={[styles.badge, { width: dot, height: dot, right: -1, bottom: -1 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: color,
          borderWidth: 2,
          borderColor: props.ring,
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

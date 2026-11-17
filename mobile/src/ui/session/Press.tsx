// Press feedback for the session screens: a control that settles a little smaller while held, a
// round icon button, and the gentle layout change a disclosure opens with. All honor Reduce Motion.

import type { ReactNode } from 'react'
import {
  AccessibilityInfo,
  LayoutAnimation,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated'
import type { SFSymbol } from 'expo-symbols'
import { GlassButton, useGlassMode } from '../Glass'
import { PRESS_IN, PRESS_OUT, spring } from '../motion'
import { useSessionTokens } from './palette'

let reduceMotion = false
void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
  reduceMotion = on
})
AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
  reduceMotion = on
})

/** Animates the next layout change softly, as a row opens or closes. */
export function gentle(): void {
  if (reduceMotion) return
  LayoutAnimation.configureNext({
    duration: 200,
    create: { type: 'easeInEaseOut', property: 'opacity' },
    update: { type: 'easeInEaseOut' },
    delete: { type: 'easeInEaseOut', property: 'opacity' },
  })
}

export interface PressScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  style?: StyleProp<ViewStyle>
  /** The pressable around the scaled view, for its place in a row. */
  outerStyle?: StyleProp<ViewStyle>
  /** How small it gets while held. */
  scale?: number
  children: ReactNode
}

export function PressScale(props: PressScaleProps) {
  const { style, outerStyle, scale = 0.96, children, onPressIn, onPressOut, ...rest } = props
  const reduce = useReducedMotion()
  const value = useSharedValue(1)
  const scaled = useAnimatedStyle(() => ({ transform: [{ scale: value.value }] }))
  // In quickly and all the way, out a touch slower with a small overshoot, as iOS controls settle.
  const to = (target: number) => {
    if (reduce) return
    value.value = spring(target, target === 1 ? PRESS_OUT : PRESS_IN, reduce)
  }
  return (
    <Pressable
      {...rest}
      style={outerStyle}
      onPressIn={(event) => {
        to(scale)
        onPressIn?.(event)
      }}
      onPressOut={(event) => {
        to(1)
        onPressOut?.(event)
      }}
    >
      {({ pressed }) => (
        <Reanimated.View style={[style, scaled, pressed && reduce ? { opacity: 0.6 } : null]}>
          {children}
        </Reanimated.View>
      )}
    </Pressable>
  )
}

/**
 * A round icon button on a soft fill, as the header and the composer use. Glass is Liquid Glass
 * where the system has it; accent is glass tinted with Huli's orange there, a solid disc elsewhere.
 */
export function RoundButton(
  props: Omit<PressScaleProps, 'children'> & {
    size?: number
    tone?: 'fill' | 'glass' | 'accent' | 'warning'
    /** The icon as an SF Symbol, for the system's own glass button where there is one. */
    systemImage?: SFSymbol
    children: ReactNode
  },
) {
  const { c, s } = useSessionTokens()
  const mode = useGlassMode()
  const { size = 40, tone = 'fill', style, disabled, systemImage, ...rest } = props
  if (tone === 'glass' || (tone === 'accent' && mode === 'liquid')) {
    const { scale: _scale, outerStyle, ...pressable } = rest
    return (
      <GlassButton
        {...pressable}
        silent
        size={size}
        {...(systemImage ? { systemImage } : {})}
        {...(tone === 'accent' ? { symbolColor: c.onAccent } : {})}
        disabled={disabled}
        elevated={tone === 'glass'}
        {...(tone === 'accent' ? { tint: c.accent } : {})}
        {...(outerStyle ? { outerStyle } : {})}
        style={style}
      />
    )
  }
  const background = tone === 'accent' ? c.accent : tone === 'warning' ? s.warningSoft : c.fill
  return (
    <PressScale
      hitSlop={6}
      accessibilityRole="button"
      disabled={disabled}
      {...rest}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: background,
          opacity: disabled ? 0.38 : 1,
        },
        style,
      ]}
    />
  )
}

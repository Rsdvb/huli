// Press feedback for the session screens: a control that settles a little smaller while held, a
// round icon button, and the gentle layout change a disclosure opens with. All honor Reduce Motion.

import { useRef, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Animated,
  LayoutAnimation,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
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
  const { style, outerStyle, scale = 0.94, children, onPressIn, onPressOut, ...rest } = props
  const value = useRef(new Animated.Value(1)).current
  const to = (target: number) => {
    if (reduceMotion) return
    Animated.spring(value, {
      toValue: target,
      useNativeDriver: true,
      speed: 40,
      bounciness: target === 1 ? 6 : 0,
    }).start()
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
        <Animated.View
          style={[
            style,
            { transform: [{ scale: value }] },
            pressed && reduceMotion ? { opacity: 0.6 } : null,
          ]}
        >
          {children}
        </Animated.View>
      )}
    </Pressable>
  )
}

/** A round icon button on a soft fill, as the header and the composer use. */
export function RoundButton(
  props: Omit<PressScaleProps, 'children'> & {
    size?: number
    tone?: 'fill' | 'glass' | 'accent' | 'warning'
    children: ReactNode
  },
) {
  const { c, s } = useSessionTokens()
  const { size = 40, tone = 'fill', style, disabled, ...rest } = props
  const background =
    tone === 'accent'
      ? c.accent
      : tone === 'warning'
        ? s.warningSoft
        : tone === 'glass'
          ? c.glass
          : c.fill
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
        tone === 'glass' ? { borderWidth: 0.5, borderColor: c.borderStrong } : null,
        style,
      ]}
    />
  )
}

// The app's pressable: a slight shrink and fade under the finger and a springy release, as iOS
// controls do, run on the UI thread by Reanimated. Reduce Motion keeps the fade and drops the
// shrink.

import { useEffect, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated'
import { PRESS_IN, PRESS_OUT, spring } from './motion'
import { motion } from './tokens'

let reduceMotion = false
void AccessibilityInfo.isReduceMotionEnabled().then((on) => (reduceMotion = on))
AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => (reduceMotion = on))

/** Whether the user asked for less motion, kept current. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(reduceMotion)
  useEffect(() => {
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn)
    return () => sub.remove()
  }, [])
  return on
}

export interface PressProps extends Omit<PressableProps, 'style' | 'children'> {
  children?: ReactNode
  /** The pressed body's style. */
  style?: StyleProp<ViewStyle>
  /** The outer touch area's style, for flex and margins in a row. */
  containerStyle?: StyleProp<ViewStyle>
  /** Shrink under the finger; off for wide rows, which only fade. */
  scale?: boolean
  /** A wide row's pressed color, drawn under its content in place of the fade, as iOS lists do. */
  highlight?: string
}

export function Press({
  children,
  style,
  containerStyle,
  scale = true,
  highlight,
  disabled,
  onPressIn,
  onPressOut,
  ...rest
}: PressProps) {
  const reduce = useReducedMotion()
  const pressed = useSharedValue(0)
  const shrink = scale && !reduce ? motion.pressScale : 1
  const body = useAnimatedStyle(() => ({
    opacity: highlight ? 1 : interpolate(pressed.value, [0, 1], [1, motion.pressOpacity], 'clamp'),
    transform: [{ scale: interpolate(pressed.value, [0, 1], [1, shrink]) }],
  }))
  const wash = useAnimatedStyle(() => ({
    opacity: interpolate(pressed.value, [0, 1], [0, 1], 'clamp'),
  }))

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={containerStyle}
      onPressIn={(event: GestureResponderEvent) => {
        pressed.value = spring(1, PRESS_IN, reduce)
        onPressIn?.(event)
      }}
      onPressOut={(event: GestureResponderEvent) => {
        pressed.value = spring(0, PRESS_OUT, reduce)
        onPressOut?.(event)
      }}
    >
      <Reanimated.View style={[style, disabled ? { opacity: 0.4 } : body]}>
        {highlight && !disabled ? (
          <Reanimated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: highlight }, wash]}
          />
        ) : null}
        {children}
      </Reanimated.View>
    </Pressable>
  )
}

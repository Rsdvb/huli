// The app's pressable: a quick fade and a slight shrink under the finger, and a springy release,
// as iOS controls do. Reduce Motion keeps the fade and drops the shrink.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
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
  const pressed = useRef(new Animated.Value(0)).current
  // Down at once; back up on a spring whose small overshoot reads as the control letting go.
  const to = (value: number) =>
    (value
      ? Animated.timing(pressed, { toValue: 1, duration: 70, useNativeDriver: true })
      : Animated.spring(pressed, {
          toValue: 0,
          useNativeDriver: true,
          speed: 28,
          bounciness: reduceMotion ? 0 : 7,
        })
    ).start()

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={containerStyle}
      onPressIn={(event: GestureResponderEvent) => {
        to(1)
        onPressIn?.(event)
      }}
      onPressOut={(event: GestureResponderEvent) => {
        to(0)
        onPressOut?.(event)
      }}
    >
      <Animated.View
        style={[
          style,
          disabled
            ? { opacity: 0.4 }
            : {
                opacity: highlight
                  ? 1
                  : pressed.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, motion.pressOpacity],
                      extrapolate: 'clamp',
                    }),
                transform: [
                  {
                    scale: pressed.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, scale && !reduceMotion ? motion.pressScale : 1],
                    }),
                  },
                ],
              },
        ]}
      >
        {highlight && !disabled ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: highlight,
                opacity: pressed.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 1],
                  extrapolate: 'clamp',
                }),
              },
            ]}
          />
        ) : null}
        {children}
      </Animated.View>
    </Pressable>
  )
}

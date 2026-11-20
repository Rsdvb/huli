// Marks that move on the step clock (steps.ts): a view whose opacity steps through frames, and the
// spinner of something that runs. Under Reduce Motion they hold their first frame.

import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { useSteps } from './steps'

/** A view whose opacity is `frames[step % frames.length]` on the step clock. */
export function StepOpacity(props: {
  steps: SharedValue<number> | null
  frames: readonly number[]
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}) {
  const { steps, frames } = props
  const animated = useAnimatedStyle(
    () => ({ opacity: frames[steps ? steps.value % frames.length : 0] }),
    [steps, frames],
  )
  return <Reanimated.View style={[props.style, animated]}>{props.children}</Reanimated.View>
}

const SPOKES = 8
const SPOKE_OPACITY = Array.from({ length: SPOKES }, (_, i) => 1 - (i * 0.7) / (SPOKES - 1))

/**
 * Something that runs, as iOS's spinner draws it: eight spokes fading around a circle, the
 * brightest moving on one spoke a step. `size` is its diameter.
 */
export function Spinner(props: {
  color: string
  size?: number
  /** Whether it shows; while not, it holds still. */
  on?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const size = props.size ?? 20
  const steps = useSteps(props.on ?? true)
  const turn = useAnimatedStyle(
    () => ({
      transform: [{ rotate: `${steps ? (steps.value % SPOKES) * (360 / SPOKES) : 0}deg` }],
    }),
    [steps],
  )
  const width = Math.max(1.5, size * 0.11)
  const height = size * 0.28
  return (
    <View
      style={[{ width: size, height: size }, props.style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, turn]}>
        {SPOKE_OPACITY.map((opacity, i) => (
          <View
            key={i}
            style={[
              StyleSheet.absoluteFill,
              styles.center,
              { transform: [{ rotate: `${-i * (360 / SPOKES)}deg` }] },
            ]}
          >
            <View
              style={{
                width,
                height,
                borderRadius: width / 2,
                backgroundColor: props.color,
                opacity,
                transform: [{ translateY: -(size - height) / 2 }],
              }}
            />
          </View>
        ))}
      </Reanimated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
})

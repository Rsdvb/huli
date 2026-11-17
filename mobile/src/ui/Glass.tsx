// The app's glass, one primitive for every control that floats over content. On iOS 26 and later
// it is the system's own Liquid Glass (expo-glass-effect): it bends what is under it, reacts to the
// finger when interactive, and melts into its neighbors inside a `GlassGroup`. Older iOS gets the
// frosted blur the app used before, Android a translucent fill, and Reduce Transparency an opaque
// surface on either.

import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { BlurView } from 'expo-blur'
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect'
import { haptic } from './haptics'
import { useReduceMotion } from './Press'
import { motion, size as sizes, useTokens } from './tokens'

/** Whether the system's Liquid Glass can be drawn at all, which never changes while the app runs. */
export const LIQUID_GLASS =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()

let reduceTransparency = false
void AccessibilityInfo.isReduceTransparencyEnabled().then((on) => (reduceTransparency = on))
AccessibilityInfo.addEventListener('reduceTransparencyChanged', (on) => (reduceTransparency = on))

/** Whether the user asked for less transparency, kept current. */
export function useReduceTransparency(): boolean {
  const [on, setOn] = useState(reduceTransparency)
  useEffect(() => {
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setOn)
    // The first answer may land after this mounted.
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setOn)
    return () => sub.remove()
  }, [])
  return on
}

/** How glass is drawn here and now. */
export type GlassMode = 'liquid' | 'blur' | 'fill' | 'solid'

export function useGlassMode(): GlassMode {
  const reduce = useReduceTransparency()
  if (reduce) return 'solid'
  if (LIQUID_GLASS) return 'liquid'
  return Platform.OS === 'ios' ? 'blur' : 'fill'
}

export type GlassShape = 'circle' | 'capsule' | 'rounded'

export interface GlassProps {
  /** A circle or capsule rounds to half its height; a rounded rect takes `radius`. */
  shape?: GlassShape
  radius?: number
  /** Colors the glass, as the send button's orange; a soft fill where there is no Liquid Glass. */
  tint?: ColorValue
  /** Liquid Glass that answers the finger: it swells and glows under a touch. */
  interactive?: boolean
  /** 'clear' lets more of the content through, for glass over media. */
  variant?: 'regular' | 'clear'
  /** A soft drop shadow where the glass is drawn by the app, as Liquid Glass casts its own. */
  elevated?: boolean
  /** No hairline edge on the fallbacks, for glass that sits flush, as a header's. */
  borderless?: boolean
  style?: StyleProp<ViewStyle>
  children?: ReactNode
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only'
  onLayout?: (event: LayoutChangeEvent) => void
  ref?: Ref<ComponentRef<typeof View>>
  accessible?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'tablist' | 'toolbar' | 'menu' | 'none'
  accessibilityViewIsModal?: boolean
  collapsable?: false
}

function heightOf(style: StyleProp<ViewStyle>): number | null {
  const flat = StyleSheet.flatten(style)
  return typeof flat?.height === 'number' ? flat.height : null
}

/**
 * A surface of glass that holds its children. Liquid Glass puts them in its content, where they
 * take on its vibrancy; the fallbacks draw the material behind them.
 */
export function Glass(props: GlassProps) {
  const { c, scheme } = useTokens()
  const mode = useGlassMode()
  const shape = props.shape ?? 'rounded'
  const fixed = heightOf(props.style)
  const [measured, setMeasured] = useState<number | null>(null)
  const half = (measured ?? fixed ?? sizes.hit) / 2
  const round = shape === 'rounded' ? (props.radius ?? 0) : half
  const onLayout = (event: LayoutChangeEvent) => {
    if (shape !== 'rounded') {
      const height = event.nativeEvent.layout.height
      if (height !== measured) setMeasured(height)
    }
    props.onLayout?.(event)
  }
  const common = {
    ref: props.ref,
    pointerEvents: props.pointerEvents,
    onLayout,
    accessible: props.accessible,
    accessibilityLabel: props.accessibilityLabel,
    accessibilityRole: props.accessibilityRole,
    accessibilityViewIsModal: props.accessibilityViewIsModal,
    collapsable: props.collapsable,
  }

  if (mode === 'liquid') {
    return (
      <GlassView
        {...common}
        glassEffectStyle={props.variant ?? 'regular'}
        isInteractive={!!props.interactive}
        colorScheme={scheme}
        {...(props.tint ? { tintColor: props.tint } : {})}
        style={[props.style, { borderRadius: round, borderCurve: 'continuous' }]}
      >
        {props.children}
      </GlassView>
    )
  }

  const edge = props.borderless
    ? null
    : { borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderStrong }
  const shadow = props.elevated ? [styles.shadow, { shadowColor: c.shadow }] : null
  const solid = mode === 'solid'
  return (
    <View
      {...common}
      style={[
        { borderRadius: round, borderCurve: 'continuous' },
        edge,
        shadow,
        {
          backgroundColor: solid
            ? (props.tint ?? c.surfaceRaised)
            : mode === 'fill'
              ? (props.tint ?? c.glass)
              : 'transparent',
        },
        props.style,
      ]}
    >
      {mode === 'blur' && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: round, overflow: 'hidden' }]}
        >
          <BlurView
            tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
            intensity={90}
            style={StyleSheet.absoluteFill}
          />
          {props.tint ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: props.tint }]} />
          ) : null}
        </View>
      )}
      {props.children}
    </View>
  )
}

/** Glass behind other content, filling its parent: for a surface whose children it can't hold. */
export function GlassBackdrop(props: {
  radius: number
  tint?: ColorValue
  variant?: 'regular' | 'clear'
  borderless?: boolean
}) {
  return (
    <Glass
      pointerEvents="none"
      radius={props.radius}
      {...(props.tint ? { tint: props.tint } : {})}
      {...(props.variant ? { variant: props.variant } : {})}
      borderless={props.borderless ?? true}
      style={StyleSheet.absoluteFill}
    />
  )
}

/**
 * Neighbors that melt together as they come within `spacing` of each other, as the tab bar and its
 * round button do while one gives way to the other. A plain view without Liquid Glass.
 */
export function GlassGroup(props: {
  spacing?: number
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}) {
  const mode = useGlassMode()
  if (mode !== 'liquid') return <View style={props.style}>{props.children}</View>
  return (
    <GlassContainer spacing={props.spacing ?? 0} style={props.style}>
      {props.children}
    </GlassContainer>
  )
}

export interface GlassButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** The circle's side; 44pt by default, the smallest comfortable target. */
  size?: number
  tint?: ColorValue
  /** A capsule that fits its content, rather than a circle. */
  capsule?: boolean
  elevated?: boolean
  /** The glass's own style, for a capsule's padding. */
  style?: StyleProp<ViewStyle>
  /** The pressable around the glass, for its place in a row. */
  outerStyle?: StyleProp<ViewStyle>
  /** No tap haptic, for a button whose action has its own. */
  silent?: boolean
  children?: ReactNode
  ref?: Ref<ComponentRef<typeof View>>
}

/**
 * A round (or capsule) button of glass holding an icon. Liquid Glass answers the touch itself;
 * elsewhere it settles a little smaller while held. Either way a light tap of haptics.
 */
export function GlassButton(props: GlassButtonProps) {
  const {
    size = sizes.hit,
    tint,
    capsule,
    elevated = true,
    style,
    outerStyle,
    silent,
    children,
    disabled,
    onPress,
    onPressIn,
    onPressOut,
    ref,
    ...rest
  } = props
  const mode = useGlassMode()
  const reduce = useReduceMotion()
  const scale = useRef(new Animated.Value(1)).current
  const native = mode === 'liquid'
  const to = (value: number) => {
    if (native || reduce) return
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: value < 1 ? 50 : 30,
      bounciness: value < 1 ? 0 : 8,
    }).start()
  }
  return (
    <Pressable
      hitSlop={Math.max(4, (sizes.hit - size) / 2)}
      accessibilityRole="button"
      {...rest}
      disabled={disabled}
      style={outerStyle}
      onPressIn={(event) => {
        to(motion.pressScale)
        onPressIn?.(event)
      }}
      onPressOut={(event) => {
        to(1)
        onPressOut?.(event)
      }}
      onPress={(event) => {
        if (!silent) haptic.tap()
        onPress?.(event)
      }}
    >
      {({ pressed }) => (
        <Animated.View
          style={{
            transform: [{ scale }],
            opacity: disabled ? 0.38 : pressed && reduce && !native ? motion.pressOpacity : 1,
          }}
        >
          <Glass
            ref={ref}
            collapsable={false}
            shape={capsule ? 'capsule' : 'circle'}
            interactive={!disabled}
            elevated={elevated}
            {...(tint ? { tint } : {})}
            style={[
              styles.center,
              capsule ? { height: size, minWidth: size } : { width: size, height: size },
              style,
            ]}
          >
            {children}
          </Glass>
        </Animated.View>
      )}
    </Pressable>
  )
}

/** A capsule of glass, laid out as a row: a title pill, a status tag, a floating chip. */
export function GlassCapsule(
  props: Omit<GlassProps, 'shape'> & {
    /** Its height; the content sets its width. */
    height?: number
  },
) {
  const { height = sizes.hit, style, ...rest } = props
  return <Glass {...rest} shape="capsule" style={[styles.capsule, { height }, style]} />
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  capsule: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 6 },
  shadow: {
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
})

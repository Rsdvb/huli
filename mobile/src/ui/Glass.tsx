// The app's glass, one primitive for every control that floats over content. On iOS 26 and later
// it is the system's own Liquid Glass (expo-glass-effect): it bends what is under it, reacts to the
// finger when interactive, and melts into its neighbors inside a `GlassGroup`. Older iOS gets the
// frosted blur the app used before, Android a translucent fill, and Reduce Transparency an opaque
// surface on either.

import { useEffect, useId, useState, type ComponentRef, type ReactNode, type Ref } from 'react'
import {
  AccessibilityInfo,
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
import Reanimated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { BlurView } from 'expo-blur'
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect'
import type { SFSymbol } from 'expo-symbols'
import { haptic } from './haptics'
import { PRESS_IN, PRESS_OUT, spring, useReducedMotion } from './motion'
import { SystemButton } from './SystemButton'
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
  /**
   * Liquid Glass melts away, on its own animation, while the view stays laid out: glass under a
   * fading opacity draws nothing, so a view that comes and goes over content dematerializes
   * instead. The fallbacks ignore it, and their owner fades them.
   */
  dematerialized?: boolean
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
  const reduce = useReducedMotion()
  // Glass that mounts melted away starts so, rather than melting away as it first draws.
  const [initial] = useState(props.dematerialized)
  const [changed, setChanged] = useState(false)
  if (!changed && props.dematerialized !== initial) setChanged(true)
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
        glassEffectStyle={
          props.dematerialized === undefined
            ? (props.variant ?? 'regular')
            : {
                style: props.dematerialized ? 'none' : (props.variant ?? 'regular'),
                animate: changed && !reduce,
                animationDuration: 0.25,
              }
        }
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
  /** A capsule rounds to half the height it fills; a rounded rect takes `radius`. */
  shape?: 'capsule' | 'rounded'
  radius?: number
  tint?: ColorValue
  variant?: 'regular' | 'clear'
  borderless?: boolean
}) {
  return (
    <Glass
      pointerEvents="none"
      shape={props.shape ?? 'rounded'}
      {...(props.radius !== undefined ? { radius: props.radius } : {})}
      {...(props.tint ? { tint: props.tint } : {})}
      {...(props.variant ? { variant: props.variant } : {})}
      borderless={props.borderless ?? true}
      style={StyleSheet.absoluteFill}
    />
  )
}

/**
 * The soft edge iOS 26 gives a scroll view under floating glass controls in place of a bar: the
 * screen's color, strong under the status bar and fading out below the controls.
 */
export function ScrollEdge(props: {
  color: string
  height: number
  /**
   * How far down, as a share of the height, the edge stays nearly opaque before it fades: high
   * where controls sit over busy content such as a tab's charts, so nothing shows through them.
   */
  solid?: number
}) {
  // useId's colons do not survive in an SVG url().
  const id = `edge${useId().replace(/\W/g, '')}`
  const solid = Math.min(0.95, Math.max(0, props.solid ?? 0.45))
  return (
    <View pointerEvents="none" style={[styles.edge, { height: props.height }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={props.color} stopOpacity={0.98} />
            <Stop offset={solid} stopColor={props.color} stopOpacity={0.92} />
            <Stop offset="1" stopColor={props.color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
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
  /**
   * The icon as an SF Symbol: with Liquid Glass the button is then the system's own, which draws
   * the symbol itself in place of the children.
   */
  systemImage?: SFSymbol
  /** The symbol's color in the system's button; its label color by default. */
  symbolColor?: ColorValue
  /** The glass melts away, as `Glass`'s `dematerialized`; the owner fades the children. */
  dematerialized?: boolean
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
    systemImage,
    symbolColor,
    dematerialized,
    children,
    disabled,
    onPress,
    onPressIn,
    onPressOut,
    ref,
    ...rest
  } = props
  const mode = useGlassMode()
  const reduce = useReducedMotion()
  const scale = useSharedValue(1)
  const native = mode === 'liquid'
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const to = (value: number) => {
    if (native || reduce) return
    scale.value = spring(value, value < 1 ? PRESS_IN : PRESS_OUT, reduce)
  }
  // The system's own glass button where it has the icon: its glass, press and feel are iOS's.
  if (native && systemImage && !capsule && onPress) {
    return (
      <SystemButton
        systemImage={systemImage}
        size={size}
        label={rest.accessibilityLabel ?? ''}
        {...(tint ? { tint } : {})}
        {...(symbolColor ? { color: symbolColor } : {})}
        {...(disabled ? { disabled: true } : {})}
        onPress={() => {
          if (!silent) haptic.tap()
          onPress(undefined as never)
        }}
      />
    )
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
        <Reanimated.View
          style={[
            pressStyle,
            { opacity: disabled ? 0.38 : pressed && reduce && !native ? motion.pressOpacity : 1 },
          ]}
        >
          <Glass
            ref={ref}
            collapsable={false}
            shape={capsule ? 'capsule' : 'circle'}
            interactive={!disabled}
            elevated={elevated}
            {...(dematerialized !== undefined ? { dematerialized } : {})}
            {...(tint ? { tint } : {})}
            style={[
              styles.center,
              capsule ? { height: size, minWidth: size } : { width: size, height: size },
              style,
            ]}
          >
            {children}
          </Glass>
        </Reanimated.View>
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
  edge: { position: 'absolute', top: 0, left: 0, right: 0 },
  capsule: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 6 },
  shadow: {
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
})

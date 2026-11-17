// A screen's backdrop: the base color with a soft glow falling from the top edge, which gives the
// dark scheme its depth. Content lays itself out; edges pad for the safe area when asked.

import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { useTokens } from './tokens'

const GLOW_HEIGHT = 420

export function Glow() {
  const { c } = useTokens()
  return (
    <View pointerEvents="none" style={styles.glow}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="screen-glow" cx="50%" cy="0%" rx="85%" ry="100%">
            <Stop offset="0" stopColor={c.bgGlow} stopOpacity={1} />
            <Stop offset="0.55" stopColor={c.bgGlow} stopOpacity={0.45} />
            <Stop offset="1" stopColor={c.bg} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#screen-glow)" />
      </Svg>
    </View>
  )
}

export function Screen(props: {
  children?: ReactNode
  /** Pad for the safe area at these edges; tab screens leave it to their top bar. */
  edges?: ('top' | 'bottom')[]
  glow?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const { c } = useTokens()
  const insets = useSafeAreaInsets()
  const edges = props.edges ?? []
  return (
    <View
      style={[
        styles.page,
        {
          backgroundColor: c.bg,
          paddingTop: edges.includes('top') ? insets.top : 0,
          paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
        },
        props.style,
      ]}
    >
      {props.glow !== false && <Glow />}
      {props.children}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: GLOW_HEIGHT },
})

// Kite's icon as the home screen shows it, in vector: tools/huli/brand/kite-light.svg on its tile.

import { useId } from 'react'
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg'
import { brand } from './tokens'

const KITE = brand.kite
const SHAPE = 'M0 -153 L151 0 L0 297 L-151 0 Z'

/** The kite on its rounded orange tile, as the home screen shows the app. */
export function HuliIcon(props: { size: number }) {
  const id = `kite${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  // Small icons get the thicker string the icon's small sizes have, so it stays a line.
  const small = props.size < 40
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={KITE.groundLight} />
          <Stop offset="1" stopColor={KITE.groundDark} />
        </LinearGradient>
        <ClipPath id={`${id}s`}>
          <Rect x="0" y="-200" width="200" height="560" />
        </ClipPath>
      </Defs>
      <Rect x="0" y="0" width="1024" height="1024" rx="230" fill={`url(#${id}g)`} />
      <Path
        d="M513 630 C507 680 457 731 407 745 S307 810 301 860"
        fill="none"
        stroke={KITE.paper}
        strokeWidth={small ? 40 : 20}
        strokeLinecap="round"
      />
      <Circle cx="301" cy="860" r={small ? 50 : 30} fill={KITE.paper} />
      <G transform="translate(575 340) rotate(12)" strokeLinejoin="round">
        <Path d={SHAPE} fill={KITE.paper} stroke={KITE.paper} strokeWidth={20} />
        <Path
          d={SHAPE}
          fill={KITE.paperShade}
          stroke={KITE.paperShade}
          strokeWidth={20}
          clipPath={`url(#${id}s)`}
        />
        {!small && (
          <G
            fill="none"
            stroke={KITE.spar}
            strokeOpacity={0.22}
            strokeWidth={7}
            strokeLinecap="round"
          >
            <Path d="M0 -143 L0 285" />
            <Path d="M-141 0 Q0 -24 141 0" />
          </G>
        )}
      </G>
    </Svg>
  )
}

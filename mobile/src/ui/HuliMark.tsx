// Huli's fox as the app icon draws it, in vector: on its orange tile, or the face alone.

import { useId } from 'react'
import Svg, { Defs, LinearGradient, Path, Polygon, Rect, Stop } from 'react-native-svg'
import { brand } from './tokens'

const FOX = brand.fox

function Face() {
  return (
    <>
      <Polygon points="278,205 470,366 316,428" fill={FOX.face} />
      <Polygon points="746,205 554,366 708,428" fill={FOX.faceShade} />
      <Polygon points="300,274 422,380 318,420" fill={FOX.ear} />
      <Polygon points="724,274 602,380 706,420" fill={FOX.ear} />
      <Polygon points="512,354 470,366 316,428 220,550 512,818" fill={FOX.face} />
      <Polygon points="512,354 554,366 708,428 804,550 512,818" fill={FOX.faceShade} />
      <Polygon points="324,430 340,544 226,550" fill={FOX.cheek} />
      <Polygon points="700,430 684,544 798,550" fill={FOX.cheek} />
      <Path d="M374 556 Q418 518 462 546 Q418 590 374 556 Z" fill={FOX.nose} />
      <Path d="M650 556 Q606 518 562 546 Q606 590 650 556 Z" fill={FOX.nose} />
      <Path
        d="M466 716 L558 716 Q566 720 560 730 L520 786 Q512 794 504 786 L464 730 Q458 720 466 716 Z"
        fill={FOX.nose}
      />
    </>
  )
}

/** The fox on its rounded orange tile, as the home screen shows the app. */
export function HuliIcon(props: { size: number }) {
  const id = `fox${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={FOX.groundLight} />
          <Stop offset="1" stopColor={FOX.groundDark} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="1024" height="1024" rx="230" fill={`url(#${id})`} />
      <Face />
    </Svg>
  )
}

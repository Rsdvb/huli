// One icon by two names: the SF Symbol iOS draws natively, crisp at any size and weight, and the
// Lucide icon Android and any symbol iOS lacks fall back to.

import { Platform, type StyleProp, type ViewStyle } from 'react-native'
import { SymbolView, type SFSymbol, type SymbolWeight } from 'expo-symbols'
import type { LucideIcon } from 'lucide-react-native'

export const STROKE = 1.9

export interface IconSpec {
  sf: SFSymbol
  lucide: LucideIcon
}

export function Icon(props: {
  icon: IconSpec
  size?: number
  color: string
  weight?: SymbolWeight
  /** Lucide's stroke; SF Symbols take `weight` instead. */
  strokeWidth?: number
  style?: StyleProp<ViewStyle>
}) {
  const { icon, color } = props
  const size = props.size ?? 18
  const Fallback = icon.lucide
  const fallback = (
    <Fallback
      size={size}
      color={color}
      strokeWidth={props.strokeWidth ?? STROKE}
      style={props.style}
    />
  )
  if (Platform.OS !== 'ios') return fallback
  return (
    <SymbolView
      name={icon.sf}
      size={size}
      tintColor={color}
      weight={props.weight ?? 'medium'}
      resizeMode="scaleAspectFit"
      fallback={fallback}
      style={[{ width: size, height: size }, props.style]}
    />
  )
}

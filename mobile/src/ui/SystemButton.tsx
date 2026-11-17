// Android and the web have no system glass button; GlassButton draws its own there and never
// renders this. SystemButton.ios.tsx is iOS's.

import type { ColorValue } from 'react-native'
import type { SFSymbol } from 'expo-symbols'

export const SystemButton: (props: {
  systemImage: SFSymbol
  size: number
  label: string
  tint?: ColorValue
  color?: ColorValue
  disabled?: boolean
  onPress(): void
}) => null = () => null

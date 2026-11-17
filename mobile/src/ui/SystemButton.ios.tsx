// The system's own round glass button, SwiftUI's Button in the glass style iOS 26 gives its bar
// buttons: its glass, its press response and its haptics are the system's. Tinted, it is the
// prominent style, as the send button. GlassButton uses it for an icon the system has.

import type { ColorValue } from 'react-native'
import { Button, Host, Image } from '@expo/ui/swift-ui'
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  disabled,
  frame,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import type { SFSymbol } from 'expo-symbols'

// The glass style's own padding around its label, which the label's frame leaves room for.
const PADDING = 12

export function SystemButton(props: {
  systemImage: SFSymbol
  size: number
  label: string
  tint?: ColorValue
  /** The symbol's color; the system's label color by default. */
  color?: ColorValue
  disabled?: boolean
  onPress(): void
}) {
  const side = Math.max(16, props.size - PADDING * 2)
  return (
    <Host matchContents>
      <Button
        onPress={props.onPress}
        modifiers={[
          buttonStyle(props.tint ? 'glassProminent' : 'glass'),
          buttonBorderShape('circle'),
          ...(props.tint ? [tint(props.tint as string)] : []),
          accessibilityLabel(props.label),
          ...(props.disabled ? [disabled(true)] : []),
        ]}
      >
        <Image
          systemName={props.systemImage}
          size={Math.round(props.size * 0.4)}
          {...(props.color ? { color: props.color } : {})}
          modifiers={[frame({ width: side, height: side })]}
        />
      </Button>
    </Host>
  )
}

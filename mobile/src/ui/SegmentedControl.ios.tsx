// A segmented control: iOS's own UISegmentedControl, through SwiftUI's segmented Picker, so its
// glass, its sliding thumb and its haptics are the system's. SegmentedControl.tsx is Android's.

import { Host, Picker, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { useTokens } from './tokens'

export interface Segment<K extends string> {
  key: K
  label: string
}

export function SegmentedControl<K extends string>(props: {
  segments: readonly Segment<K>[]
  value: K
  onChange(key: K): void
}) {
  const { scheme } = useTokens()
  return (
    <Host matchContents={{ vertical: true }} colorScheme={scheme} style={{ alignSelf: 'stretch' }}>
      <Picker
        selection={props.value}
        onSelectionChange={(key: K) => {
          if (key !== props.value) props.onChange(key)
        }}
        modifiers={[pickerStyle('segmented')]}
      >
        {props.segments.map((s) => (
          <Text key={s.key} modifiers={[tag(s.key)]}>
            {s.label}
          </Text>
        ))}
      </Picker>
    </Host>
  )
}

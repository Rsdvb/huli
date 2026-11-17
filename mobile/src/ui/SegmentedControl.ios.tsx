// A segmented control: iOS's own UISegmentedControl, so its glass, its sliding thumb and its
// haptics are the system's. It is a plain native view laid out like any other: the SwiftUI
// Picker in a Host drew itself apart from its place in a scrolling page, over the content below.
// SegmentedControl.tsx is Android's.

import type { ComponentType } from 'react'
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native'
import SegmentedControlView from '@react-native-segmented-control/segmented-control'
import { useTokens } from './tokens'

// The package's own types describe a class for an older React; this is what it takes.
const NativeSegmentedControl = SegmentedControlView as unknown as ComponentType<{
  values: string[]
  selectedIndex: number
  appearance?: 'light' | 'dark'
  onChange?: (event: NativeSyntheticEvent<{ selectedSegmentIndex: number }>) => void
  style?: StyleProp<ViewStyle>
}>

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
  const index = Math.max(
    0,
    props.segments.findIndex((s) => s.key === props.value),
  )
  return (
    <NativeSegmentedControl
      values={props.segments.map((s) => s.label)}
      selectedIndex={index}
      appearance={scheme}
      onChange={(event) => {
        const next = props.segments[event.nativeEvent.selectedSegmentIndex]
        if (next && next.key !== props.value) props.onChange(next.key)
      }}
      style={{ alignSelf: 'stretch', height: 34 }}
    />
  )
}

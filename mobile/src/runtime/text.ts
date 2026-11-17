// Dynamic Type for every Text and TextInput in the app, set once here rather than in each file:
// text follows the system's text size, up to a cap that keeps rows, bars and cards intact. React
// Native 0.88's Text is a function component, which React 19 gives no defaultProps, so the
// `react-native` module's Text and TextInput are swapped for thin wrappers that fill in the cap
// when a caller sets none. Callers that name `maxFontSizeMultiplier` keep their own, as dense
// controls do with FONT_SCALE.dense (ui/tokens.ts).
//
// This must load before any screen: index.ts imports it first. The module's exports are getters
// (react-native/index.js), so replacing them reaches every later `import { Text }` too.

import { createElement, type ComponentProps } from 'react'
import type { TextProps } from 'react-native'
import { FONT_SCALE } from '../ui/tokens'

// The module object itself: `import * as` would hand over a copy, and changing a copy reaches no one.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ReactNative = require('react-native') as typeof import('react-native')

const BaseText = ReactNative.Text
const BaseTextInput = ReactNative.TextInput

/** Large type (titles, figures) is big already: it grows less than body text does. */
const LARGE = 20

function capFor(style: TextProps['style']): number {
  const flat = ReactNative.StyleSheet.flatten(style) as { fontSize?: number } | undefined
  return (flat?.fontSize ?? 0) >= LARGE ? FONT_SCALE.dense : FONT_SCALE.body
}

function ScaledText(props: ComponentProps<typeof BaseText>) {
  if (props.maxFontSizeMultiplier !== undefined) return createElement(BaseText, props)
  return createElement(BaseText, { ...props, maxFontSizeMultiplier: capFor(props.style) })
}
ScaledText.displayName = 'Text'

function ScaledTextInput(props: ComponentProps<typeof BaseTextInput>) {
  if (props.maxFontSizeMultiplier !== undefined) return createElement(BaseTextInput, props)
  return createElement(BaseTextInput, { ...props, maxFontSizeMultiplier: FONT_SCALE.body })
}
ScaledTextInput.displayName = 'TextInput'
// TextInput carries statics screens use, such as State for the focused field.
Object.assign(ScaledTextInput, BaseTextInput)

function replace(name: 'Text' | 'TextInput', value: unknown): void {
  try {
    Object.defineProperty(ReactNative, name, {
      configurable: true,
      enumerable: true,
      get: () => value,
    })
  } catch {
    // A module object that cannot be changed keeps the system's uncapped text; nothing breaks.
  }
}

replace('Text', ScaledText)
replace('TextInput', ScaledTextInput)

// Android and the web: no system context menu, so a view's long press (or a control's tap) opens
// the menu as a sheet from the bottom. ContextMenu.ios.tsx is the iOS one.

import type { ReactElement } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import type { MenuNode } from './menu'
import { openMenuSheet } from './MenuSheet'

/** Whether long presses open the system's context menu here. */
export const SYSTEM_MENUS = false

export function ContextMenu(props: {
  items: readonly MenuNode[]
  title?: string
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  fit?: 'width' | 'content'
  children: (longPress: (() => void) | undefined) => ReactElement
}) {
  const { items, title } = props
  if (props.disabled || items.length === 0) return props.children(undefined)
  return props.children(() => openMenuSheet(title, items))
}

export function TapMenu(props: {
  items: readonly MenuNode[]
  title?: string
  disabled?: boolean
  children: (open: (() => void) | undefined) => ReactElement
}) {
  const { items, title } = props
  if (props.disabled || items.length === 0) return props.children(undefined)
  return props.children(() => openMenuSheet(title, items))
}

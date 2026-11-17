// Android and the web: no system menu to use, so a control keeps opening our popover with its own
// press. NativeMenu.ios.tsx is the iOS one.

import type { ReactElement } from 'react'
import type { MenuSource } from './Popover'

/** Whether menus are the system's here. */
export const NATIVE_MENUS = false

export function NativeMenu(props: {
  source: MenuSource | null
  children: ReactElement
  disabled?: boolean
}) {
  return props.children
}

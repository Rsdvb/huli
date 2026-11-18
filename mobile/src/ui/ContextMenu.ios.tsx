// The system's own menus on iOS, through SwiftUI: a long press on a view opens a context menu (the
// view lifts, the screen behind it blurs, UIMenu with its icons, submenus and haptics), and a tap
// on a control opens a menu out of it. Built as @expo/ui's community MenuView builds its trigger,
// so a trigger keeps Yoga's size and its own taps. ContextMenu.tsx is Android's sheet instead.

import type { ReactElement } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import {
  Button,
  ContextMenu as SystemContextMenu,
  Host,
  Image,
  Menu,
  RNHostView,
  Section,
  Text,
  Toggle,
} from '@expo/ui/swift-ui'
import { disabled as disabledModifier } from '@expo/ui/swift-ui/modifiers'
import { menuGroups, type MenuItem, type MenuNode } from './menu'

/** Whether long presses open the system's context menu here: always on iOS. */
export const SYSTEM_MENUS = true

const off = (on: boolean | undefined) => (on ? [disabledModifier(true)] : undefined)

function Item(props: { item: MenuItem; depth: number }) {
  const { item } = props
  const mods = off(item.disabled)
  const icon = item.icon ? { systemImage: item.icon } : {}
  if (item.items) {
    if (props.depth > 3) return null
    return (
      <Menu label={item.label} {...icon}>
        <Nodes nodes={item.items} depth={props.depth + 1} />
      </Menu>
    )
  }
  if (item.checked !== undefined && item.subtitle) {
    // Two texts read in a menu as the item's title and its subtitle.
    return (
      <Toggle
        isOn={item.checked}
        {...(mods ? { modifiers: mods } : {})}
        onIsOnChange={() => item.onPress?.()}
      >
        {[
          ...(item.icon ? [<Image key="icon" systemName={item.icon} />] : []),
          <Text key="title">{item.label}</Text>,
          <Text key="subtitle">{item.subtitle}</Text>,
        ]}
      </Toggle>
    )
  }
  if (item.checked !== undefined) {
    return (
      <Toggle
        isOn={item.checked}
        label={item.label}
        {...icon}
        {...(mods ? { modifiers: mods } : {})}
        onIsOnChange={() => item.onPress?.()}
      />
    )
  }
  const role = item.destructive ? { role: 'destructive' as const } : {}
  if (!item.subtitle) {
    return (
      <Button
        label={item.label}
        {...icon}
        {...role}
        {...(mods ? { modifiers: mods } : {})}
        onPress={() => item.onPress?.()}
      />
    )
  }
  // An image and two texts read in a system menu as an icon, a title and a subtitle.
  return (
    <Button {...role} {...(mods ? { modifiers: mods } : {})} onPress={() => item.onPress?.()}>
      {[
        ...(item.icon ? [<Image key="icon" systemName={item.icon} />] : []),
        <Text key="title">{item.label}</Text>,
        <Text key="subtitle">{item.subtitle}</Text>,
      ]}
    </Button>
  )
}

/** The items in their groups; every group a section, so the system draws its rules and titles. */
function Nodes(props: { nodes: readonly MenuNode[]; depth: number; title?: string }) {
  return menuGroups(props.nodes).map((group, index) => {
    const title = group.title ?? (index === 0 ? props.title : undefined)
    return (
      <Section key={group.key} {...(title ? { title } : {})}>
        {group.items.map((item) => (
          <Item key={item.key} item={item} depth={props.depth} />
        ))}
      </Section>
    )
  })
}

/**
 * A view whose long press opens the system's context menu, the view itself lifting as its preview.
 * `children` gets the long press to wire on Android; here it gets none, so the view's own press
 * still works and only the system's long press opens the menu.
 */
export function ContextMenu(props: {
  items: readonly MenuNode[]
  /** The menu's heading, such as the session's title. */
  title?: string
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  /**
   * `width` (the default): the view takes the width it is given, as a list row does, and its own
   * height. `content`: its own width too, as a bubble aligned to one side does.
   */
  fit?: 'width' | 'content'
  children: (longPress: (() => void) | undefined) => ReactElement
}) {
  if (props.disabled || props.items.length === 0) return props.children(undefined)
  return (
    <Host style={props.style} ignoreSafeArea="all">
      <SystemContextMenu>
        <SystemContextMenu.Trigger>
          <RNHostView
            matchContents={props.fit === 'content' ? true : { vertical: true }}
            boundedByHost
          >
            {props.children(undefined)}
          </RNHostView>
        </SystemContextMenu.Trigger>
        <SystemContextMenu.Items>
          <Nodes nodes={props.items} depth={0} {...(props.title ? { title: props.title } : {})} />
        </SystemContextMenu.Items>
      </SystemContextMenu>
    </Host>
  )
}

/**
 * A control whose tap opens the system's menu out of it. The control only draws here: the menu
 * takes the tap. `children` gets the tap to wire on Android.
 */
export function TapMenu(props: {
  items: readonly MenuNode[]
  title?: string
  disabled?: boolean
  children: (open: (() => void) | undefined) => ReactElement
}) {
  if (props.disabled || props.items.length === 0) return props.children(undefined)
  return (
    <Host matchContents>
      <Menu
        label={
          <RNHostView matchContents>
            <View pointerEvents="none">{props.children(undefined)}</View>
          </RNHostView>
        }
      >
        <Nodes nodes={props.items} depth={0} {...(props.title ? { title: props.title } : {})} />
      </Menu>
    </Host>
  )
}

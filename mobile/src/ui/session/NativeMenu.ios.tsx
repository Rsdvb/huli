// A control that opens the system's own menu on iOS: UIMenu through SwiftUI's Menu, with its glass,
// its morph out of the control, its haptics and its submenus. The menu is built from the same
// pages our popover shows (Popover.tsx), so a screen describes a menu once: rows become buttons,
// rows with a check become selectable items, switches toggles, a page a row leads to a submenu,
// and the effort's levels a segmented row. What a menu cannot hold (an agent's mark, a usage
// ring) is left out or said in words. Elsewhere the control keeps opening our popover.

import type { ReactElement, ReactNode } from 'react'
import { View } from 'react-native'
import {
  Button,
  Divider,
  Host,
  Image,
  Menu,
  Picker,
  RNHostView,
  Text,
  Toggle,
} from '@expo/ui/swift-ui'
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { MenuEntry, MenuPage, MenuRow, MenuSource } from './Popover'

/** Whether menus are the system's here: always on iOS. */
export const NATIVE_MENUS = true

const off = (on: boolean | undefined) => (on ? [disabled(true)] : undefined)

function Row(props: { row: MenuRow; source: MenuSource; depth: number }) {
  const { row, source } = props
  const mods = off(row.disabled)
  const sf = row.icon?.sf
  if (row.page) {
    if (source.popover?.pages.includes(row.page)) {
      const page = row.page
      return (
        <Button
          label={row.label}
          {...(sf ? { systemImage: sf } : {})}
          {...(mods ? { modifiers: mods } : {})}
          onPress={() => source.popover!.open(page)}
        />
      )
    }
    const page = source.pages(row.page)
    // Deep pages that lead back to each other would recurse without end.
    if (!page || props.depth > 3) return null
    return (
      <Menu label={row.label} {...(sf ? { systemImage: sf } : {})}>
        <Entries page={page} source={source} depth={props.depth + 1} />
      </Menu>
    )
  }
  if (row.toggle !== undefined || row.checked !== undefined) {
    const on = row.toggle ?? row.checked ?? false
    return (
      <Toggle
        isOn={on}
        label={row.label}
        {...(sf ? { systemImage: sf } : {})}
        {...(mods ? { modifiers: mods } : {})}
        onIsOnChange={() => row.onPress?.()}
      />
    )
  }
  const subtitle = [row.subtitle, row.detail].filter(Boolean).join(' · ')
  const role = row.destructive ? ('destructive' as const) : undefined
  if (!subtitle) {
    return (
      <Button
        label={row.label}
        {...(sf ? { systemImage: sf } : {})}
        {...(role ? { role } : {})}
        {...(mods ? { modifiers: mods } : {})}
        onPress={() => row.onPress?.()}
      />
    )
  }
  // A label of an image and two texts reads in a menu as an icon, a title and a subtitle.
  return (
    <Button
      {...(role ? { role } : {})}
      {...(mods ? { modifiers: mods } : {})}
      onPress={() => row.onPress?.()}
    >
      {[
        ...(sf ? [<Image key="icon" systemName={sf} />] : []),
        <Text key="title">{row.label}</Text>,
        <Text key="subtitle">{subtitle}</Text>,
      ]}
    </Button>
  )
}

function Entry(props: { entry: MenuEntry; source: MenuSource; depth: number }) {
  const { entry } = props
  if (entry.kind === 'divider') return <Divider />
  if (entry.kind === 'custom') {
    const picker = entry.picker
    if (!picker) return null
    return (
      <Picker
        label={picker.label}
        selection={picker.value}
        onSelectionChange={(value: string) => picker.onChange(value)}
        modifiers={[pickerStyle('palette'), ...(off(picker.disabled) ?? [])]}
      >
        {picker.options.map((option) => (
          <Text key={option.key} modifiers={[tag(option.key)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    )
  }
  return <Row row={entry} source={props.source} depth={props.depth} />
}

function Entries(props: { page: MenuPage; source: MenuSource; depth: number }) {
  const { page } = props
  if (page.loading && page.entries.length === 0) return <Text>正在加载…</Text>
  if (page.error && page.entries.length === 0) {
    const retry = page.onRetry
    return (
      <>
        <Text>{page.error}</Text>
        {retry ? <Button label="重试" systemImage="arrow.clockwise" onPress={retry} /> : null}
      </>
    )
  }
  const body: ReactNode[] = page.entries.map((entry) => (
    <Entry key={entry.key} entry={entry} source={props.source} depth={props.depth} />
  ))
  return (
    <>
      {page.entries.length === 0 && page.empty ? <Text>{page.empty}</Text> : null}
      {body}
      {page.footer ? (
        <>
          <Divider />
          <Text>{page.footer}</Text>
        </>
      ) : null}
    </>
  )
}

/**
 * Wraps a control so a tap opens its menu: the system's on iOS, where the control only draws the
 * label; on Android the control is left as it is, and its own press opens our popover.
 */
export function NativeMenu(props: {
  source: MenuSource | null
  children: ReactElement
  disabled?: boolean
}) {
  const page = props.source?.pages(props.source.root)
  if (!props.source || !page || props.disabled) return props.children
  return (
    <Host matchContents>
      <Menu
        label={
          <RNHostView matchContents>
            <View pointerEvents="none">{props.children}</View>
          </RNHostView>
        }
      >
        <Entries page={page} source={props.source} depth={0} />
      </Menu>
    </Host>
  )
}

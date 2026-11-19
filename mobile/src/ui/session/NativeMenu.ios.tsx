// A control that opens the system's own menu on iOS: UIMenu through SwiftUI's Menu, with its glass,
// its morph out of the control, its haptics and its submenus. The menu is built from the same
// pages our popover shows (Popover.tsx), so a screen describes a menu once: rows become buttons,
// rows with a check buttons with a checkmark, switches toggles, a page a row leads to a submenu,
// and the effort's levels a segmented row. What a menu cannot hold (an agent's mark, a usage
// ring) is left out or said in words. Elsewhere the control keeps opening our popover.

import { Fragment, type ReactElement, type ReactNode } from 'react'
import { View } from 'react-native'
import {
  Button,
  Divider,
  Host,
  Image,
  Menu,
  Picker,
  RNHostView,
  Section,
  Text,
  Toggle,
} from '@expo/ui/swift-ui'
import { disabled, menuOrder, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
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
  const subtitle = [row.subtitle, row.detail].filter(Boolean).join(' · ')
  // A switch only: a SwiftUI Toggle flips itself on a tap, so a choice drawn as one showed the
  // tapped row as chosen even when the choice did not change or failed to. A choice is a button
  // with a check, which shows what the screen says is chosen and nothing else.
  if (row.checked !== undefined && row.toggle === undefined) {
    const mark = row.checked ? 'checkmark' : sf
    if (subtitle) {
      return (
        <Button {...(mods ? { modifiers: mods } : {})} onPress={() => row.onPress?.()}>
          {[
            ...(mark ? [<Image key="icon" systemName={mark} />] : []),
            <Text key="title">{row.label}</Text>,
            <Text key="subtitle">{subtitle}</Text>,
          ]}
        </Button>
      )
    }
    return (
      <Button
        label={row.label}
        {...(mark ? { systemImage: mark } : {})}
        {...(mods ? { modifiers: mods } : {})}
        onPress={() => row.onPress?.()}
      />
    )
  }
  if (row.toggle !== undefined) {
    const on = row.toggle
    if (subtitle) {
      // Two texts read in a menu as the item's title and its subtitle.
      return (
        <Toggle
          isOn={on}
          {...(mods ? { modifiers: mods } : {})}
          onIsOnChange={() => row.onPress?.()}
        >
          {[
            ...(sf ? [<Image key="icon" systemName={sf} />] : []),
            <Text key="title">{row.label}</Text>,
            <Text key="subtitle">{subtitle}</Text>,
          ]}
        </Toggle>
      )
    }
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
    const control = (
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
    // A palette picker is a section of its own, headed by its label; a hint after it would land
    // above it, so the menu leaves the hint to the control's accessibility hint.
    return control
  }
  return <Row row={entry} source={props.source} depth={props.depth} />
}

/** The entries in groups: a divider starts one, and a divider with a title a titled section. */
function groupsOf(entries: MenuEntry[]): { key: string; title?: string; entries: MenuEntry[] }[] {
  const groups: { key: string; title?: string; entries: MenuEntry[] }[] = [
    { key: 'start', entries: [] },
  ]
  for (const entry of entries) {
    if (entry.kind === 'divider') {
      // A picker heads its own section with its label, so a title saying the same goes.
      const next = entries[entries.indexOf(entry) + 1]
      const named = next?.kind === 'custom' && next.picker?.label === entry.title
      groups.push({
        key: entry.key,
        ...(entry.title && !named ? { title: entry.title } : {}),
        entries: [],
      })
    } else {
      groups[groups.length - 1]!.entries.push(entry)
    }
  }
  return groups.filter((group) => group.entries.length > 0)
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
  const body: ReactNode[] = groupsOf(page.entries).map((group, index) => {
    const rows = group.entries.map((entry) => (
      <Entry key={entry.key} entry={entry} source={props.source} depth={props.depth} />
    ))
    if (group.title) {
      return (
        <Section key={group.key} title={group.title}>
          {rows}
        </Section>
      )
    }
    return (
      <Fragment key={group.key}>
        {index > 0 ? <Divider /> : null}
        {rows}
      </Fragment>
    )
  })
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
  /** The edge the control keeps still while its label changes width: its end in a row's end. */
  align?: 'leading' | 'trailing'
}) {
  const page = props.source?.pages(props.source.root)
  if (!props.source || !page || props.disabled) return props.children
  return (
    // React Native lays the control out and moves it with the keyboard; a hosting controller that
    // kept the safe area would also lift its content out of the keyboard's way, on SwiftUI's own
    // animation, so the label drifted off its row and the menu morphed out of the wrong place.
    <Host matchContents ignoreSafeArea="all" {...(props.align ? { alignment: props.align } : {})}>
      {/* In the order given, opening up or down: the system's default turns a menu that opens
          upward around, which pushed the model menu's models to its far end. */}
      <Menu
        modifiers={[menuOrder('fixed')]}
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

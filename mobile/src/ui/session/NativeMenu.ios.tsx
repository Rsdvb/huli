// A control that opens the system's own menu on iOS: UIMenu through SwiftUI's Menu, with its glass,
// its morph out of the control, its haptics and its submenus. The menu is built from the same
// pages our popover shows (Popover.tsx), so a screen describes a menu once: rows become buttons,
// rows with a check buttons with a checkmark, switches toggles, a page a row leads to a submenu,
// and the effort's levels a segmented row. What a menu cannot hold (an agent's mark, a usage
// ring) is said in words. Elsewhere the control keeps opening our popover.
//
// SwiftUI draws an open menu again whenever its content's props change, which a screen that
// redraws while a turn streams did many times a second, and a line whose words change (a limit's
// share, when it comes back) redrew it under the finger. So the content is built anew only when
// what it shows changes, its rows reach the screen's latest actions through a ref, and while the
// menu is open it stays as it opened.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { View } from 'react-native'
import {
  Button,
  Divider,
  Group,
  Host,
  Image,
  Menu,
  Picker,
  RNHostView,
  Section,
  Text,
  Toggle,
} from '@expo/ui/swift-ui'
import {
  disabled,
  menuOrder,
  onAppear,
  onDisappear,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers'
import type { MenuEntry, MenuPage, MenuRow, MenuSource } from './Popover'

/** Whether menus are the system's here: always on iOS. */
export const NATIVE_MENUS = true

const OFF = [disabled(true)]
const off = (on: boolean | undefined) => (on ? OFF : undefined)
const FIXED_ORDER = [menuOrder('fixed')]
const DISABLED_MENU = [menuOrder('fixed'), disabled(true)]
const PALETTE = pickerStyle('palette')

// An open menu that never said it closed is let go after this long, so it cannot stay stale.
const OPEN_AT_MOST = 30_000

/** The screen's latest actions, by the path of the row in the menu. */
type Actions = Map<string, (value?: string) => void>

interface Built {
  source: MenuSource
  actions: { current: Actions }
  /** The menu closes on a choice: it is held no longer. */
  release(): void
}

/** Runs the row's latest action; a menu closes on a choice, so it is no longer held. */
function act(built: Built, path: string, value?: string): void {
  built.release()
  built.actions.current.get(path)?.(value)
}

/** A row's lines: its subtitle, the words of what it draws under it, and its detail. */
function subtitleOf(row: MenuRow): string {
  return [row.subtitle, row.belowText, row.detail].filter(Boolean).join(' · ')
}

function Row(props: { row: MenuRow; built: Built; depth: number; path: string }) {
  const { row, built, path } = props
  const press = () => act(built, path)
  const mods = off(row.disabled)
  const sf = row.icon?.sf
  const subtitle = subtitleOf(row)
  if (row.page && !row.disabled) {
    if (built.source.popover?.pages.includes(row.page)) {
      return <Button label={row.label} {...(sf ? { systemImage: sf } : {})} onPress={press} />
    }
    const page = built.source.pages(row.page)
    // Deep pages that lead back to each other would recurse without end.
    if (!page || props.depth > 3) return null
    return (
      <Menu label={row.label} {...(sf ? { systemImage: sf } : {})}>
        <Entries page={page} built={built} depth={props.depth + 1} path={`${path}>`} />
      </Menu>
    )
  }
  // A row that leads to a page while it cannot is a disabled button: a submenu opens whatever
  // its disabled modifier says, so 换 Agent opened mid-turn.
  if (row.page) {
    return subtitle ? (
      <Button modifiers={OFF}>
        {[
          ...(sf ? [<Image key="icon" systemName={sf} />] : []),
          <Text key="title">{row.label}</Text>,
          <Text key="subtitle">{subtitle}</Text>,
        ]}
      </Button>
    ) : (
      <Button label={row.label} {...(sf ? { systemImage: sf } : {})} modifiers={OFF} />
    )
  }
  // A switch only: a SwiftUI Toggle flips itself on a tap, so a choice drawn as one showed the
  // tapped row as chosen even when the choice did not change or failed to. A choice is a button
  // with a check, which shows what the screen says is chosen and nothing else.
  const role = row.destructive ? ('destructive' as const) : undefined
  if (row.checked !== undefined && row.toggle === undefined) {
    const mark = row.checked ? 'checkmark' : sf
    if (subtitle) {
      return (
        <Button {...(role ? { role } : {})} {...(mods ? { modifiers: mods } : {})} onPress={press}>
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
        {...(role ? { role } : {})}
        {...(mods ? { modifiers: mods } : {})}
        onPress={press}
      />
    )
  }
  if (row.toggle !== undefined) {
    const on = row.toggle
    if (subtitle) {
      // Two texts read in a menu as the item's title and its subtitle.
      return (
        <Toggle isOn={on} {...(mods ? { modifiers: mods } : {})} onIsOnChange={press}>
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
        onIsOnChange={press}
      />
    )
  }
  if (!subtitle) {
    return (
      <Button
        label={row.label}
        {...(sf ? { systemImage: sf } : {})}
        {...(role ? { role } : {})}
        {...(mods ? { modifiers: mods } : {})}
        onPress={press}
      />
    )
  }
  // A label of an image and two texts reads in a menu as an icon, a title and a subtitle.
  return (
    <Button {...(role ? { role } : {})} {...(mods ? { modifiers: mods } : {})} onPress={press}>
      {[
        ...(sf ? [<Image key="icon" systemName={sf} />] : []),
        <Text key="title">{row.label}</Text>,
        <Text key="subtitle">{subtitle}</Text>,
      ]}
    </Button>
  )
}

function Entry(props: { entry: MenuEntry; built: Built; depth: number; path: string }) {
  const { entry, built, path } = props
  if (entry.kind === 'divider') return <Divider />
  if (entry.kind === 'custom') {
    if (entry.row) return <Row row={entry.row} built={built} depth={props.depth} path={path} />
    const picker = entry.picker
    if (!picker) return null
    // A palette picker is a section of its own, headed by its label; a hint after it would land
    // above it, so the menu leaves the hint to the control's accessibility hint.
    return (
      <Picker
        label={picker.label}
        selection={picker.value}
        onSelectionChange={(value: string) => act(built, path, value)}
        modifiers={picker.disabled ? [PALETTE, ...OFF] : [PALETTE]}
      >
        {picker.options.map((option) => (
          <Text key={option.key} modifiers={[tag(option.key)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    )
  }
  return <Row row={entry} built={built} depth={props.depth} path={path} />
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

function Entries(props: { page: MenuPage; built: Built; depth: number; path: string }) {
  const { page, built, path } = props
  if (page.loading && page.entries.length === 0) return <Text>正在加载…</Text>
  if (page.error && page.entries.length === 0) {
    return (
      <>
        <Text>{page.error}</Text>
        {page.onRetry ? (
          <Button
            label="重试"
            systemImage="arrow.clockwise"
            onPress={() => act(built, `${path}retry`)}
          />
        ) : null}
      </>
    )
  }
  const body: ReactNode[] = groupsOf(page.entries).map((group, index) => {
    const rows = group.entries.map((entry) => (
      <Entry
        key={entry.key}
        entry={entry}
        built={built}
        depth={props.depth}
        path={`${path}${entry.key}`}
      />
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
 * What a menu shows, as words, and its actions by path: two pages that read alike draw alike,
 * so the menu is built again only when this changes.
 */
function readMenu(
  source: MenuSource,
  page: MenuPage,
  depth: number,
  path: string,
  out: string[],
  actions: Actions,
): void {
  out.push(
    `[${page.title ?? ''}|${page.footer ?? ''}|${page.loading ? 1 : 0}|${page.error ?? ''}|${page.empty ?? ''}`,
  )
  if (page.onRetry) actions.set(`${path}retry`, page.onRetry)
  for (const entry of page.entries) {
    const at = `${path}${entry.key}`
    if (entry.kind === 'divider') {
      out.push(`-${entry.key}|${entry.title ?? ''}`)
      continue
    }
    const row = entry.kind === 'custom' ? entry.row : entry
    if (entry.kind === 'custom' && !row) {
      const picker = entry.picker
      if (!picker) continue
      out.push(
        `~${entry.key}|${picker.label}|${picker.value}|${picker.disabled ? 1 : 0}|${picker.options.map((o) => `${o.key}=${o.label}`).join(',')}`,
      )
      actions.set(at, (value) => value !== undefined && picker.onChange(value))
      continue
    }
    if (!row) continue
    out.push(
      `${entry.key}|${row.label}|${row.icon?.sf ?? ''}|${subtitleOf(row)}|${String(row.checked)}|${String(row.toggle)}|${row.disabled ? 1 : 0}|${row.destructive ? 1 : 0}|${row.page ?? ''}`,
    )
    if (row.page && !row.disabled) {
      const popover = source.popover
      if (popover?.pages.includes(row.page)) {
        const page = row.page
        actions.set(at, () => popover.open(page))
      } else if (depth <= 3) {
        const inner = source.pages(row.page)
        if (inner) readMenu(source, inner, depth + 1, `${at}>`, out, actions)
      }
    } else if (row.onPress) {
      actions.set(at, row.onPress)
    }
  }
  out.push(']')
}

/**
 * Wraps a control so a tap opens its menu: the system's on iOS, where the control only draws the
 * label; on Android the control is left as it is, and its own press opens our popover. Disabled,
 * the control stays where it was in the same views, so it is not mounted again when that changes.
 */
export function NativeMenu(props: {
  source: MenuSource | null
  children: ReactElement
  disabled?: boolean
  /** The edge the control keeps still while its label changes width: its end in a row's end. */
  align?: 'leading' | 'trailing'
}) {
  const { source } = props
  const page = source?.pages(source.root) ?? null
  const actions = useRef<Actions>(new Map())
  const latest = useRef<MenuSource | null>(source)
  latest.current = source
  const words: string[] = []
  const next: Actions = new Map()
  if (source && page) readMenu(source, page, 0, '', words, next)
  actions.current = next
  const signature = words.join('\n')

  // Held as it opened while it is open, which its content's appearing and going say.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setOpen(false), OPEN_AT_MOST)
    return () => clearTimeout(timer)
  }, [open])
  const seen = useMemo(() => [onAppear(() => setOpen(true)), onDisappear(() => setOpen(false))], [])
  const content = useMemo(() => {
    const current = latest.current
    if (!current) return null
    const root = current.pages(current.root)
    if (!root) return null
    // The pages are read through the latest source, so a submenu's own pages stay current too.
    const built: Built = {
      source: { ...current, pages: (id) => latest.current?.pages(id) ?? null },
      actions,
      release: () => setOpen(false),
    }
    return (
      <Group modifiers={seen}>
        <Entries page={root} built={built} depth={0} path="" />
      </Group>
    )
    // Built again only when what it shows changes; its actions go through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, seen])
  const held = useRef(content)
  if (!open || held.current === null) held.current = content

  if (!source || !page) return props.children
  return (
    // React Native lays the control out and moves it with the keyboard; a hosting controller that
    // kept the safe area would also lift its content out of the keyboard's way, on SwiftUI's own
    // animation, so the label drifted off its row and the menu morphed out of the wrong place.
    <Host matchContents ignoreSafeArea="all" {...(props.align ? { alignment: props.align } : {})}>
      {/* In the order given, opening up or down: the system's default turns a menu that opens
          upward around, which pushed the model menu's models to its far end. */}
      <Menu
        modifiers={props.disabled ? DISABLED_MENU : FIXED_ORDER}
        label={
          <RNHostView matchContents>
            <View pointerEvents="none">{props.children}</View>
          </RNHostView>
        }
      >
        {props.disabled ? null : held.current}
      </Menu>
    </Host>
  )
}

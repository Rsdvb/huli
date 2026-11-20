// What a menu holds, the same for the system's context menus and tap menus on iOS (ContextMenu.ios)
// and the sheet that stands in for them on Android (MenuSheet): items, each with an SF Symbol, a
// check or a submenu, in groups a divider starts.

import type { SFSymbol } from 'expo-symbols'

export interface MenuItem {
  kind?: 'item'
  key: string
  label: string
  /** An SF Symbol; Android's sheet shows no icons. */
  icon?: SFSymbol
  /** A second line under the label. */
  subtitle?: string
  destructive?: boolean
  disabled?: boolean
  /** A choice: shown with a check when true. */
  checked?: boolean
  onPress?: () => void
  /** A submenu, which the item opens instead of acting. */
  items?: MenuNode[]
}

/** A rule between groups; with a title, the group after it is a titled section. */
export interface MenuDivider {
  kind: 'divider'
  key: string
  title?: string
}

export type MenuNode = MenuItem | MenuDivider

export interface MenuGroup {
  key: string
  title?: string
  items: MenuItem[]
}

/** The nodes as groups: a divider starts one, empty groups are left out. */
export function menuGroups(nodes: readonly MenuNode[]): MenuGroup[] {
  const groups: MenuGroup[] = [{ key: 'start', items: [] }]
  for (const node of nodes) {
    if (node.kind === 'divider') {
      groups.push({ key: node.key, ...(node.title ? { title: node.title } : {}), items: [] })
    } else {
      groups[groups.length - 1]!.items.push(node)
    }
  }
  return groups.filter((group) => group.items.length > 0)
}

/**
 * The menu of a session while its computer is not connected: why nothing can be done to it now,
 * greyed, so a long press says so rather than doing nothing.
 */
export function offlineMenu(): MenuNode[] {
  return [
    {
      key: 'offline',
      label: '电脑没有连上',
      subtitle: '连上后才能整理这个会话',
      icon: 'wifi.slash',
      disabled: true,
    },
  ]
}

/** Groups of items as one list of nodes, a divider between each two. */
export function joinGroups(groups: readonly (readonly MenuNode[])[]): MenuNode[] {
  const out: MenuNode[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (out.length > 0) out.push({ kind: 'divider', key: `rule-${out.length}` })
    out.push(...group)
  }
  return out
}

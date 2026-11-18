// Where the system has no context menu to give (Android), a menu opens as a sheet from the bottom:
// its items in their groups, a submenu as the sheet's next page. One host, mounted at the root,
// shows whichever menu was opened last.

import { useSyncExternalStore } from 'react'
import { Sheet, type SheetItem } from '../components/Sheet'
import { haptic } from './haptics'
import { menuGroups, type MenuNode } from './menu'

interface Open {
  title?: string
  nodes: readonly MenuNode[]
}

let open: Open | null = null
const listeners = new Set<() => void>()

function publish(next: Open | null): void {
  open = next
  for (const listener of listeners) listener()
}

/** Opens a menu as the bottom sheet. */
export function openMenuSheet(title: string | undefined, nodes: readonly MenuNode[]): void {
  if (nodes.length === 0) return
  haptic.select()
  publish({ ...(title ? { title } : {}), nodes })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function itemsOf(nodes: readonly MenuNode[]): SheetItem[] {
  return menuGroups(nodes).flatMap((group, index) =>
    group.items.map((item, i) => ({
      key: item.key,
      label: item.items ? `${item.label}…` : item.label,
      ...(item.subtitle ? { detail: item.subtitle } : {}),
      ...(item.destructive ? { destructive: true } : {}),
      ...(item.disabled ? { disabled: true } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      // A group after the first starts a new rounded group, under its title if it has one.
      ...(i === 0 && index > 0 ? { section: group.title ?? ' ' } : {}),
      onPress: () => {
        const sub = item.items
        if (sub) {
          setTimeout(() => publish({ title: item.label, nodes: sub }), 300)
          return
        }
        item.onPress?.()
      },
    })),
  )
}

export function MenuSheetHost() {
  const current = useSyncExternalStore(subscribe, () => open)
  return (
    <Sheet
      visible={current !== null}
      {...(current?.title ? { title: current.title } : {})}
      items={current ? itemsOf(current.nodes) : []}
      onClose={() => publish(null)}
    />
  )
}

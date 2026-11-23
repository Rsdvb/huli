// Huli: the keys of Kite's shortcuts as the user bound them in Settings › Keyboard shortcuts, for the
// handlers that run them and the menus, tooltips and hints that show them.

import {
  DEFAULT_SHORTCUTS,
  matchesKeys,
  SHORTCUT_IDS,
  shortcutBindings,
  type ShortcutId,
} from '@shared/shortcuts'
import { useSettingsStore } from '@renderer/stores/settings'
import { formatShortcut, isMac } from './platform'

/** The shortcut's keys now, outside React. */
export function shortcutKeysOf(id: ShortcutId): string {
  return useSettingsStore.getState().settings.keyboard?.shortcuts[id] ?? DEFAULT_SHORTCUTS[id]
}

/** The shortcut's keys, following a change in Settings. */
export function useShortcutKeys(id: ShortcutId): string {
  return useSettingsStore((s) => s.settings.keyboard?.shortcuts[id] ?? DEFAULT_SHORTCUTS[id])
}

/** The shortcut's keys as the platform writes them, following a change in Settings. */
export function useShortcutLabel(id: ShortcutId): string {
  return formatShortcut(useShortcutKeys(id))
}

/** The shortcut the event pressed, by the user's bindings; null for none. */
export function pressedShortcut(event: KeyboardEvent): ShortcutId | null {
  const bindings = shortcutBindings(useSettingsStore.getState().settings.keyboard?.shortcuts)
  return SHORTCUT_IDS.find((id) => matchesKeys(event, bindings[id], isMac)) ?? null
}

/** Whether the event pressed the shortcut's keys. */
export function pressesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  return matchesKeys(event, shortcutKeysOf(id), isMac)
}

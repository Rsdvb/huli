// Huli: Kite's keyboard shortcuts that the user may rebind in Settings › Keyboard shortcuts, their
// default keys, and the rules a binding keeps: a modifier (or a function key), no key the app or
// the system keeps for itself, and no key another shortcut has. Keys are written as the app's
// menus and tooltips take them: `Mod+Shift+K`, where Mod is Command on macOS and Control
// elsewhere, and Ctrl is Control on macOS too. The key is the physical one, as `event.code` names
// it, so a binding means the same keys in every keyboard layout and input method.

export const SHORTCUT_IDS = [
  'newSession',
  'searchSessions',
  'openProject',
  'settings',
  'toggleSidebar',
  'showShortcuts',
  'previousSession',
  'nextSession',
  'findInSession',
  'focusComposer',
  'sideChat',
  'addFiles',
  'addMenu',
  'toggleTerminal',
  'newTerminal',
] as const

export type ShortcutId = (typeof SHORTCUT_IDS)[number]

/** The user's bindings, by shortcut; one left out has its default. */
export type ShortcutBindings = Partial<Record<ShortcutId, string>>

export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutId, string>> = {
  newSession: 'Mod+N',
  searchSessions: 'Mod+K',
  openProject: 'Mod+O',
  settings: 'Mod+,',
  toggleSidebar: 'Mod+B',
  showShortcuts: 'Mod+/',
  previousSession: 'Mod+Shift+[',
  nextSession: 'Mod+Shift+]',
  findInSession: 'Mod+F',
  focusComposer: 'Mod+L',
  sideChat: 'Mod+J',
  addFiles: 'Mod+U',
  addMenu: 'Mod+Shift+A',
  toggleTerminal: 'Ctrl+`',
  newTerminal: 'Ctrl+Shift+`',
}

/** Where Settings and the shortcuts list show each one. */
export const SHORTCUT_GROUPS: Readonly<
  Record<ShortcutId, 'general' | 'sessions' | 'composer' | 'terminal'>
> = {
  newSession: 'general',
  searchSessions: 'general',
  openProject: 'general',
  settings: 'general',
  toggleSidebar: 'general',
  showShortcuts: 'general',
  previousSession: 'sessions',
  nextSession: 'sessions',
  findInSession: 'sessions',
  focusComposer: 'composer',
  sideChat: 'composer',
  addFiles: 'composer',
  addMenu: 'composer',
  toggleTerminal: 'terminal',
  newTerminal: 'terminal',
}

/** The shortcuts the macOS menu bar carries, which the page then leaves to it. */
export const MENU_SHORTCUTS: readonly ShortcutId[] = [
  'newSession',
  'openProject',
  'settings',
  'toggleSidebar',
]

export function isShortcutId(value: unknown): value is ShortcutId {
  return typeof value === 'string' && (SHORTCUT_IDS as readonly string[]).includes(value)
}

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIERS)[number]

/** Each physical key a binding may name, by `event.code`. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => [`Key${letter}`, letter]),
  ),
  ...Object.fromEntries('0123456789'.split('').map((digit) => [`Digit${digit}`, digit])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}
const KEYS: ReadonlySet<string> = new Set(Object.values(CODE_KEYS))
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/

/** A binding's parts: its modifiers, in the order they are written, and its key. */
interface Parts {
  modifiers: Modifier[]
  key: string
}

function parts(keys: string): Parts | null {
  if (typeof keys !== 'string' || keys.length === 0 || keys.length > 40) return null
  // A trailing `+` is the plus key, which no binding names; `=` stands for it.
  const split = keys.split('+')
  const key = split.pop()!
  const modifiers: Modifier[] = []
  for (const part of split) {
    if (!(MODIFIERS as readonly string[]).includes(part)) return null
    if (modifiers.includes(part as Modifier)) return null
    modifiers.push(part as Modifier)
  }
  if (!KEYS.has(key)) return null
  return { modifiers, key }
}

/**
 * The binding as it reads on the platform, so two that mean the same keys compare equal: its
 * modifiers in one order, and Ctrl as Mod outside macOS, where both are Control.
 */
export function canonicalKeys(keys: string, mac: boolean): string | null {
  const read = parts(keys)
  if (!read) return null
  const held = new Set(
    read.modifiers.map((modifier) => (!mac && modifier === 'Ctrl' ? 'Mod' : modifier)),
  )
  return [...MODIFIERS.filter((modifier) => held.has(modifier)), read.key].join('+')
}

/** Why the keys cannot be a binding; null when they can. */
export type KeysProblem = 'invalid' | 'modifier' | 'reserved'

/** Keys the app or the system keeps, which no binding may take. */
function reserved(mac: boolean): ReadonlySet<string> {
  const keys = [
    ...'123456789'.split('').map((digit) => `Mod+${digit}`),
    'Mod+Z',
    'Mod+Shift+Z',
    'Mod+X',
    'Mod+C',
    'Mod+V',
    'Mod+A',
    'Mod+=',
    'Mod+Shift+=',
    'Mod+-',
    'Mod+Shift+-',
    'Mod+0',
    'Mod+W',
    'Mod+T',
    'Mod+Q',
    'Mod+R',
    ...(mac
      ? ['Mod+[', 'Mod+]', 'Mod+Y', 'Mod+H', 'Mod+Alt+H', 'Mod+M', 'Mod+Space']
      : ['Alt+Left', 'Alt+Right', 'Mod+H', 'Mod+Y', 'Alt+F4']),
  ]
  return new Set(keys.map((each) => canonicalKeys(each, mac)!))
}

export function keysProblem(keys: string, mac: boolean): KeysProblem | null {
  const canonical = canonicalKeys(keys, mac)
  if (!canonical) return 'invalid'
  const read = parts(canonical)!
  const held = read.modifiers.filter((modifier) => modifier !== 'Shift')
  if (held.length === 0 && !FUNCTION_KEY.test(read.key)) return 'modifier'
  if (reserved(mac).has(canonical)) return 'reserved'
  return null
}

/** Every shortcut's keys: the user's binding where one is set, else the default. */
export function shortcutBindings(custom: ShortcutBindings | undefined): Record<ShortcutId, string> {
  const out = { ...DEFAULT_SHORTCUTS }
  for (const id of SHORTCUT_IDS) {
    const keys = custom?.[id]
    if (typeof keys === 'string') out[id] = keys
  }
  return out
}

/** The shortcut that already has these keys, other than `id` when one is given; null for none. */
export function shortcutConflict(
  bindings: Readonly<Record<ShortcutId, string>>,
  id: ShortcutId | null,
  keys: string,
  mac: boolean,
): ShortcutId | null {
  const wanted = canonicalKeys(keys, mac)
  if (!wanted) return null
  for (const other of SHORTCUT_IDS) {
    if (other !== id && canonicalKeys(bindings[other], mac) === wanted) return other
  }
  return null
}

/** Whether two bindings press the same keys. */
export function sameKeys(a: string, b: string, mac: boolean): boolean {
  const left = canonicalKeys(a, mac)
  return left !== null && left === canonicalKeys(b, mac)
}

/**
 * Why a set of bindings, as the settings keep them, cannot be kept; null when every one is valid
 * and no two share their keys.
 */
export function bindingsProblem(value: unknown, mac: boolean): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object'
  }
  for (const [id, keys] of Object.entries(value)) {
    if (!isShortcutId(id)) return `has no shortcut "${id.slice(0, 40)}"`
    if (typeof keys !== 'string' || keysProblem(keys, mac) !== null) {
      return `.${id} is not keys a shortcut may have`
    }
  }
  const all = shortcutBindings(value as ShortcutBindings)
  const seen = new Map<string, ShortcutId>()
  for (const id of SHORTCUT_IDS) {
    const canonical = canonicalKeys(all[id], mac)
    if (canonical === null) continue
    const taken = seen.get(canonical)
    if (taken) return `gives ${id} the keys of ${taken}`
    seen.set(canonical, id)
  }
  return null
}

/** What a key event says of its keys, as the DOM's and Electron's input events both give it. */
export interface KeyEventLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

/** The keys an event pressed, as a binding writes them; null for a modifier alone or a composition. */
export function keysOfEvent(event: KeyEventLike, mac: boolean): string | null {
  if (event.isComposing || event.keyCode === 229) return null
  const key = CODE_KEYS[event.code]
  if (!key) return null
  // The Windows key is the system's outside macOS.
  if (!mac && event.metaKey) return null
  const modifiers: Modifier[] = []
  if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod')
  if (mac && event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return [...modifiers, key].join('+')
}

/** Whether the event pressed exactly these keys. */
export function matchesKeys(event: KeyEventLike, keys: string, mac: boolean): boolean {
  const pressed = keysOfEvent(event, mac)
  return pressed !== null && pressed === canonicalKeys(keys, mac)
}

/** The keys as an Electron accelerator, for the macOS menu bar; null for keys it cannot take. */
export function acceleratorOf(keys: string, mac: boolean): string | null {
  const canonical = canonicalKeys(keys, mac)
  if (!canonical) return null
  const NAMES: Record<string, string> = {
    Mod: mac ? 'Cmd' : 'Ctrl',
    Ctrl: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
  }
  return canonical
    .split('+')
    .map((part) => NAMES[part] ?? part)
    .join('+')
}

/** Huli: the global screenshot hotkey, which works with Kite in the background: two modifiers. */
export function screenshotKeysProblem(keys: string, mac: boolean): KeysProblem | null {
  const problem = keysProblem(keys, mac)
  if (problem) return problem
  const read = parts(canonicalKeys(keys, mac)!)!
  return read.modifiers.length >= 2 || FUNCTION_KEY.test(read.key) ? null : 'modifier'
}

// What computer use never touches: Kettu itself, password managers, system settings, terminals
// and browsers, and the shortcuts and menu items that quit apps, log out, lock or empty the trash.
// Apps are matched by the identity and name the driver reports for a process, never by the agent's.

import type { ComputerApp } from '@shared/computer-use'
import type { Platform } from '@shared/platform'

/** An app as the driver's `list_apps` reports it. */
export interface DriverApp {
  pid: number
  name: string
  bundleId: string | null
  /** The app bundle on macOS; the executable elsewhere. */
  launchPath: string | null
}

export type BlockReason = 'kettu' | 'password_manager' | 'system' | 'terminal' | 'browser'

/** The last segment of a path in either separator style. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * The identity approvals are kept under: the bundle id on macOS, the executable's file name
 * elsewhere, lowercased; the name when the driver reports neither. Null without either.
 */
export function appIdentity(app: DriverApp, platform: Platform): ComputerApp | null {
  const name = app.name.trim()
  const bundle = app.bundleId?.trim().toLowerCase()
  const file = app.launchPath ? baseName(app.launchPath).toLowerCase() : ''
  const id = platform === 'darwin' ? bundle || file : file || bundle
  const identity = id || name.toLowerCase()
  if (!identity) return null
  return { id: identity, name: name || identity }
}

/** macOS bundle ids and Windows and Linux executables of each kind, lowercased. */
const IDS: Record<Exclude<BlockReason, 'kettu'>, readonly string[]> = {
  password_manager: [
    'com.1password.1password',
    'com.agilebits.onepassword7',
    'com.agilebits.onepassword-osx',
    'com.bitwarden.desktop',
    'com.lastpass.lastpassmacdesktop',
    'com.nordpass.macos.nordpass',
    'me.proton.pass.electron',
    'org.keepassxc.keepassxc',
    'com.apple.keychainaccess',
    'com.apple.passwords',
    '1password.exe',
    'bitwarden.exe',
    'keepassxc.exe',
    'keepass.exe',
    'nordpass.exe',
    'proton pass.exe',
    '1password',
    'bitwarden',
    'keepassxc',
    'seahorse',
  ],
  system: [
    'com.apple.systempreferences',
    'com.apple.securityagent',
    'com.apple.loginwindow',
    'com.apple.coreservices.uiagent',
    'systemsettings.exe',
    'control.exe',
    'consent.exe',
    'mmc.exe',
    'regedit.exe',
    'taskmgr.exe',
    'gnome-control-center',
    'systemsettings',
    'polkit-gnome-authentication-agent-1',
    'polkit-kde-authentication-agent-1',
  ],
  terminal: [
    'com.apple.terminal',
    'com.googlecode.iterm2',
    'com.mitchellh.ghostty',
    'dev.warp.warp-stable',
    'net.kovidgoyal.kitty',
    'com.github.wez.wezterm',
    'org.alacritty',
    'co.zeit.hyper',
    'org.tabby',
    'windowsterminal.exe',
    'wt.exe',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
    'conhost.exe',
    'openconsole.exe',
    'wezterm-gui.exe',
    'alacritty.exe',
    'mintty.exe',
    'gnome-terminal-server',
    'gnome-terminal',
    'konsole',
    'xterm',
    'kitty',
    'alacritty',
    'wezterm-gui',
    'tilix',
    'terminator',
    'foot',
    'ptyxis',
    'xfce4-terminal',
    'lxterminal',
    'ghostty',
    'warp-terminal',
  ],
  browser: [
    'com.google.chrome',
    'com.google.chrome.canary',
    'com.apple.safari',
    'com.apple.safaritechnologypreview',
    'com.microsoft.edgemac',
    'org.mozilla.firefox',
    'org.mozilla.firefoxdeveloperedition',
    'company.thebrowser.browser',
    'company.thebrowser.dia',
    'com.brave.browser',
    'com.operasoftware.opera',
    'com.vivaldi.vivaldi',
    'org.chromium.chromium',
    'app.zen-browser.zen',
    'com.kagi.kagimacos',
    'chrome.exe',
    'msedge.exe',
    'firefox.exe',
    'brave.exe',
    'opera.exe',
    'vivaldi.exe',
    'arc.exe',
    'iexplore.exe',
    'chrome',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'firefox',
    'firefox-esr',
    'brave',
    'brave-browser',
    'opera',
    'vivaldi-bin',
    'microsoft-edge',
    'msedge',
  ],
}

/** App names of each kind, lowercased, for apps whose identity is not on the lists above. */
const NAMES: Record<Exclude<BlockReason, 'kettu'>, readonly string[]> = {
  password_manager: [
    '1password',
    '1password 7',
    'bitwarden',
    'dashlane',
    'lastpass',
    'nordpass',
    'proton pass',
    'keepassxc',
    'keepass',
    'keychain access',
    'passwords',
    'enpass',
    'roboform',
    'keeper password manager',
  ],
  system: ['system settings', 'system preferences', 'settings', 'control panel'],
  terminal: [
    'terminal',
    'iterm',
    'iterm2',
    'ghostty',
    'warp',
    'kitty',
    'wezterm',
    'alacritty',
    'hyper',
    'tabby',
    'windows terminal',
    'command prompt',
    'windows powershell',
    'powershell',
    'konsole',
    'xterm',
    'tilix',
    'terminator',
    'ptyxis',
  ],
  browser: [
    'google chrome',
    'chrome',
    'safari',
    'safari technology preview',
    'microsoft edge',
    'firefox',
    'arc',
    'brave browser',
    'opera',
    'vivaldi',
    'chromium',
    'orion',
  ],
}

const KINDS = Object.keys(IDS) as Exclude<BlockReason, 'kettu'>[]

/** What Kettu's own processes are, for blocking them. */
export interface SelfApp {
  pids: readonly number[]
  ids: readonly string[]
}

/** Why computer use never touches the app, or null when the user may allow it. */
export function blockedApp(app: ComputerApp, pid: number, self: SelfApp): BlockReason | null {
  const id = app.id.toLowerCase()
  if (self.pids.includes(pid) || self.ids.includes(id)) return 'kettu'
  const name = app.name.trim().toLowerCase()
  for (const kind of KINDS) {
    if (IDS[kind].includes(id) || NAMES[kind].includes(name)) return kind
  }
  return null
}

/** Each modifier's spellings, by the one name the refused shortcuts use. */
const MODIFIERS: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
}

const KEYS: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  backspace: 'delete',
  forwarddelete: 'delete',
}

/** Shortcuts that quit an app, log out, lock, force quit or empty the trash on macOS. */
const REFUSED_ON_MAC = new Set([
  'cmd+q',
  'cmd+shift+q',
  'cmd+alt+shift+q',
  'cmd+ctrl+q',
  'cmd+alt+escape',
  'cmd+shift+delete',
  'cmd+alt+shift+delete',
])

/** The same on Windows and Linux, where Win or Super with L locks and Ctrl+Q quits many apps. */
const REFUSED_ELSEWHERE = new Set([
  'alt+f4',
  'ctrl+q',
  'cmd+l',
  'ctrl+alt+delete',
  'ctrl+shift+escape',
])

const ORDER = ['cmd', 'ctrl', 'alt', 'shift']

/** A key press as one string: its modifiers in a fixed order, then the other keys. */
export function shortcut(keys: readonly string[]): string {
  const mods = new Set<string>()
  const rest: string[] = []
  for (const raw of keys) {
    const key = raw.trim().toLowerCase()
    const mod = MODIFIERS[key]
    if (mod) mods.add(mod)
    else rest.push(KEYS[key] ?? key)
  }
  return [...ORDER.filter((mod) => mods.has(mod)), ...rest].join('+')
}

/** Whether a key press quits an app, logs out, locks, force quits or empties the trash. */
export function refusedShortcut(keys: readonly string[], platform: Platform): boolean {
  return (platform === 'darwin' ? REFUSED_ON_MAC : REFUSED_ELSEWHERE).has(shortcut(keys))
}

const REFUSED_MENU = [
  'quit',
  'exit',
  'log out',
  'logout',
  'sign out',
  'shut down',
  'restart',
  'lock screen',
  'force quit',
  'empty trash',
  'empty bin',
  '退出',
  '注销',
  '登出',
  '关机',
  '重新启动',
  '锁定屏幕',
  '强制退出',
  '清倒废纸篓',
]

/** Whether a menu item quits, logs out, shuts down, locks or empties the trash. */
export function refusedMenuItem(path: readonly string[]): boolean {
  const last = path[path.length - 1]
  if (last === undefined) return false
  const item = last
    .trim()
    .toLowerCase()
    .replace(/(\.\.\.|…)$/, '')
  return REFUSED_MENU.some((word) => item.startsWith(word))
}

/** Huli: a step in an app run as administrator that the user confirms first. */
export interface RiskyStep {
  kind: 'click' | 'type' | 'key' | 'drag' | 'menu'
  /** What it names: the clicked element's label, the keys, the text or the menu item. */
  text: string | null
}

/** Keys that only move about, which need no confirmation without modifiers. */
const MOVING_KEYS = new Set([
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
])

/** Words of a button that commits something, as whole words in a Latin script. */
const COMMIT_WORDS =
  /\b(ok|yes|apply|delete|remove|uninstall|install|format|erase|wipe|reset|run|execute|start|submit|confirm|save|overwrite|replace|allow|accept|agree|continue|next|finish|end task|kill|shut down|restart|update|upgrade|change|disable|enable)\b/
/** The same in Chinese, found anywhere in a label. */
const COMMIT_CJK = [
  '确定',
  '确认',
  '应用',
  '删除',
  '移除',
  '卸载',
  '安装',
  '格式化',
  '清除',
  '清空',
  '重置',
  '运行',
  '执行',
  '开始',
  '提交',
  '保存',
  '覆盖',
  '替换',
  '允许',
  '接受',
  '同意',
  '继续',
  '下一步',
  '完成',
  '结束',
  '关机',
  '重启',
  '更新',
  '升级',
  '更改',
  '禁用',
  '启用',
]
/** One-character answers, which count only as a whole label. */
const COMMIT_EXACT = new Set(['是', '好'])

/** Whether an element's label reads as a button that commits something. */
export function commitLabel(label: string): boolean {
  const text = label
    .toLowerCase()
    .replace(/\(&\w\)|&/g, '')
    .replace(/(\.\.\.|…)$/, '')
    .trim()
  if (!text) return false
  return (
    COMMIT_EXACT.has(text) || COMMIT_WORDS.test(text) || COMMIT_CJK.some((w) => text.includes(w))
  )
}

/**
 * Whether a step in an app run as administrator needs the user's confirmation, and what it is: a
 * click on a committing button or at a bare point, a key other than moving about, any shortcut,
 * text with a line break, a drag or a menu item. Reading and scrolling never do. `label` is the
 * clicked element's, when the click names one.
 */
export function riskyStep(
  call: {
    tool: string
    args: Record<string, unknown>
    elementToken?: string
    keys?: string[]
    menuPath?: string[]
  },
  label: string | null,
): RiskyStep | null {
  switch (call.tool) {
    case 'computer_click':
      if (!call.elementToken || label === null) return { kind: 'click', text: label }
      return commitLabel(label) ? { kind: 'click', text: label } : null
    case 'computer_type_text': {
      const text = typeof call.args.text === 'string' ? call.args.text : ''
      return /[\r\n]/.test(text) ? { kind: 'type', text: text.slice(0, 120) } : null
    }
    case 'computer_press_key': {
      const keys = call.keys ?? []
      const only = keys.length === 1 ? keys[0]!.trim().toLowerCase() : null
      return only && MOVING_KEYS.has(only) ? null : { kind: 'key', text: shortcut(keys) }
    }
    case 'computer_hotkey':
      return { kind: 'key', text: shortcut(call.keys ?? []) }
    case 'computer_drag':
      return { kind: 'drag', text: null }
    case 'computer_invoke_menu':
      return { kind: 'menu', text: (call.menuPath ?? []).join(' › ') }
    default:
      return null
  }
}

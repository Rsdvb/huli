import { describe, expect, it } from 'vitest'
import {
  appIdentity,
  blockedApp,
  refusedMenuItem,
  refusedShortcut,
  riskyStep,
  shortcut,
  type SelfApp,
} from './policy'

const self: SelfApp = { pids: [100, 101], ids: ['sh.kettu.app', 'kettu.exe'] }

describe('appIdentity', () => {
  it('names an app by its bundle id on macOS and its executable elsewhere', () => {
    const app = {
      pid: 5,
      name: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
      launchPath: '/System/Applications/TextEdit.app',
    }
    expect(appIdentity(app, 'darwin')).toEqual({ id: 'com.apple.textedit', name: 'TextEdit' })
    expect(
      appIdentity(
        { pid: 6, name: 'Notepad', bundleId: null, launchPath: 'C:\\Windows\\notepad.exe' },
        'win32',
      ),
    ).toEqual({ id: 'notepad.exe', name: 'Notepad' })
    expect(
      appIdentity({ pid: 7, name: 'gedit', bundleId: null, launchPath: '/usr/bin/gedit' }, 'linux'),
    ).toEqual({ id: 'gedit', name: 'gedit' })
  })

  it('falls back to the name, and has none without one', () => {
    expect(
      appIdentity({ pid: 8, name: 'Thing', bundleId: null, launchPath: null }, 'linux'),
    ).toEqual({
      id: 'thing',
      name: 'Thing',
    })
    expect(appIdentity({ pid: 9, name: ' ', bundleId: null, launchPath: null }, 'linux')).toBeNull()
  })
})

describe('blockedApp', () => {
  const app = (id: string, name = id) => ({ id, name })

  it('blocks Kettu by its process and its identity', () => {
    expect(blockedApp(app('com.github.electron', 'Electron'), 100, self)).toBe('kettu')
    expect(blockedApp(app('sh.kettu.app', 'Kettu'), 5, self)).toBe('kettu')
    expect(blockedApp(app('kettu.exe', 'Kettu'), 5, self)).toBe('kettu')
  })

  it.each([
    ['com.1password.1password', '1Password', 'password_manager'],
    ['com.apple.keychainaccess', 'Keychain Access', 'password_manager'],
    ['unknown.vault', 'Bitwarden', 'password_manager'],
    ['com.apple.systempreferences', 'System Settings', 'system'],
    ['com.apple.securityagent', 'SecurityAgent', 'system'],
    ['consent.exe', 'Consent', 'system'],
    ['com.apple.terminal', 'Terminal', 'terminal'],
    ['com.googlecode.iterm2', 'iTerm2', 'terminal'],
    ['windowsterminal.exe', 'Windows Terminal', 'terminal'],
    ['gnome-terminal-server', 'Terminal', 'terminal'],
    ['com.google.chrome', 'Google Chrome', 'browser'],
    ['com.apple.safari', 'Safari', 'browser'],
    ['msedge.exe', 'Microsoft Edge', 'browser'],
    ['firefox', 'Firefox', 'browser'],
  ])('blocks %s', (id, name, reason) => {
    expect(blockedApp(app(id, name), 5, self)).toBe(reason)
  })

  it('lets the user decide on other apps', () => {
    expect(blockedApp(app('com.apple.textedit', 'TextEdit'), 5, self)).toBeNull()
    expect(blockedApp(app('com.figma.desktop', 'Figma'), 5, self)).toBeNull()
    expect(blockedApp(app('notepad.exe', 'Notepad'), 5, self)).toBeNull()
  })
})

describe('refused shortcuts', () => {
  it('normalises modifiers and their order', () => {
    expect(shortcut(['Shift', 'Command', 'Q'])).toBe('cmd+shift+q')
    expect(shortcut(['option', 'cmd', 'Esc'])).toBe('cmd+alt+escape')
    expect(shortcut(['ctrl', 'alt', 'Del'])).toBe('ctrl+alt+delete')
  })

  it.each([
    [['cmd', 'q'], 'darwin'],
    [['cmd', 'shift', 'q'], 'darwin'],
    [['ctrl', 'cmd', 'q'], 'darwin'],
    [['cmd', 'option', 'escape'], 'darwin'],
    [['cmd', 'shift', 'backspace'], 'darwin'],
    [['alt', 'f4'], 'win32'],
    [['win', 'l'], 'win32'],
    [['ctrl', 'alt', 'delete'], 'win32'],
    [['ctrl', 'shift', 'esc'], 'win32'],
    [['super', 'l'], 'linux'],
    [['ctrl', 'q'], 'linux'],
  ] as const)('refuses %j on %s', (keys, platform) => {
    expect(refusedShortcut(keys, platform)).toBe(true)
  })

  it('lets other shortcuts through', () => {
    expect(refusedShortcut(['cmd', 's'], 'darwin')).toBe(false)
    expect(refusedShortcut(['cmd', 'l'], 'darwin')).toBe(false)
    expect(refusedShortcut(['ctrl', 'q'], 'darwin')).toBe(false)
    expect(refusedShortcut(['ctrl', 's'], 'win32')).toBe(false)
    expect(refusedShortcut(['q'], 'darwin')).toBe(false)
  })
})

describe('refused menu items', () => {
  it.each([
    [['TextEdit', 'Quit TextEdit']],
    [['Apple', 'Log Out Kettu…']],
    [['Finder', 'Empty Trash...']],
    [['Apple', 'Force Quit…']],
    [['Apple', 'Shut Down…']],
    [['TextEdit', '退出 TextEdit']],
  ])('refuses %j', (path) => {
    expect(refusedMenuItem(path)).toBe(true)
  })

  it('lets other items through', () => {
    expect(refusedMenuItem(['Format', 'Make Plain Text'])).toBe(false)
    expect(refusedMenuItem(['File', 'Export as PDF…'])).toBe(false)
    expect(refusedMenuItem([])).toBe(false)
  })
})

describe('Huli: riskyStep', () => {
  const click = (label: string | null, token = true) =>
    riskyStep(
      { tool: 'computer_click', args: {}, ...(token ? { elementToken: 's00000001:3' } : {}) },
      label,
    )

  it('asks before a click that commits, or at a point it cannot name', () => {
    expect(click('Delete')).toEqual({ kind: 'click', text: 'Delete' })
    expect(click('确定')).toEqual({ kind: 'click', text: '确定' })
    expect(click('是')).toEqual({ kind: 'click', text: '是' })
    expect(click('&Apply')).toEqual({ kind: 'click', text: '&Apply' })
    expect(click(null, false)).toEqual({ kind: 'click', text: null })
    expect(click(null)).toEqual({ kind: 'click', text: null })
    expect(click('Details')).toBeNull()
    expect(click('Token')).toBeNull()
    expect(click('是否显示')).toBeNull()
  })

  it('asks before keys, shortcuts, line breaks, drags and menus, but not reading or moving', () => {
    const key = (keys: string[]) => riskyStep({ tool: 'computer_press_key', args: {}, keys }, null)
    expect(key(['tab'])).toBeNull()
    expect(key(['down'])).toBeNull()
    expect(key(['return'])).toEqual({ kind: 'key', text: 'return' })
    expect(key(['shift', 'tab'])).toEqual({ kind: 'key', text: 'shift+tab' })
    expect(riskyStep({ tool: 'computer_hotkey', args: {}, keys: ['ctrl', 'c'] }, null)).toEqual({
      kind: 'key',
      text: 'ctrl+c',
    })
    expect(riskyStep({ tool: 'computer_type_text', args: { text: 'name' } }, null)).toBeNull()
    expect(riskyStep({ tool: 'computer_type_text', args: { text: 'del x\n' } }, null)).toEqual({
      kind: 'type',
      text: 'del x\n',
    })
    expect(riskyStep({ tool: 'computer_drag', args: {} }, null)).toEqual({
      kind: 'drag',
      text: null,
    })
    expect(
      riskyStep({ tool: 'computer_invoke_menu', args: {}, menuPath: ['File', 'Save'] }, null),
    ).toEqual({ kind: 'menu', text: 'File › Save' })
    expect(riskyStep({ tool: 'computer_scroll', args: {} }, null)).toBeNull()
    expect(riskyStep({ tool: 'computer_get_window_state', args: {} }, null)).toBeNull()
  })
})

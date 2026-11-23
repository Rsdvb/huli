import { describe, expect, it } from 'vitest'
import {
  appIdentity,
  blockedApp,
  refusedMenuItem,
  refusedShortcut,
  sandboxGate,
  shortcut,
  startsPrograms,
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

describe('Huli: startsPrograms', () => {
  it('names the programs whose dialogs start programs, which never run as administrator', () => {
    for (const id of [
      'taskmgr.exe',
      'CMD.EXE',
      'explorer.exe',
      'mshta.exe',
      'msiexec.exe',
      'mmc.exe',
      'SystemInformer.exe',
      'procexp64.exe',
      'Autoruns64.exe',
      'wsl.exe',
      'mintty.exe',
      'python3.12.exe',
      'pythonw.exe',
      'node.exe',
    ]) {
      expect(startsPrograms(id), id).toBe(true)
    }
    expect(startsPrograms('notepad.exe')).toBe(false)
    expect(startsPrograms('hwinfo64.exe')).toBe(false)
  })
})

describe('Huli: the gate of administrator use in sandboxed sessions only', () => {
  const contained = { contained: true, title: 'In a container' }
  const outside = { contained: false, title: 'Outside' }

  it('lets a session in a container sandbox through while every other running one is too', () => {
    expect(sandboxGate(contained, [])).toBeNull()
    expect(
      sandboxGate(contained, [contained, { contained: true, title: 'Also in one' }]),
    ).toBeNull()
  })

  it('refuses a session outside one, and a session that is gone', () => {
    expect(sandboxGate(outside, [])).toContain('this session is not in one')
    expect(sandboxGate(null, [])).toContain('this session is not in one')
  })

  it('refuses while any other running session is outside one, naming it and saying why', () => {
    const refusal = sandboxGate(contained, [contained, outside])
    expect(refusal).toContain('“Outside”')
    expect(refusal).toContain('could take over Windows’ administrator prompt')
    const many = sandboxGate(
      contained,
      ['A', 'B', 'C', 'D', 'E'].map((title) => ({ contained: false, title })),
    )
    expect(many).toContain('“A”, “B”, “C” and 2 more')
  })
})

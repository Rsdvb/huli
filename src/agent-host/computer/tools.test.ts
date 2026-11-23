import { describe, expect, it } from 'vitest'
import { driverEnv } from './driver'
import { ComputerToolError, computerCall } from './tools'

function refused(name: string, input: unknown): string {
  try {
    computerCall(name, input, 'darwin')
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerToolError)
    expect((error as ComputerToolError).code).toBe('invalid')
    return (error as Error).message
  }
  throw new Error(`${name} was accepted`)
}

describe('the computer tools', () => {
  it('collects the keys a press makes for the refused shortcuts', () => {
    expect(
      computerCall(
        'computer_press_key',
        { pid: 1, window_id: 2, key: 'q', modifiers: ['cmd'] },
        'darwin',
      ).keys,
    ).toEqual(['cmd', 'q'])
    expect(
      computerCall('computer_hotkey', { pid: 1, window_id: 2, keys: ['cmd', 'q'] }, 'darwin').keys,
    ).toEqual(['cmd', 'q'])
  })

  it('passes no argument the driver would take beyond the schema', () => {
    for (const extra of [
      { screenshot_out_file: '/tmp/x.png' },
      { debug_image_out: '/tmp/x.png' },
      { scope: 'desktop' },
      { session: 'other' },
      { target: { kind: 'desktop', display_id: 'primary' } },
    ]) {
      refused('computer_click', { pid: 1, window_id: 2, x: 3, y: 4, ...extra })
    }
    refused('computer_get_window_state', { pid: 1, window_id: 2, full_output: true })
  })

  it('checks each argument as its schema says', () => {
    refused('computer_list_windows', {})
    refused('computer_list_windows', { pid: 0 })
    refused('computer_list_windows', { pid: 1.5 })
    refused('computer_get_window_state', { pid: 1 })
    refused('computer_get_window_state', {
      pid: 1,
      window_id: 2,
      include_screenshot: false,
      include_accessibility_tree: false,
    })
    refused('computer_click', { pid: 1, window_id: 2 })
    refused('computer_click', { pid: 1, window_id: 2, x: 3 })
    refused('computer_click', { pid: 1, window_id: 2, element_token: 's0000002a:1', x: 1, y: 1 })
    refused('computer_click', { pid: 1, window_id: 2, element_token: 'e12' })
    refused('computer_click', { pid: 1, window_id: 2, x: -1, y: 1 })
    refused('computer_click', { pid: 1, window_id: 2, x: 1, y: 1, delivery_mode: 'global' })
    refused('computer_type_text', { pid: 1, window_id: 2, text: 'x'.repeat(20_001) })
    refused('computer_press_key', { pid: 1, window_id: 2, key: ' ' })
    refused('computer_press_key', { pid: 1, window_id: 2, key: 'a', modifiers: ['hyper'] })
    refused('computer_hotkey', { pid: 1, window_id: 2, keys: ['cmd'] })
    refused('computer_scroll', { pid: 1, window_id: 2, x: 1, y: 1 })
    refused('computer_invoke_menu', { pid: 1, window_id: 2, path: [] })
    refused('computer_list_apps', 'all')
    refused('computer_open_terminal', {})
  })
})

describe('Huli: delivery and text recognition', () => {
  it('sends every action in the background unless it names the foreground', () => {
    const base = { pid: 1, window_id: 2 }
    const calls = [
      computerCall('computer_click', { ...base, x: 1, y: 1 }, 'win32'),
      computerCall('computer_type_text', { ...base, text: 'a' }, 'win32'),
      computerCall('computer_press_key', { ...base, key: 'a' }, 'win32'),
      computerCall('computer_hotkey', { ...base, keys: ['ctrl', 'a'] }, 'win32'),
      computerCall('computer_scroll', { ...base, x: 1, y: 1, direction: 'down' }, 'win32'),
      computerCall('computer_drag', { ...base, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }, 'win32'),
      computerCall('computer_invoke_menu', { ...base, path: ['File', 'Open'] }, 'win32'),
    ]
    for (const call of calls) expect(call.args.delivery_mode).toBe('background')
    expect(
      computerCall(
        'computer_type_text',
        { ...base, text: 'a', delivery_mode: 'foreground' },
        'win32',
      ).args.delivery_mode,
    ).toBe('foreground')
    refused('computer_press_key', { ...base, key: 'a', delivery_mode: 'global' })
    refused('computer_invoke_menu', { ...base, path: ['File'], delivery_mode: 1 })
  })

  it('keeps the text recognition flag from the driver', () => {
    const call = computerCall(
      'computer_get_window_state',
      { pid: 1, window_id: 2, ocr: true },
      'win32',
    )
    expect(call.ocr).toBe(true)
    expect(call.args.ocr).toBeUndefined()
    refused('computer_get_window_state', { pid: 1, window_id: 2, ocr: 'yes' })
  })
})

describe('the driver environment', () => {
  it('keeps the driver embedded, off the network and out of the unrestricted mode', () => {
    const env = driverEnv({
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
      CUA_HOME: '/somewhere',
      DO_NOT_TRACK: '0',
      ANTHROPIC_API_KEY: 'secret',
    })
    expect(env).toEqual({
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUA_DRIVER_EMBEDDED: '1',
      DO_NOT_TRACK: '1',
      CUA_DRIVER_RS_UPDATE_CHECK: 'false',
      CUA_DRIVER_DISABLE_UNRESTRICTED: '1',
    })
  })
})

// The `device_*` tools on Kettu's MCP service: an agent lists, opens and drives the mobile devices
// of its host. Kettu checks every argument and builds the action itself, asks the user before a
// session first uses a device, and the device host carries the action out.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import {
  DEVICE_ACCESS_WAIT_MS,
  DEVICE_ALERT_ACTIONS,
  DEVICE_BATCH_COMMANDS,
  DEVICE_CALL_TIMEOUT_MS,
  DEVICE_CAPTURES_FOLDER,
  DEVICE_FIND_ACTIONS,
  DEVICE_FIND_LOCATORS,
  DEVICE_IS_PREDICATES,
  DEVICE_KEYBOARD_ACTIONS,
  DEVICE_NETWORK_INCLUDES,
  DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_STATES,
  DEVICE_TOOL_NAMES,
  MAX_DEVICE_BATCH_STEPS,
  MAX_DEVICE_PUSH_BYTES,
  MAX_DEVICE_RECORDING_MS,
  type DeviceAccessAnswer,
  type DeviceAction,
  type DeviceBatchCommand,
  type DeviceBatchStep,
  type DeviceCall,
  type DeviceCallAnswer,
  type DeviceLevel,
  type DevicePermissionState,
  type DeviceToolName,
} from '@shared/device-agent'
import type { DeviceInfo } from '@shared/device-host'
import type { Caller } from '../artifacts/tools'

type Schema = Record<string, unknown>

function object(properties: Record<string, Schema>, required: string[] = []): Tool['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false }
}

const DEVICE_ID: Schema = {
  type: 'string',
  description: 'The device id that device_list gives, such as ios-sim:<udid> or android:<serial>.',
}
const REF: Schema = {
  type: 'string',
  description: 'An element reference from the latest device_snapshot, such as @e3.',
}
const SELECTOR: Schema = {
  type: 'string',
  description:
    'An agent-device selector of keys and values, such as label="Sign in", id="email" or ' +
    'role=button label="OK"; keys are id, role, text, label, value, visible, hidden, editable, ' +
    'selected, checked, focused, enabled and hittable.',
}
const LEVEL: Schema = {
  type: 'string',
  enum: ['digest'],
  description: 'digest answers in a compact form that costs fewer tokens.',
}
const TIMEOUT: Schema = { type: 'integer', minimum: 100, maximum: 60_000 }
const APP: Schema = { type: 'string', description: 'A bundle id or Android package.' }
const READ_ONLY = { readOnlyHint: true } as const
const ACTS = { readOnlyHint: false, openWorldHint: false } as const
const RECORDING_MINUTES = MAX_DEVICE_RECORDING_MS / 60_000

export const DEVICE_TOOLS: Tool[] = [
  {
    name: 'device_list',
    title: 'List mobile devices',
    description:
      'Lists the iOS simulators, Android emulators and connected phones on this host, with their ids, state and anything they still need.',
    inputSchema: object({}),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_open',
    title: 'Open a mobile device',
    description:
      'Opens a device for this session and shows it beside the conversation; a shut-down simulator or emulator boots first. Asks the user the first time.',
    inputSchema: object({ deviceId: DEVICE_ID }, ['deviceId']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_close',
    title: 'Close a mobile device',
    description:
      'Lets go of a device this session opened. `shutdown` also shuts a simulator or emulator down.',
    inputSchema: object({ deviceId: DEVICE_ID, shutdown: { type: 'boolean', default: false } }, [
      'deviceId',
    ]),
    annotations: { ...ACTS },
  },
  {
    name: 'device_snapshot',
    title: 'Read the device screen',
    description:
      'The accessibility tree of what the device shows, each actionable element with a reference such as @e3. References change after the screen changes; read again then.',
    inputSchema: object({ deviceId: DEVICE_ID, level: LEVEL }, ['deviceId']),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_tap',
    title: 'Tap on the device',
    description:
      'Taps an element by reference, or a point in device points when no element fits. `long` holds it. Returns the screen changes once they settle.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        ref: REF,
        x: { type: 'number', minimum: 0 },
        y: { type: 'number', minimum: 0 },
        long: { type: 'boolean', default: false },
        level: LEVEL,
      },
      ['deviceId'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_fill',
    title: 'Fill a field on the device',
    description: 'Replaces the text of an input element.',
    inputSchema: object({ deviceId: DEVICE_ID, ref: REF, text: { type: 'string' }, level: LEVEL }, [
      'deviceId',
      'ref',
      'text',
    ]),
    annotations: { ...ACTS },
  },
  {
    name: 'device_type',
    title: 'Type on the device',
    description: 'Types text into the focused field, after what it holds.',
    inputSchema: object({ deviceId: DEVICE_ID, text: { type: 'string' } }, ['deviceId', 'text']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_scroll',
    title: 'Scroll on the device',
    description: 'Scrolls the screen one page in a direction.',
    inputSchema: object(
      { deviceId: DEVICE_ID, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } },
      ['deviceId', 'direction'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_swipe',
    title: 'Swipe on the device',
    description: 'Drags a finger from one point to another, in device points.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        fromX: { type: 'number', minimum: 0 },
        fromY: { type: 'number', minimum: 0 },
        toX: { type: 'number', minimum: 0 },
        toY: { type: 'number', minimum: 0 },
      },
      ['deviceId', 'fromX', 'fromY', 'toX', 'toY'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_press_button',
    title: 'Press a device button',
    description:
      'Presses a hardware or system button: home, back (Android), recents, lock, volumeUp or volumeDown.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        button: {
          type: 'string',
          enum: ['home', 'back', 'recents', 'lock', 'volumeUp', 'volumeDown'],
        },
      },
      ['deviceId', 'button'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_rotate',
    title: 'Rotate the device',
    description: 'Sets the orientation.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        orientation: {
          type: 'string',
          enum: ['portrait', 'portrait_upside_down', 'landscape_left', 'landscape_right'],
        },
      },
      ['deviceId', 'orientation'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_screenshot',
    title: 'Take a device screenshot',
    description: 'A picture of the screen. Prefer device_snapshot to find what to tap.',
    inputSchema: object({ deviceId: DEVICE_ID }, ['deviceId']),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_install_app',
    title: 'Install an app on the device',
    description:
      'Installs an app the project built: a .app for a simulator, an .ipa for an iPhone, an .apk for Android. Build it with the project’s own commands first.',
    inputSchema: object({ deviceId: DEVICE_ID, path: { type: 'string' } }, ['deviceId', 'path']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_launch_app',
    title: 'Launch an app on the device',
    description:
      'Launches an installed app by bundle id or Android package, restarting it if it runs, and follows it for later snapshots and logs.',
    inputSchema: object({ deviceId: DEVICE_ID, app: { type: 'string' } }, ['deviceId', 'app']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_terminate_app',
    title: 'Quit an app on the device',
    description: 'Stops a running app by bundle id or Android package.',
    inputSchema: object({ deviceId: DEVICE_ID, app: { type: 'string' } }, ['deviceId', 'app']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_open_url',
    title: 'Open a URL on the device',
    description: 'Opens a web address or a deep link, which the app registered for it handles.',
    inputSchema: object({ deviceId: DEVICE_ID, url: { type: 'string' } }, ['deviceId', 'url']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_logs',
    title: 'Read device logs',
    description:
      'The latest log lines of the app open in this session (launch it with device_launch_app ' +
      'first), and its crash reports since it started: the crash, the exception and the top ' +
      'frames. The first call starts the log capture.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        lines: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
        crashes: {
          type: 'boolean',
          default: true,
          description: 'Adds the crash reports of the app since it started.',
        },
      },
      ['deviceId'],
    ),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_set_appearance',
    title: 'Set light or dark mode',
    description: 'Switches the device between light and dark appearance.',
    inputSchema: object(
      { deviceId: DEVICE_ID, mode: { type: 'string', enum: ['light', 'dark'] } },
      ['deviceId', 'mode'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_set_location',
    title: 'Set the device location',
    description: 'Moves a simulator or emulator to a coordinate.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
      },
      ['deviceId', 'latitude', 'longitude'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_set_permission',
    title: 'Grant, deny or reset an app permission',
    description:
      'Grants, denies or resets a permission of an app, such as camera, photos, location or ' +
      'notifications; reset makes the app ask again. all changes every one the device can.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        app: APP,
        permission: { type: 'string', enum: [...DEVICE_PERMISSIONS] },
        state: { type: 'string', enum: [...DEVICE_PERMISSION_STATES] },
      },
      ['deviceId', 'app', 'permission', 'state'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_wait',
    title: 'Wait on the device',
    description:
      'Waits until text shows on the screen, an element a selector names shows (or with absent, ' +
      'is gone), or the screen stays still. Use it for what loads late, instead of reading the ' +
      'screen again and again. Give one of text, selector, absent and stable.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        text: { type: 'string', description: 'Text to show, matched to a label, id or value.' },
        selector: SELECTOR,
        absent: { ...SELECTOR, description: 'A selector whose element must be gone.' },
        stable: { type: 'boolean', description: 'Waits until the screen stops changing.' },
        quietMs: {
          type: 'integer',
          minimum: 100,
          maximum: 10_000,
          description: 'With stable: how long the screen stays still.',
        },
        timeoutMs: { ...TIMEOUT, description: 'The longest it waits, in ms.' },
      },
      ['deviceId'],
    ),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_find',
    title: 'Find an element on the device',
    description:
      'Finds an element by its text, label, value, role or id and acts on it. exists, the ' +
      'default, only checks that one is there; list names the matches; getText and getAttrs ' +
      'read it; wait waits for it; click, focus, fill and type act on it.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        query: { type: 'string', description: 'The words to find.' },
        locator: { type: 'string', enum: [...DEVICE_FIND_LOCATORS], default: 'any' },
        action: { type: 'string', enum: [...DEVICE_FIND_ACTIONS], default: 'exists' },
        value: { type: 'string', description: 'The text for fill and type.' },
        pick: {
          type: 'string',
          enum: ['first', 'last'],
          description: 'Which match to take when several do.',
        },
        timeoutMs: { ...TIMEOUT, description: 'With wait: the longest it waits, in ms.' },
        level: LEVEL,
      },
      ['deviceId', 'query'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_is',
    title: 'Check the device screen',
    description:
      'Checks that the element a selector names is visible, hidden, there (exists), gone ' +
      '(absent), editable, selected, checked or focused, or that its text is value. Answers ' +
      'yes or no without waiting; device_wait waits.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        predicate: { type: 'string', enum: [...DEVICE_IS_PREDICATES] },
        selector: SELECTOR,
        value: { type: 'string', description: 'With text: the text it should have.' },
      },
      ['deviceId', 'predicate', 'selector'],
    ),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_get',
    title: 'Read an element on the device',
    description:
      'Reads the text or the accessibility attributes of an element, by reference or selector, ' +
      'without changing anything.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        format: { type: 'string', enum: ['text', 'attrs'] },
        ref: REF,
        selector: SELECTOR,
        level: LEVEL,
      },
      ['deviceId', 'format'],
    ),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_alert',
    title: 'Handle a system alert on the device',
    description:
      'Reads (get, the default), waits for, accepts or dismisses the system alert the device ' +
      'shows, such as a permission prompt. Read it first when what it says matters.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        action: { type: 'string', enum: [...DEVICE_ALERT_ACTIONS], default: 'get' },
        timeoutMs: { ...TIMEOUT, description: 'With wait: the longest it waits, in ms.' },
      },
      ['deviceId'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_keyboard',
    title: 'Use the device keyboard',
    description:
      'Reads whether the on-screen keyboard shows and its return key (status, the default), ' +
      'hides it (dismiss), or presses its return key (enter).',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        action: { type: 'string', enum: [...DEVICE_KEYBOARD_ACTIONS], default: 'status' },
      },
      ['deviceId'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_batch',
    title: 'Run steps on the device',
    description:
      `Runs up to ${MAX_DEVICE_BATCH_STEPS} steps in one call, in order, which saves a round ` +
      'trip each: snapshot, press, longpress, fill, type, scroll, back, home, wait, is, get, ' +
      'find, alert and keyboard. Each step is {"command", "input"}, input in agent-device’s ' +
      'names: a target as ref ("@e3"), selector, or x and y; text, direction, settle (true ' +
      'waits for the screen and gives what changed), and as the matching tools take them ' +
      '(predicate, format, query, action, value, timeoutMs). It stops at the first failing ' +
      'step unless stopOnError is false.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_DEVICE_BATCH_STEPS,
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', enum: [...DEVICE_BATCH_COMMANDS] },
              input: { type: 'object' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
        stopOnError: { type: 'boolean', default: true },
        level: LEVEL,
      },
      ['deviceId', 'steps'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_record_start',
    title: 'Record the device screen',
    description:
      `Starts recording the device screen into an .mp4 in this session’s folder, under ` +
      `${DEVICE_CAPTURES_FOLDER}/recordings. It stops by itself after ${RECORDING_MINUTES} ` +
      'minutes; device_record_stop stops it and shows the video in the conversation.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        name: {
          type: 'string',
          description:
            'The video’s file name, without .mp4: letters, digits, dots, dashes and underscores. ' +
            'The time it started by default.',
        },
      },
      ['deviceId'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_record_stop',
    title: 'Stop recording the device screen',
    description:
      'Stops the recording device_record_start began, or gives the one that stopped at its ' +
      'limit, with where the video is and how long it runs.',
    inputSchema: object({ deviceId: DEVICE_ID }, ['deviceId']),
    annotations: { ...ACTS },
  },
  {
    name: 'device_screenshot_compare',
    title: 'Compare the device screen',
    description:
      'Takes a screenshot and compares it with a baseline .png in this session’s folder, or ' +
      'without one with the previous shot this tool took. Returns the share of pixels that ' +
      'differ, where they changed and a picture of the differences. A baseline that does not ' +
      'exist yet is saved from this shot; update keeps the new shot as the baseline.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        baseline: {
          type: 'string',
          description:
            'A .png by its path from this session’s folder, such as tests/screens/home.png.',
        },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'How far a pixel’s color may differ and still match, from 0 (exact) to 1; 0.1 by default.',
        },
        update: {
          type: 'boolean',
          default: false,
          description: 'With baseline: keeps this shot as the baseline once compared.',
        },
      },
      ['deviceId'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_network',
    title: 'Read the app’s network activity',
    description:
      'The latest HTTP requests of the app open in this session, as its logs show them: method, ' +
      'address, status and timing, with headers or bodies when asked. They come from the app’s ' +
      'log capture, which the first call starts; an app that logs no requests shows none.',
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        include: { type: 'string', enum: [...DEVICE_NETWORK_INCLUDES], default: 'summary' },
      },
      ['deviceId'],
    ),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_push',
    title: 'Send a test push notification',
    description:
      'Sends a test push notification to an app on an iOS simulator or an Android device. On ' +
      'iOS the payload is an APNs payload with an "aps" object, such as {"aps":{"alert":"Hi"}}. ' +
      'On Android it is a broadcast to the app: {"action", "receiver", "extras"}, the action ' +
      '<package>.TEST_PUSH by default and extras of strings, numbers and booleans. ' +
      `At most ${MAX_DEVICE_PUSH_BYTES} bytes as JSON.`,
    inputSchema: object(
      {
        deviceId: DEVICE_ID,
        app: {
          ...APP,
          description: 'A bundle id or Android package; the session’s app by default.',
        },
        payload: { type: 'object' },
      },
      ['deviceId', 'payload'],
    ),
    annotations: { ...ACTS },
  },
  {
    name: 'device_perf',
    title: 'Sample the app’s performance',
    description:
      'Samples the app open in this session: its CPU use over one second, where 100 is one ' +
      'core, and its memory.',
    inputSchema: object({ deviceId: DEVICE_ID }, ['deviceId']),
    annotations: { ...READ_ONLY },
  },
  {
    name: 'device_reset_app',
    title: 'Reset an app’s data',
    description:
      'Clears the data of an app on an iOS simulator or an Android device, as a fresh install ' +
      'has it. keychain also resets the iOS simulator’s whole keychain, for every app on it.',
    inputSchema: object(
      { deviceId: DEVICE_ID, app: APP, keychain: { type: 'boolean', default: false } },
      ['deviceId', 'app'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
]

export function isDeviceToolName(name: string): name is DeviceToolName {
  return (DEVICE_TOOL_NAMES as readonly string[]).includes(name)
}

/** 仅列出和读取移动设备状态的工具，未授权设备仍由 Kettu 首次设备授权卡把关。 */
export const DEVICE_READ_TOOLS: readonly DeviceToolName[] = [
  'device_list',
  'device_snapshot',
  'device_screenshot',
  'device_logs',
]

/** 仅在 Auto 模式下自动放行的设备调试交互工具（首次接入设备仍由 Kettu 授权卡把关）。 */
export const DEVICE_AUTO_MODE_TOOLS: readonly DeviceToolName[] = [
  'device_open',
  'device_close',
  'device_tap',
  'device_fill',
  'device_type',
  'device_scroll',
  'device_swipe',
  'device_press_button',
  'device_rotate',
  'device_install_app',
  'device_launch_app',
  'device_terminate_app',
  'device_open_url',
  'device_set_appearance',
  'device_set_location',
  'device_set_permission',
]

export interface DeviceToolDeps {
  call(call: DeviceCall): Promise<DeviceCallAnswer>
  /** The session whose devices a call uses: a subagent's, the session it runs under. */
  sessionOf(sessionId: string): string
  agentName(sessionId: string): string
  projectOf(sessionId: string): string | null
  /** Asks the user in the session's thread whether its agent may use the device. */
  ask(sessionId: string, deviceId: string, deviceName: string): Promise<DeviceAccessAnswer>
  /** Devices the user always allows, kept on the host. */
  alwaysAllowed(deviceId: string): boolean
  allowAlways(deviceId: string): void
  /** Full access uses a device without asking. */
  fullAccess?(sessionId: string): boolean
  /** Full access let the agent use a device without asking: the thread says so. */
  used?(sessionId: string, name: string): void
  /** The user referenced the device in a message to the session, which allows it. */
  shared?(sessionId: string, deviceId: string): boolean
}

export class DeviceArgsError extends Error {}

const MAX_TEXT = 4096
const MAX_NAME = 512
const MAX_SELECTOR = 512

function args(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  return input as Record<string, unknown>
}

function text(value: unknown, key: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new DeviceArgsError(`"${key}" must be a non-empty string of at most ${max} characters`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value))
    throw new DeviceArgsError(`"${key}" has control characters`)
  return value
}

function number(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DeviceArgsError(`"${key}" must be a number from ${min} to ${max}`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T))
    throw new DeviceArgsError(`"${key}" must be one of ${allowed.join(', ')}`)
  return value as T
}

function optionalNumber(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DeviceArgsError(`"${key}" must be a whole number from ${min} to ${max}`)
  }
  return number(value, key, min, max)
}

function flag(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new DeviceArgsError(`"${key}" must be true or false`)
  return value
}

/** A reference from a snapshot, as agent-device writes it: @e3, or @e12~s4 pinned to its frame. */
function deviceRef(value: unknown, key = 'ref'): string {
  const ref = text(value, key, 32)
  if (!/^@?e\d+(~s\d+)?$/.test(ref))
    throw new DeviceArgsError(`"${key}" must be a reference such as @e3`)
  return ref.startsWith('@') ? ref : `@${ref}`
}

// Words agent-device reads as a kind of wait, not as a selector.
const WAIT_WORDS = new Set(['text', 'absent', 'stable'])

/** A selector such as label="OK"; one that would read as a ref, a time or another word is not. */
function selector(value: unknown, key = 'selector'): string {
  const given = text(value, key, MAX_SELECTOR)
  if (
    given.trim() !== given ||
    given.startsWith('@') ||
    /^\d+$/.test(given) ||
    WAIT_WORDS.has(given)
  ) {
    throw new DeviceArgsError(`"${key}" must be a selector such as label="Sign in"`)
  }
  return given
}

function level(value: unknown): { level?: DeviceLevel } {
  if (value === undefined) return {}
  return { level: oneOf(value, 'level', ['digest'] as const) }
}

/** Which keys an input may hold. */
function only(input: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw new DeviceArgsError(`${what} takes no "${key}"`)
  }
}

/** A step's target: exactly one of a ref, a selector, or a point. */
function target(input: Record<string, unknown>, what: string): Record<string, string | number> {
  const forms = [
    input.ref !== undefined,
    input.selector !== undefined,
    input.x !== undefined || input.y !== undefined,
  ]
  if (forms.filter(Boolean).length !== 1) {
    throw new DeviceArgsError(`${what} needs one target: ref, selector, or x and y`)
  }
  if (input.ref !== undefined) return { ref: deviceRef(input.ref) }
  if (input.selector !== undefined) return { selector: selector(input.selector) }
  return { x: number(input.x, 'x', 0, 100_000), y: number(input.y, 'y', 0, 100_000) }
}

/** A batch step's input, rebuilt from the keys each command takes, each checked. */
function batchStep(value: unknown, index: number): DeviceBatchStep {
  const what = `Step ${index + 1}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeviceArgsError(`${what} must be {"command", "input"}`)
  }
  const step = value as Record<string, unknown>
  only(step, ['command', 'input'], what)
  const command = oneOf(step.command, `${what} command`, DEVICE_BATCH_COMMANDS)
  const raw = step.input === undefined ? {} : step.input
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DeviceArgsError(`${what} input must be an object`)
  }
  const given = raw as Record<string, unknown>
  const named = `${what} (${command})`
  const input: Record<string, string | number | boolean> = {}
  const put = (key: string, checked: string | number | boolean | undefined): void => {
    if (checked !== undefined) input[key] = checked
  }
  const settle = (): void => put('settle', flag(given.settle, 'settle'))
  switch (command as DeviceBatchCommand) {
    case 'snapshot':
      only(given, ['interactiveOnly', 'depth', 'scope'], named)
      put('interactiveOnly', flag(given.interactiveOnly, 'interactiveOnly'))
      put('depth', optionalNumber(given.depth, 'depth', 1, 100))
      if (given.scope !== undefined) put('scope', text(given.scope, 'scope', MAX_SELECTOR))
      break
    case 'press':
      only(given, ['ref', 'selector', 'x', 'y', 'settle', 'doubleTap', 'count'], named)
      Object.assign(input, target(given, named))
      settle()
      put('doubleTap', flag(given.doubleTap, 'doubleTap'))
      put('count', optionalNumber(given.count, 'count', 1, 10))
      break
    case 'longpress':
      only(given, ['ref', 'selector', 'x', 'y', 'settle', 'durationMs'], named)
      Object.assign(input, target(given, named))
      settle()
      put('durationMs', optionalNumber(given.durationMs, 'durationMs', 100, 10_000))
      break
    case 'fill':
      only(given, ['ref', 'selector', 'x', 'y', 'text', 'settle'], named)
      Object.assign(input, target(given, named))
      // An empty text clears the field.
      if (given.text !== '') put('text', text(given.text, 'text'))
      else input.text = ''
      settle()
      break
    case 'type':
      only(given, ['text'], named)
      input.text = text(given.text, 'text')
      break
    case 'scroll':
      only(given, ['direction', 'amount', 'until', 'settle'], named)
      input.direction = oneOf(given.direction, 'direction', [
        'up',
        'down',
        'left',
        'right',
        'top',
        'bottom',
      ] as const)
      if (given.amount !== undefined) input.amount = number(given.amount, 'amount', 0, 20)
      if (given.until !== undefined) input.until = selector(given.until, 'until')
      settle()
      break
    case 'back':
      only(given, ['settle'], named)
      settle()
      break
    case 'home':
      only(given, [], named)
      break
    case 'wait': {
      only(
        given,
        ['text', 'selector', 'absent', 'stable', 'durationMs', 'quietMs', 'timeoutMs'],
        named,
      )
      const kinds = ['text', 'selector', 'absent', 'stable', 'durationMs'].filter(
        (key) => given[key] !== undefined,
      )
      if (kinds.length !== 1) {
        throw new DeviceArgsError(
          `${named} needs one of text, selector, absent, stable and durationMs`,
        )
      }
      if (given.text !== undefined) input.text = text(given.text, 'text')
      if (given.selector !== undefined) input.selector = selector(given.selector)
      if (given.absent !== undefined) input.absent = selector(given.absent, 'absent')
      if (given.stable !== undefined) {
        if (given.stable !== true) throw new DeviceArgsError(`${named} stable must be true`)
        input.stable = true
        put('quietMs', optionalNumber(given.quietMs, 'quietMs', 100, 10_000))
      } else if (given.quietMs !== undefined) {
        throw new DeviceArgsError(`${named} quietMs is for stable`)
      }
      put('durationMs', optionalNumber(given.durationMs, 'durationMs', 1, 30_000))
      put('timeoutMs', optionalNumber(given.timeoutMs, 'timeoutMs', 100, 60_000))
      break
    }
    case 'is': {
      only(given, ['predicate', 'selector', 'value'], named)
      const predicate = oneOf(given.predicate, 'predicate', DEVICE_IS_PREDICATES)
      input.predicate = predicate
      input.selector = selector(given.selector)
      if (predicate === 'text') input.value = text(given.value, 'value')
      else if (given.value !== undefined) throw new DeviceArgsError(`${named} value is for text`)
      break
    }
    case 'get':
      only(given, ['format', 'ref', 'selector'], named)
      input.format = oneOf(given.format, 'format', ['text', 'attrs'] as const)
      if ((given.ref === undefined) === (given.selector === undefined)) {
        throw new DeviceArgsError(`${named} needs a ref or a selector`)
      }
      if (given.ref !== undefined) input.ref = deviceRef(given.ref)
      else input.selector = selector(given.selector)
      break
    case 'find': {
      only(given, ['locator', 'query', 'action', 'value', 'first', 'last', 'timeoutMs'], named)
      const found = findAction(given)
      input.query = found.query
      if (found.locator !== 'any') input.locator = found.locator
      input.action = found.action
      put('value', found.value)
      if (found.pick) input[found.pick] = true
      put('timeoutMs', found.timeoutMs)
      break
    }
    case 'alert':
      only(given, ['action', 'timeoutMs'], named)
      if (given.action !== undefined)
        input.action = oneOf(given.action, 'action', DEVICE_ALERT_ACTIONS)
      put('timeoutMs', optionalNumber(given.timeoutMs, 'timeoutMs', 100, 60_000))
      break
    case 'keyboard':
      only(given, ['action'], named)
      if (given.action !== undefined) {
        input.action = oneOf(given.action, 'action', DEVICE_KEYBOARD_ACTIONS)
      }
      break
  }
  return { command, input }
}

/** What `device_find` and a find step ask for, checked. */
function findAction(input: Record<string, unknown>): Extract<DeviceAction, { type: 'find' }> {
  const locator =
    input.locator === undefined ? 'any' : oneOf(input.locator, 'locator', DEVICE_FIND_LOCATORS)
  const query = text(input.query, 'query', MAX_SELECTOR)
  // Without a locator, agent-device would read a locator's name as one.
  if (locator === 'any' && (DEVICE_FIND_LOCATORS as readonly string[]).includes(query)) {
    throw new DeviceArgsError(`"query" ${JSON.stringify(query)} needs a locator such as text`)
  }
  const action =
    input.action === undefined ? 'exists' : oneOf(input.action, 'action', DEVICE_FIND_ACTIONS)
  const found: Extract<DeviceAction, { type: 'find' }> = { type: 'find', locator, query, action }
  if (action === 'fill' || action === 'type') found.value = text(input.value, 'value')
  else if (input.value !== undefined) throw new DeviceArgsError('"value" is for fill and type')
  const first = flag(input.first, 'first')
  const last = flag(input.last, 'last')
  if (first && last) throw new DeviceArgsError('Give first or last, not both')
  if (input.pick !== undefined) found.pick = oneOf(input.pick, 'pick', ['first', 'last'] as const)
  else if (first) found.pick = 'first'
  else if (last) found.pick = 'last'
  if (input.timeoutMs !== undefined) {
    if (action !== 'wait') throw new DeviceArgsError('"timeoutMs" is for wait')
    found.timeoutMs = optionalNumber(input.timeoutMs, 'timeoutMs', 100, 60_000)
  }
  return found
}

/** An app is named by its bundle id or package, never a path or a flag. */
function appId(value: unknown): string {
  const app = text(value, 'app', MAX_NAME)
  if (!/^[A-Za-z0-9][\w.-]*$/.test(app))
    throw new DeviceArgsError('"app" must be a bundle id or package name')
  return app
}

/** What kind of device an id names, by the prefix the device host gives it. */
function deviceKindOf(deviceId: unknown): 'ios-simulator' | 'iphone' | 'android' | null {
  if (typeof deviceId !== 'string') return null
  if (deviceId.startsWith('ios-sim:')) return 'ios-simulator'
  if (deviceId.startsWith('ios:')) return 'iphone'
  if (deviceId.startsWith('android:') || deviceId.startsWith('avd:')) return 'android'
  return null
}

/** A video's file name without its extension: no path, no flag, no hidden file. */
function recordingName(value: unknown): string {
  const name = text(value, 'name', 96).replace(/\.mp4$/i, '')
  if (!/^[A-Za-z0-9][\w.-]{0,79}$/.test(name) || name.includes('..')) {
    throw new DeviceArgsError('"name" must be letters, digits, dots, dashes and underscores')
  }
  return name
}

/**
 * A .png by its path from the session's folder, written with forward slashes: never absolute,
 * from the home folder, up a level or through a drive or a device name.
 */
function folderPng(value: unknown, key: string): string {
  const given = text(value, key, MAX_TEXT).replace(/\\/g, '/')
  const parts = given.split('/')
  const fits =
    !given.startsWith('/') &&
    !given.startsWith('~') &&
    parts.every(
      (part) =>
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('-') &&
        /^[\p{L}\p{N}_. -]+$/u.test(part) &&
        part.trim() === part,
    ) &&
    /\.png$/i.test(given)
  if (!fits) {
    throw new DeviceArgsError(
      `"${key}" must be a .png by its path in this session's folder, such as screens/home.png`,
    )
  }
  return given
}

const PUSH_KEY = /^[A-Za-z0-9_.-]{1,128}$/
const ANDROID_ACTION = /^[A-Za-z][\w.]{0,199}$/
const ANDROID_COMPONENT = /^[A-Za-z][\w.]{0,199}\/[\w.$]{1,200}$/

/**
 * A test notification's payload, checked for the device it goes to: an APNs payload with an
 * `aps` object for an iOS simulator, an Android broadcast's action, receiver and extras.
 */
function pushPayload(value: unknown, deviceId: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeviceArgsError('"payload" must be a JSON object')
  }
  const payload = value as Record<string, unknown>
  let json: string
  try {
    json = JSON.stringify(payload)
  } catch {
    throw new DeviceArgsError('"payload" must be plain JSON')
  }
  if (new TextEncoder().encode(json).length > MAX_DEVICE_PUSH_BYTES) {
    throw new DeviceArgsError(`"payload" must be at most ${MAX_DEVICE_PUSH_BYTES} bytes as JSON`)
  }
  const kind = deviceKindOf(deviceId)
  if (kind === 'ios-simulator') {
    const aps = payload.aps
    if (typeof aps !== 'object' || aps === null || Array.isArray(aps)) {
      throw new DeviceArgsError(
        'An iOS payload needs an "aps" object, such as {"aps":{"alert":"Hi"}}',
      )
    }
    // A plain JSON value through and through: what JSON.stringify kept, read back.
    return JSON.parse(json) as Record<string, unknown>
  }
  if (kind !== 'android') {
    throw new DeviceArgsError('Test notifications go to iOS simulators and Android devices only')
  }
  only(payload, ['action', 'receiver', 'extras'], 'An Android payload')
  const checked: Record<string, unknown> = {}
  if (payload.action !== undefined) {
    const action = text(payload.action, 'action', 200)
    if (!ANDROID_ACTION.test(action)) throw new DeviceArgsError('"action" must be an intent action')
    checked.action = action
  }
  if (payload.receiver !== undefined) {
    const receiver = text(payload.receiver, 'receiver', 401)
    if (!ANDROID_COMPONENT.test(receiver)) {
      throw new DeviceArgsError('"receiver" must be a component such as com.example/.PushReceiver')
    }
    checked.receiver = receiver
  }
  if (payload.extras !== undefined) {
    const extras = payload.extras
    if (typeof extras !== 'object' || extras === null || Array.isArray(extras)) {
      throw new DeviceArgsError('"extras" must be an object')
    }
    const entries = Object.entries(extras as Record<string, unknown>)
    if (entries.length > 50) throw new DeviceArgsError('"extras" holds at most 50 values')
    const out: Record<string, string | number | boolean> = {}
    for (const [key, extra] of entries) {
      if (!PUSH_KEY.test(key)) throw new DeviceArgsError(`Extra "${key}" needs a plain key`)
      if (typeof extra === 'string') out[key] = extra === '' ? '' : text(extra, key, 1024)
      else if (typeof extra === 'boolean') out[key] = extra
      else if (typeof extra === 'number' && Number.isFinite(extra)) out[key] = extra
      else throw new DeviceArgsError(`Extra "${key}" must be a string, number or boolean`)
    }
    checked.extras = out
  }
  return checked
}

function permissionState(input: Record<string, unknown>): DevicePermissionState {
  // The form before reset, which a prompt written for it may still send.
  if (input.state === undefined && typeof input.grant === 'boolean') {
    return input.grant ? 'grant' : 'deny'
  }
  if (input.grant !== undefined) throw new DeviceArgsError('Give "state", not "grant"')
  return oneOf(input.state, 'state', DEVICE_PERMISSION_STATES)
}

/** The action a tool's checked arguments ask for; list, open and close are not actions. */
export function actionOf(
  tool: DeviceToolName,
  input: Record<string, unknown>,
): DeviceAction | null {
  switch (tool) {
    case 'device_snapshot':
      return { type: 'snapshot', ...level(input.level) }
    case 'device_tap': {
      const long = input.long === true
      if (typeof input.ref === 'string') {
        return { type: 'tap', ref: deviceRef(input.ref), long, ...level(input.level) }
      }
      return {
        type: 'tap',
        x: number(input.x, 'x', 0, 100_000),
        y: number(input.y, 'y', 0, 100_000),
        long,
        ...level(input.level),
      }
    }
    case 'device_fill':
      return {
        type: 'fill',
        ref: deviceRef(input.ref),
        text: text(input.text, 'text'),
        ...level(input.level),
      }
    case 'device_type':
      return { type: 'type', text: text(input.text, 'text') }
    case 'device_scroll':
      return {
        type: 'scroll',
        direction: oneOf(input.direction, 'direction', ['up', 'down', 'left', 'right']),
      }
    case 'device_swipe':
      return {
        type: 'swipe',
        from: {
          x: number(input.fromX, 'fromX', 0, 100_000),
          y: number(input.fromY, 'fromY', 0, 100_000),
        },
        to: { x: number(input.toX, 'toX', 0, 100_000), y: number(input.toY, 'toY', 0, 100_000) },
      }
    case 'device_press_button':
      return {
        type: 'button',
        button: oneOf(input.button, 'button', [
          'home',
          'back',
          'recents',
          'lock',
          'volumeUp',
          'volumeDown',
        ]),
      }
    case 'device_rotate':
      return {
        type: 'rotate',
        orientation: oneOf(input.orientation, 'orientation', [
          'portrait',
          'portrait_upside_down',
          'landscape_left',
          'landscape_right',
        ]),
      }
    case 'device_screenshot':
      return { type: 'screenshot' }
    case 'device_install_app': {
      const path = text(input.path, 'path')
      if (!/\.(app|ipa|apk)\/?$/i.test(path))
        throw new DeviceArgsError('"path" must be a .app, .ipa or .apk')
      return { type: 'install', path }
    }
    case 'device_launch_app':
      return { type: 'launch', app: appId(input.app) }
    case 'device_terminate_app':
      return { type: 'terminate', app: appId(input.app) }
    case 'device_open_url': {
      const url = text(input.url, 'url')
      // A scheme and something after it: a web address or an app's deep link, never a flag.
      if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(url)) throw new DeviceArgsError('"url" must be a URL')
      return { type: 'open_url', url }
    }
    case 'device_logs':
      return {
        type: 'logs',
        lines: input.lines === undefined ? 200 : number(input.lines, 'lines', 1, 2000),
        crashes: flag(input.crashes, 'crashes') ?? true,
      }
    case 'device_set_appearance':
      return { type: 'appearance', mode: oneOf(input.mode, 'mode', ['light', 'dark']) }
    case 'device_set_location':
      return {
        type: 'location',
        latitude: number(input.latitude, 'latitude', -90, 90),
        longitude: number(input.longitude, 'longitude', -180, 180),
      }
    case 'device_set_permission':
      return {
        type: 'permission',
        app: appId(input.app),
        permission: oneOf(input.permission, 'permission', DEVICE_PERMISSIONS),
        state: permissionState(input),
      }
    case 'device_record_start':
      return input.name === undefined
        ? { type: 'record_start' }
        : { type: 'record_start', name: recordingName(input.name) }
    case 'device_record_stop':
      return { type: 'record_stop' }
    case 'device_screenshot_compare': {
      const compare: Extract<DeviceAction, { type: 'screenshot_compare' }> = {
        type: 'screenshot_compare',
      }
      if (input.baseline !== undefined) compare.baseline = folderPng(input.baseline, 'baseline')
      if (input.threshold !== undefined) {
        compare.threshold = number(input.threshold, 'threshold', 0, 1)
      }
      if (flag(input.update, 'update')) {
        if (compare.baseline === undefined) throw new DeviceArgsError('"update" needs a baseline')
        compare.update = true
      }
      return compare
    }
    case 'device_network':
      return {
        type: 'network',
        limit: optionalNumber(input.limit, 'limit', 1, 100) ?? 20,
        include:
          input.include === undefined
            ? 'summary'
            : oneOf(input.include, 'include', DEVICE_NETWORK_INCLUDES),
      }
    case 'device_push': {
      const push: Extract<DeviceAction, { type: 'push' }> = {
        type: 'push',
        payload: pushPayload(input.payload, input.deviceId),
      }
      if (input.app !== undefined) push.app = appId(input.app)
      return push
    }
    case 'device_perf':
      return { type: 'perf' }
    case 'device_reset_app': {
      const keychain = flag(input.keychain, 'keychain') ?? false
      if (keychain && deviceKindOf(input.deviceId) !== 'ios-simulator') {
        throw new DeviceArgsError('"keychain" resets an iOS simulator’s keychain only')
      }
      return { type: 'reset_app', app: appId(input.app), keychain }
    }
    case 'device_wait': {
      const kinds = ['text', 'selector', 'absent', 'stable'].filter(
        (key) => input[key] !== undefined && input[key] !== false,
      )
      if (kinds.length !== 1) {
        throw new DeviceArgsError('Give one of "text", "selector", "absent" and "stable"')
      }
      const wait: Extract<DeviceAction, { type: 'wait' }> =
        input.text !== undefined
          ? { type: 'wait', until: 'text', value: text(input.text, 'text') }
          : input.selector !== undefined
            ? { type: 'wait', until: 'selector', value: selector(input.selector) }
            : input.absent !== undefined
              ? { type: 'wait', until: 'absent', value: selector(input.absent, 'absent') }
              : { type: 'wait', until: 'stable' }
      if (wait.until === 'stable') {
        if (input.stable !== true) throw new DeviceArgsError('"stable" must be true')
        const quiet = optionalNumber(input.quietMs, 'quietMs', 100, 10_000)
        if (quiet !== undefined) wait.quietMs = quiet
      } else if (input.quietMs !== undefined) {
        throw new DeviceArgsError('"quietMs" is for stable')
      }
      const timeout = optionalNumber(input.timeoutMs, 'timeoutMs', 100, 60_000)
      if (timeout !== undefined) wait.timeoutMs = timeout
      return wait
    }
    case 'device_find':
      return { ...findAction(input), ...level(input.level) }
    case 'device_is': {
      const predicate = oneOf(input.predicate, 'predicate', DEVICE_IS_PREDICATES)
      const checked: Extract<DeviceAction, { type: 'is' }> = {
        type: 'is',
        predicate,
        selector: selector(input.selector),
      }
      if (predicate === 'text') checked.value = text(input.value, 'value')
      else if (input.value !== undefined) throw new DeviceArgsError('"value" is for text')
      return checked
    }
    case 'device_get': {
      if ((input.ref === undefined) === (input.selector === undefined)) {
        throw new DeviceArgsError('Give "ref" or "selector"')
      }
      return {
        type: 'get',
        format: oneOf(input.format, 'format', ['text', 'attrs'] as const),
        target: input.ref !== undefined ? deviceRef(input.ref) : selector(input.selector),
        ...level(input.level),
      }
    }
    case 'device_alert': {
      const action =
        input.action === undefined ? 'get' : oneOf(input.action, 'action', DEVICE_ALERT_ACTIONS)
      const alert: Extract<DeviceAction, { type: 'alert' }> = { type: 'alert', action }
      if (input.timeoutMs !== undefined) {
        if (action !== 'wait' && action !== 'get') {
          throw new DeviceArgsError('"timeoutMs" is for wait and get')
        }
        alert.timeoutMs = optionalNumber(input.timeoutMs, 'timeoutMs', 100, 60_000)
      }
      return alert
    }
    case 'device_keyboard':
      return {
        type: 'keyboard',
        action:
          input.action === undefined
            ? 'status'
            : oneOf(input.action, 'action', DEVICE_KEYBOARD_ACTIONS),
      }
    case 'device_batch': {
      if (
        !Array.isArray(input.steps) ||
        input.steps.length === 0 ||
        input.steps.length > MAX_DEVICE_BATCH_STEPS
      ) {
        throw new DeviceArgsError(`"steps" must list 1 to ${MAX_DEVICE_BATCH_STEPS} steps`)
      }
      return {
        type: 'batch',
        steps: input.steps.map(batchStep),
        stopOnError: flag(input.stopOnError, 'stopOnError') ?? true,
        ...level(input.level),
      }
    }
    default:
      return null
  }
}

function failure(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  }
}

export class DeviceTools {
  /** The devices each session's user allowed for this session, by session. */
  private readonly allowed = new Map<string, Set<string>>()
  /** One question per session and device at a time. */
  private readonly asking = new Map<string, Promise<DeviceAccessAnswer>>()

  constructor(private readonly deps: DeviceToolDeps) {}

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isDeviceToolName(name)) throw new Error(`Unknown tool ${name}`)
    const sessionId = this.deps.sessionOf(caller.sessionId)
    const given = args(input)
    try {
      if (name === 'device_list')
        return this.answer(await this.forward({ kind: 'list', sessionId }))
      const deviceId = text(given.deviceId, 'deviceId', 256)
      if (name === 'device_close') {
        return this.answer(
          await this.forward({
            kind: 'close',
            sessionId,
            deviceId,
            shutdown: given.shutdown === true,
          }),
        )
      }
      const action = name === 'device_open' ? null : actionOf(name, given)
      const refused = await this.access(sessionId, deviceId, !action)
      if (refused) return refused
      const agentName = this.deps.agentName(sessionId)
      if (!action)
        return this.answer(await this.forward({ kind: 'open', sessionId, agentName, deviceId }))
      return this.answer(
        await this.forward({
          kind: 'action',
          sessionId,
          agentName,
          deviceId,
          action,
          projectPath: this.deps.projectOf(sessionId),
        }),
      )
    } catch (error) {
      if (error instanceof DeviceArgsError) return failure('invalid_params', error.message)
      throw error
    }
  }

  /** Forgets the user's allow for this session; a device always allowed stays so. */
  revoke(sessionId: string, deviceId: string): void {
    this.allowed.get(sessionId)?.delete(deviceId)
  }

  /**
   * Null when the session may use the device; otherwise the refusal to return. A simulator or
   * emulator the agent connects itself (`opening`) is its own; one the user connected to the
   * session, and every physical device, which holds the user's own things, needs their allow.
   */
  private async access(
    sessionId: string,
    deviceId: string,
    opening: boolean,
  ): Promise<CallToolResult | null> {
    if (this.deps.alwaysAllowed(deviceId) || this.allowed.get(sessionId)?.has(deviceId)) return null
    if (this.deps.shared?.(sessionId, deviceId)) return this.allow(sessionId, deviceId)
    const key = `${sessionId}\0${deviceId}`
    let asking = this.asking.get(key)
    if (!asking) {
      const listed = await this.forward({ kind: 'list', sessionId })
      const devices =
        'result' in listed
          ? ((listed.result.value as { devices?: DeviceInfo[] })?.devices ?? [])
          : []
      const device = devices.find((entry) => entry.id === deviceId)
      if (!device)
        return failure('not_found', 'No such device on this host. Call device_list for the ids.')
      if (opening && device.kind !== 'physical' && device.sessionId !== sessionId) {
        return this.allow(sessionId, deviceId)
      }
      if (this.deps.fullAccess?.(sessionId)) {
        this.deps.used?.(sessionId, device.name)
        return this.allow(sessionId, deviceId)
      }
      asking = this.deps.ask(sessionId, deviceId, device.name)
      this.asking.set(key, asking)
      void asking.finally(() => this.asking.delete(key))
    }
    const answer = await asking
    if (answer === 'always') this.deps.allowAlways(deviceId)
    if (answer === 'session' || answer === 'always') return this.allow(sessionId, deviceId)
    return failure(
      'not_allowed',
      answer === 'timeout'
        ? 'The user did not answer in time, so the device was not used.'
        : 'The user did not allow this session to use the device.',
    )
  }

  private allow(sessionId: string, deviceId: string): null {
    let set = this.allowed.get(sessionId)
    if (!set) this.allowed.set(sessionId, (set = new Set()))
    set.add(deviceId)
    return null
  }

  private forward(call: DeviceCall): Promise<DeviceCallAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: { code: 'failed', message: 'The device did not answer in time.' } }),
        DEVICE_CALL_TIMEOUT_MS + 5_000,
      )
      void this.deps.call(call).then((answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
    })
  }

  private answer(answer: DeviceCallAnswer): CallToolResult {
    if ('error' in answer) return failure(answer.error.code, answer.error.message)
    const { text, image, structured, file } = answer.result
    const content: CallToolResult['content'] = [{ type: 'text', text }]
    if (image) content.push({ type: 'image', data: image, mimeType: 'image/png' })
    if (file) {
      const name = file.path.split(/[\\/]/).pop() ?? file.path
      content.push({
        type: 'resource_link',
        uri: pathToFileURL(file.path).href,
        name,
        mimeType: file.mimeType,
      })
    }
    return structured ? { content, structuredContent: structured } : { content }
  }
}

export { DEVICE_ACCESS_WAIT_MS }

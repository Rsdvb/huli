// Agents' device tools: their names, the actions the device host carries out for them, and the
// messages that carry a call from the agent host to the device host and back.

import type { DeviceButton, DeviceOrientation } from './device-host'

export const DEVICE_TOOL_NAMES = [
  'device_list',
  'device_open',
  'device_close',
  'device_snapshot',
  'device_tap',
  'device_fill',
  'device_type',
  'device_scroll',
  'device_swipe',
  'device_press_button',
  'device_rotate',
  'device_screenshot',
  'device_install_app',
  'device_launch_app',
  'device_terminate_app',
  'device_open_url',
  'device_logs',
  'device_set_appearance',
  'device_set_location',
  'device_set_permission',
  'device_wait',
  'device_find',
  'device_is',
  'device_get',
  'device_alert',
  'device_keyboard',
  'device_batch',
  'device_record_start',
  'device_record_stop',
  'device_screenshot_compare',
  'device_network',
  'device_push',
  'device_perf',
  'device_reset_app',
] as const

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number]

/** How `device_find` matches: by any of its words, or by one kind. */
export const DEVICE_FIND_LOCATORS = ['any', 'text', 'label', 'value', 'role', 'id'] as const
export type DeviceFindLocator = (typeof DEVICE_FIND_LOCATORS)[number]
/** What `device_find` does with the match; `exists` only checks. */
export const DEVICE_FIND_ACTIONS = [
  'exists',
  'click',
  'focus',
  'list',
  'getText',
  'getAttrs',
  'wait',
  'fill',
  'type',
] as const
export type DeviceFindAction = (typeof DEVICE_FIND_ACTIONS)[number]
/** What `device_is` checks of the element a selector names. */
export const DEVICE_IS_PREDICATES = [
  'visible',
  'hidden',
  'exists',
  'absent',
  'editable',
  'selected',
  'checked',
  'focused',
  'text',
] as const
export type DeviceIsPredicate = (typeof DEVICE_IS_PREDICATES)[number]
export const DEVICE_ALERT_ACTIONS = ['get', 'accept', 'dismiss', 'wait'] as const
export type DeviceAlertAction = (typeof DEVICE_ALERT_ACTIONS)[number]
export const DEVICE_KEYBOARD_ACTIONS = ['status', 'dismiss', 'enter'] as const
export type DeviceKeyboardAction = (typeof DEVICE_KEYBOARD_ACTIONS)[number]
/** The agent-device commands a `device_batch` step may run. */
export const DEVICE_BATCH_COMMANDS = [
  'snapshot',
  'press',
  'longpress',
  'fill',
  'type',
  'scroll',
  'back',
  'home',
  'wait',
  'is',
  'get',
  'find',
  'alert',
  'keyboard',
] as const
export type DeviceBatchCommand = (typeof DEVICE_BATCH_COMMANDS)[number]
export const MAX_DEVICE_BATCH_STEPS = 20

/** The permissions `device_set_permission` changes, as agent-device names them. */
export const DEVICE_PERMISSIONS = [
  'all',
  'camera',
  'microphone',
  'photos',
  'contacts',
  'notifications',
  'calendar',
  'location',
  'location-always',
  'media-library',
  'motion',
  'reminders',
] as const
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number]
export const DEVICE_PERMISSION_STATES = ['grant', 'deny', 'reset'] as const
export type DevicePermissionState = (typeof DEVICE_PERMISSION_STATES)[number]
/** How much of each request `device_network` reads. */
export const DEVICE_NETWORK_INCLUDES = ['summary', 'headers', 'body'] as const
export type DeviceNetworkInclude = (typeof DEVICE_NETWORK_INCLUDES)[number]
/** The longest a recording runs before the device host stops it itself. */
export const MAX_DEVICE_RECORDING_MS = 180_000
/** APNs' own limit on a notification's payload, which Android's broadcast is held to as well. */
export const MAX_DEVICE_PUSH_BYTES = 4096
/** Where in a session's folder the device tools keep what they capture, ignored by git. */
export const DEVICE_CAPTURES_FOLDER = '.kite/device'

/** One step of a batch, its input as agent-device's structured input names it. */
export interface DeviceBatchStep {
  command: DeviceBatchCommand
  input: Record<string, string | number | boolean>
}

/** `digest` asks agent-device for its compact answer, which costs fewer tokens. */
export type DeviceLevel = 'digest'

export type DeviceAction =
  | { type: 'snapshot'; level?: DeviceLevel }
  | { type: 'tap'; ref: string; long?: boolean; level?: DeviceLevel }
  | { type: 'tap'; x: number; y: number; long?: boolean; level?: DeviceLevel }
  | { type: 'fill'; ref: string; text: string; level?: DeviceLevel }
  | { type: 'type'; text: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'button'; button: Exclude<DeviceButton, 'rotate'> }
  | { type: 'rotate'; orientation: DeviceOrientation }
  | { type: 'screenshot' }
  | { type: 'install'; path: string }
  | { type: 'launch'; app: string }
  | { type: 'terminate'; app: string }
  | { type: 'open_url'; url: string }
  /** `crashes` adds the app's crash reports since it started. */
  | { type: 'logs'; lines: number; crashes: boolean }
  | { type: 'appearance'; mode: 'light' | 'dark' }
  | { type: 'location'; latitude: number; longitude: number }
  | {
      type: 'permission'
      app: string
      permission: DevicePermission
      state: DevicePermissionState
    }
  | {
      type: 'wait'
      /** What it waits for: text that shows, a selector's element, its going, or a still screen. */
      until: 'text' | 'selector' | 'absent' | 'stable'
      value?: string
      timeoutMs?: number
      quietMs?: number
    }
  | {
      type: 'find'
      locator: DeviceFindLocator
      query: string
      action: DeviceFindAction
      value?: string
      pick?: 'first' | 'last'
      timeoutMs?: number
      level?: DeviceLevel
    }
  | { type: 'is'; predicate: DeviceIsPredicate; selector: string; value?: string }
  /** `target` is a ref such as @e3 or a selector. */
  | { type: 'get'; format: 'text' | 'attrs'; target: string; level?: DeviceLevel }
  | { type: 'alert'; action: DeviceAlertAction; timeoutMs?: number }
  | { type: 'keyboard'; action: DeviceKeyboardAction }
  | { type: 'batch'; steps: DeviceBatchStep[]; stopOnError: boolean; level?: DeviceLevel }
  /** `name` is the video's file name among the session folder's recordings, without `.mp4`. */
  | { type: 'record_start'; name?: string }
  | { type: 'record_stop' }
  | {
      type: 'screenshot_compare'
      /** A .png by its path in the session's folder; without one, the previous shot. */
      baseline?: string
      /** agent-device's per-pixel color tolerance, from 0 (exact colors) to 1. */
      threshold?: number
      /** Keeps the new shot as the baseline once compared. */
      update?: boolean
    }
  | { type: 'network'; limit: number; include: DeviceNetworkInclude }
  /** `payload` is checked for the device's platform; without `app`, the session's app. */
  | { type: 'push'; app?: string; payload: Record<string, unknown> }
  | { type: 'perf' }
  /** `keychain` also resets the whole keychain of an iOS simulator. */
  | { type: 'reset_app'; app: string; keychain: boolean }

export interface DeviceActionResult {
  text: string
  /** A PNG in base64, for a screenshot. */
  image?: string
  /** What the text says, as data, for the diagnostics tools. */
  structured?: Record<string, unknown>
  /** A file the action wrote into the session's folder, for the thread to show. */
  file?: { path: string; mimeType: string }
}

/** What the agent host asks of the device host for one tool call. */
export type DeviceCall =
  | { kind: 'list'; sessionId: string }
  | { kind: 'open'; sessionId: string; agentName: string; deviceId: string }
  | { kind: 'close'; sessionId: string; deviceId: string; shutdown: boolean }
  | {
      kind: 'action'
      sessionId: string
      agentName: string
      deviceId: string
      action: DeviceAction
      /** The agent's own folder, where relative app paths are resolved. */
      projectPath: string | null
    }

export type DeviceCallAnswer =
  | { result: DeviceActionResult & { value?: unknown } }
  | { error: { code: DeviceCallErrorCode; message: string; data?: unknown } }

export type DeviceCallErrorCode =
  | 'invalid_params'
  | 'not_found'
  | 'busy'
  | 'not_open'
  | 'user_has_control'
  | 'stopped'
  | 'unavailable'
  | 'failed'

export type DeviceAccessDecision = 'session' | 'always' | 'deny'
export type DeviceAccessAnswer = DeviceAccessDecision | 'timeout'

/** Seconds an agent's device call may run before it fails, long enough for an app's first build. */
export const DEVICE_CALL_TIMEOUT_MS = 240_000
/** How long the user has to answer a device access request. */
export const DEVICE_ACCESS_WAIT_MS = 120_000

// What a page logs, as the console tool returns it: console calls, the browser's own messages, and
// the errors nothing caught, thrown or rejected, each with where it came from.

import type { BrowserConsoleLevel } from '@shared/browser'

/** The longest message text kept. */
export const MAX_CONSOLE_TEXT = 4_000
/** The calls of a stack the tool returns. */
export const MAX_STACK_FRAMES = 10

export type ConsoleLevel = BrowserConsoleLevel

export interface ConsoleEntry {
  level: string
  text: string
  url: string
  line: number
  /** Where it was thrown or logged, the innermost call first; empty when the page gave none. */
  stack: string[]
}

interface CallFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  preview?: {
    overflow?: boolean
    properties?: { name: string; type?: string; value?: string }[]
  }
}

/** A console message's level, in Chrome's words. */
export function consoleLevel(type: unknown): string {
  switch (type) {
    case 'warning':
      return 'warn'
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'endGroup':
    case 'debug':
    case 'verbose':
      return 'debug'
    case 'error':
    case 'assert':
      return 'error'
    case 'info':
      return 'info'
    default:
      return 'log'
  }
}

const RANK: Record<string, number> = { error: 0, warn: 1, info: 2, log: 2, debug: 3 }

/** Whether a message at `level` shows when the tool is asked for `wanted` and more severe. */
export function shownAt(level: string, wanted: ConsoleLevel): boolean {
  if (wanted === 'all') return true
  return (RANK[level] ?? 2) <= RANK[wanted]!
}

function clip(text: string): string {
  return text.length > MAX_CONSOLE_TEXT ? `${text.slice(0, MAX_CONSOLE_TEXT)}…` : text
}

/** A stack's calls as V8 writes them, such as `render (http://localhost:5173/app.js:12:5)`. */
export function stackLines(frames: readonly CallFrame[] | undefined): string[] {
  return (frames ?? []).slice(0, MAX_STACK_FRAMES).map((frame) => {
    const where = `${frame.url || '<anonymous>'}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`
    return frame.functionName ? `${frame.functionName} (${where})` : where
  })
}

function argumentText(argument: RemoteObject): string {
  const value = argument.value
  if (value !== undefined) return typeof value === 'string' ? value : JSON.stringify(value)
  if (argument.unserializableValue !== undefined) return String(argument.unserializableValue)
  // An object logged by reference shows its first properties, as the console does.
  const preview = argument.preview
  if (argument.type === 'object' && argument.subtype !== 'error' && preview?.properties) {
    const array = argument.subtype === 'array'
    const items = preview.properties.map(({ name, type, value: shown }) => {
      const text = type === 'string' ? JSON.stringify(shown ?? '') : String(shown ?? type ?? '')
      return array ? text : `${name}: ${text}`
    })
    if (preview.overflow) items.push('…')
    return array ? `[${items.join(', ')}]` : `{${items.join(', ')}}`
  }
  if (argument.description !== undefined) return String(argument.description)
  return String(argument.type ?? '')
}

/** `Runtime.consoleAPICalled`: a console call; an error or a warning keeps its stack. */
export function consoleCall(params: Record<string, unknown>): ConsoleEntry {
  const args = Array.isArray(params.args) ? (params.args as RemoteObject[]) : []
  const frames = (params.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames
  const frame = frames?.[0]
  const level = consoleLevel(params.type)
  return {
    level,
    text: clip(args.map(argumentText).join(' ')),
    url: String(frame?.url ?? ''),
    line: (frame?.lineNumber ?? 0) + 1,
    stack: level === 'error' || level === 'warn' ? stackLines(frames) : [],
  }
}

/** `Log.entryAdded`: a message of the browser's own, such as a failed load. */
export function logEntry(params: Record<string, unknown>): ConsoleEntry {
  const entry = (params.entry ?? {}) as Record<string, unknown>
  const frames = (entry.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames
  return {
    level: entry.level === 'warning' ? 'warn' : String(entry.level ?? 'info'),
    text: clip(String(entry.text ?? '')),
    url: String(entry.url ?? ''),
    line: Number(entry.lineNumber ?? 0) + 1,
    stack: stackLines(frames),
  }
}

/**
 * `Runtime.exceptionThrown`: an error nothing caught, such as "Uncaught TypeError: x is not a
 * function" or "Uncaught (in promise) Error: failed", with the stack it was thrown at.
 */
export function exceptionEntry(params: Record<string, unknown>): ConsoleEntry {
  const details = (params.exceptionDetails ?? {}) as {
    text?: string
    url?: string
    lineNumber?: number
    exception?: RemoteObject
    stackTrace?: { callFrames?: CallFrame[] }
  }
  const exception = details.exception
  // An Error's description is its message and then its stack; a thrown value has no stack.
  const described = exception
    ? exception.description !== undefined && exception.type === 'object'
      ? exception.description
      : argumentText(exception)
    : ''
  const [what = '', ...rest] = described.split('\n')
  const prefix = (details.text ?? 'Uncaught').trim()
  const text = what === '' || prefix.includes(what) ? prefix : `${prefix} ${what}`
  let stack = stackLines(details.stackTrace?.callFrames)
  if (stack.length === 0) {
    stack = rest
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .map((line) => line.slice(3))
      .slice(0, MAX_STACK_FRAMES)
  }
  const top = details.stackTrace?.callFrames?.[0]
  return {
    level: 'error',
    text: clip(text),
    url: String(details.url ?? top?.url ?? ''),
    line: (details.lineNumber ?? top?.lineNumber ?? 0) + 1,
    stack,
  }
}

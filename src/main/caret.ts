// Huli: how the system blinks a text caret and when it stops, read once per run in child
// processes, never on the main thread: Windows' CursorBlinkRate and CaretTimeout, macOS's insertion
// point periods, GNOME's cursor-blink keys. The page holds a caret still after that long without
// typing, as Windows does with its own carets, so a focused field left alone draws nothing.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { CaretBlink } from '@shared/ipc'

const TIMEOUT_MS = 5_000

/** Windows' own defaults: a 530 ms half blink, still after 5 s. */
const WINDOWS_HALF_MS = 530
const WINDOWS_HOLD_MS = 5_000
/** macOS has no such timeout; a laptop's battery is reason enough to stop after 5 s. */
const MAC_HOLD_MS = 5_000
/** GNOME's defaults: a 1.2 s blink, still after 10 s. */
const GNOME_PERIOD_MS = 1_200
const GNOME_HOLD_S = 10

function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    )
  })
}

/** A positive whole number of milliseconds, or null. */
function millis(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** A value of `reg query`'s output: a string's text or a DWORD's number. */
function regValue(text: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}\\s+(REG_SZ|REG_DWORD)\\s+(\\S+)`, 'im').exec(text)
  if (!match) return null
  return match[1] === 'REG_DWORD' ? String(Number.parseInt(match[2]!, 16)) : match[2]!
}

/** From `reg query "HKCU\Control Panel\Desktop"`. A blink rate of -1 means no blinking. */
export function parseWindowsCaret(text: string): CaretBlink {
  const rate = regValue(text, 'CursorBlinkRate')
  const timeout = regValue(text, 'CaretTimeout')
  if (rate !== null && Number(rate) < 0) return { blinks: false, periodMs: null, holdAfterMs: null }
  const half = rate === null ? WINDOWS_HALF_MS : (millis(Number(rate)) ?? WINDOWS_HALF_MS)
  return {
    blinks: true,
    periodMs: half * 2,
    holdAfterMs: timeout === null ? WINDOWS_HOLD_MS : millis(Number(timeout)),
  }
}

/** From `defaults read -g` of each period, empty when it is not set. */
export function parseMacCaret(on: string, off: string): CaretBlink {
  const shown = millis(Number.parseFloat(on))
  const hidden = millis(Number.parseFloat(off))
  return {
    blinks: true,
    periodMs: shown !== null && hidden !== null ? shown + hidden : null,
    holdAfterMs: MAC_HOLD_MS,
  }
}

/** From `gsettings get` of cursor-blink, cursor-blink-time and cursor-blink-timeout. */
export function parseGnomeCaret(blink: string, time: string, timeout: string): CaretBlink {
  if (blink.trim() === 'false') return { blinks: false, periodMs: null, holdAfterMs: null }
  const number = (text: string): number => Number(text.trim().split(/\s+/).pop())
  const seconds = timeout.trim() ? number(timeout) : GNOME_HOLD_S
  return {
    blinks: true,
    periodMs: millis(number(time)) ?? GNOME_PERIOD_MS,
    holdAfterMs: millis(seconds * 1000),
  }
}

async function readCaret(): Promise<CaretBlink> {
  if (process.platform === 'win32') {
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    return parseWindowsCaret(await output(reg, ['query', 'HKCU\\Control Panel\\Desktop']))
  }
  if (process.platform === 'darwin') {
    const read = (key: string): Promise<string> => output('/usr/bin/defaults', ['read', '-g', key])
    const [on, off] = await Promise.all([
      read('NSTextInsertionPointBlinkPeriodOn'),
      read('NSTextInsertionPointBlinkPeriodOff'),
    ])
    return parseMacCaret(on, off)
  }
  const read = (key: string): Promise<string> =>
    output('gsettings', ['get', 'org.gnome.desktop.interface', key])
  const [blink, time, timeout] = await Promise.all([
    read('cursor-blink'),
    read('cursor-blink-time'),
    read('cursor-blink-timeout'),
  ])
  return parseGnomeCaret(blink, time, timeout)
}

let forRun: Promise<CaretBlink> | null = null

/** The system's caret blink, read the first time it is asked for. */
export function caretBlinkForRun(): Promise<CaretBlink> {
  forRun ??= readCaret()
  return forRun
}

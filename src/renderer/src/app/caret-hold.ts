/**
 * Huli: a text caret holds still once the system's time passes without typing, as Windows' own
 * carets do after CaretTimeout, so a focused field left alone draws nothing. Blinking, it drew a
 * frame at each blink, in the renderer and again in the GPU process. Typing, focusing or clicking
 * makes it blink again. A native caret, the composer's included, holds through
 * `caret-animation: manual`; CodeMirror's drawn cursor, in an editor with drawSelection, through its
 * layer's animation (globals.css). Each focus, key or click sets one timeout; nothing runs while the
 * field is left alone.
 */

import type { CaretBlink } from '@shared/ipc'

let asked = false
let blink: CaretBlink | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let held: HTMLElement | null = null

const editable = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable)

function hold(): void {
  timer = null
  const focused = document.activeElement
  if (!editable(focused)) return
  // CodeMirror draws its cursor beside the content, so its whole editor holds.
  held = focused.closest<HTMLElement>('.cm-editor') ?? focused
  held.dataset.caretHeld = ''
}

function stir(): void {
  if (!blink?.blinks || blink.holdAfterMs === null) return
  if (timer !== null) clearTimeout(timer)
  if (held) {
    delete held.dataset.caretHeld
    held = null
  }
  timer = setTimeout(hold, blink.holdAfterMs)
}

/** The system's whole blink in milliseconds, 0 when carets do not blink; null until read. */
export function caretPeriod(): number | null {
  if (!blink) return null
  return blink.blinks ? blink.periodMs : 0
}

/** Starts following the system's caret blink; the first call is the one that counts. */
export function followCaretHold(): void {
  if (asked) return
  asked = true
  void window.kettu.app.caretBlink().then(
    (value) => {
      blink = value
      for (const type of ['focusin', 'keydown', 'beforeinput', 'pointerdown'])
        document.addEventListener(type, stir, { capture: true, passive: true })
      window.addEventListener('focus', stir)
      stir()
    },
    () => {},
  )
}

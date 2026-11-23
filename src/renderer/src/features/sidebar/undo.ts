// Huli: Undo for what takes sessions out of the list (归档、收起、稍后提醒): a toast offers it for
// five seconds, and Mod+Z runs the latest one while that toast shows, unless the key belongs to a
// text field with text to undo.

import type { IconSvgElement } from '@hugeicons/react'
import { dismissToast, toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'

/** How long Undo is offered. */
export const UNDO_MS = 5_000

interface Offer {
  run(): void
  until: number
  toast: ReturnType<typeof toast>
}

let latest: Offer | null = null

/** Shows `title` with Undo for five seconds; Mod+Z runs it too, while the toast shows. */
export function undoToast(title: string, undo: () => void, icon?: IconSvgElement): void {
  const offer: Offer = { run: () => {}, until: Date.now() + UNDO_MS, toast: '' }
  offer.run = () => {
    if (latest === offer) latest = null
    undo()
  }
  latest = offer
  offer.toast = toast(
    title,
    { label: i18n.t('sidebar:row.undo'), onClick: () => offer.run() },
    { ...(icon ? { icon } : {}), duration: UNDO_MS },
  )
}

/** Runs the latest Undo while its toast shows, and closes that toast; false when none shows. */
export function undoLatest(): boolean {
  const offer = latest
  latest = null
  if (!offer || offer.until < Date.now()) return false
  dismissToast(offer.toast)
  offer.run()
  return true
}

/** Whether an Undo is on offer now, so Mod+Z goes to it. */
export function undoOffered(): boolean {
  return latest !== null && latest.until >= Date.now()
}

/**
 * Whether Mod+Z at `target` is the field's own undo: a text field or editor holding text. An
 * empty one, as the composer after a send, leaves the key to the latest Undo.
 */
export function ownUndo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value !== ''
  }
  const editable = target.closest<HTMLElement>('[contenteditable="true"], .cm-content')
  return !!editable && (editable.textContent ?? '') !== ''
}

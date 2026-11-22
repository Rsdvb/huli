// Huli: turning the browser pane's pick mode on and off; main runs it on the page (main/browser/pick).

import type { PickColor } from '@shared/page-notes'
import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { useBrowserStore } from '@renderer/stores/browser'

/** The outline's color: the theme's accent for comments, as the page draws it. */
function outlineColor(): PickColor {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  const value = getComputedStyle(document.documentElement).getPropertyValue('--pane-fox').trim()
  if (!context || !value) return { r: 0, g: 0, b: 0 }
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return { r, g, b }
}

/** Turns pick mode on, or back on after a comment; says so when the page cannot take it. */
export async function startPicking(sessionId: string): Promise<void> {
  const store = useBrowserStore.getState()
  store.setPicking(sessionId, true)
  const on = await window.kettu.browser.pick(sessionId, true, outlineColor()).catch(() => false)
  if (on || !useBrowserStore.getState().picking[sessionId]) return
  useBrowserStore.getState().setPicking(sessionId, false)
  toast(i18n.t('browser:pick.unavailable'), undefined, { tone: 'warning' })
}

export function stopPicking(sessionId: string): void {
  const store = useBrowserStore.getState()
  if (!store.picking[sessionId] && !store.picked[sessionId]) return
  store.setPicking(sessionId, false)
  store.setPicked(sessionId, null)
  void window.kettu.browser.pick(sessionId, false, null).catch(() => {})
}

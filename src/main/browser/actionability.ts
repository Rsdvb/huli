// Whether an element can take an action yet, as Playwright checks before it acts: on the page,
// visible, enabled, editable for typing, and for a click inside the window with nothing over its
// centre. A check that fails is tried again for a few seconds, since pages often get there a
// moment later; one that cannot pass, such as a removed element, fails at once.
// After Playwright's actionability checks (Copyright (c) Microsoft Corporation, Apache-2.0):
// https://playwright.dev/docs/actionability

/** How long an action waits for its element. */
export const AUTO_WAIT_MS = 5_000

/** The pauses between checks, the last one repeating. */
const PAUSES = [0, 20, 50, 100, 100, 250, 500]

export type ActionKind = 'click' | 'type' | 'select'

/** What the page says of an element, from PROBE. */
export interface Probe {
  connected: boolean
  visible: boolean
  enabled: boolean
  /** False for a field that is read-only. */
  editable: boolean
  /** Its centre is inside the window. */
  inside: boolean
  /** What covers its centre, such as `div#overlay "Loading…"`; null when nothing does. */
  covered: string | null
  /** Its centre in the window, for the click. */
  x: number
  y: number
}

export interface Problem {
  code: 'stale_ref' | 'invalid'
  /** Says what is wrong, after the element's name. */
  message: string
  /** What the agent can do about it once the wait is over. */
  hint: string
  /** Whether waiting may fix it. */
  retry: boolean
}

/** The pause before check number `attempt`, from 0. */
export function pauseBefore(attempt: number): number {
  return PAUSES[Math.min(attempt, PAUSES.length - 1)]!
}

/** Why an element cannot take the action now, or null when it can. */
export function actionProblem(probe: Probe, action: ActionKind): Problem | null {
  if (!probe.connected) {
    return {
      code: 'stale_ref',
      message: 'is no longer on the page.',
      hint: 'Take a new snapshot.',
      retry: false,
    }
  }
  if (!probe.visible) {
    return {
      code: 'invalid',
      message: 'is not visible.',
      hint: 'Open what holds it, or take a new snapshot.',
      retry: true,
    }
  }
  if (!probe.enabled) {
    return {
      code: 'invalid',
      message: 'is disabled.',
      hint: 'Check what the page needs before it enables it.',
      retry: true,
    }
  }
  if (action === 'type' && !probe.editable) {
    return {
      code: 'invalid',
      message: 'is read-only.',
      hint: 'Type into another field.',
      retry: true,
    }
  }
  if (action !== 'click') return null
  if (!probe.inside) {
    return {
      code: 'invalid',
      message: 'is outside the visible part of the page.',
      hint: 'Scroll it into view, then try again.',
      retry: true,
    }
  }
  if (probe.covered !== null) {
    return {
      code: 'invalid',
      message: `has its centre covered by ${probe.covered}.`,
      hint: 'Close or scroll away what covers it, then try again.',
      retry: true,
    }
  }
  return null
}

/** What a failed wait tells the agent. */
export function waitedFailure(name: string, problem: Problem, waited: boolean): string {
  const after = waited && problem.retry ? ` It still was after ${AUTO_WAIT_MS / 1000} s.` : ''
  return `${name} ${problem.message}${after} ${problem.hint}`
}

/**
 * Runs in the page with the element as `this` and the action as its argument, and answers a
 * Probe. The centre is in the top window, through the frames that hold the element.
 */
export const PROBE = `function (action) {
  const el = this
  const probe = { connected: !!el.isConnected, visible: false, enabled: true, editable: true, inside: false, covered: null, x: 0, y: 0 }
  if (!probe.connected || el.nodeType !== 1) return probe
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  probe.visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
    (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }))
  let disabled = typeof el.matches === 'function' && el.matches(':disabled')
  for (let node = el; node && !disabled; node = node.parentElement) {
    if (node.getAttribute('aria-disabled') === 'true') disabled = true
  }
  probe.enabled = !disabled
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') probe.editable = !el.readOnly
  else if (el.getAttribute('aria-readonly') === 'true') probe.editable = false
  const localX = rect.x + rect.width / 2
  const localY = rect.y + rect.height / 2
  let x = localX
  let y = localY
  let view = window
  for (let depth = 0; depth < 8 && view !== window.top; depth++) {
    const frame = view.frameElement
    if (!frame) break
    const box = frame.getBoundingClientRect()
    x += box.x
    y += box.y
    view = frame.ownerDocument.defaultView
  }
  probe.x = x
  probe.y = y
  let width = window.innerWidth
  let height = window.innerHeight
  try {
    width = window.top.innerWidth
    height = window.top.innerHeight
  } catch (error) {}
  probe.inside = x >= 0 && y >= 0 && x <= width && y <= height
  if (action !== 'click' || !probe.visible) return probe
  const root = el.getRootNode()
  const at = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(localX, localY)
  if (at && at !== el && !el.contains(at)) {
    const label = typeof at.closest === 'function' ? at.closest('label') : null
    const labels = (label && label.control === el) || (el.tagName === 'LABEL' && el.control === at)
    if (!labels) {
      const name = at.tagName ? at.tagName.toLowerCase() : 'element'
      const id = at.id ? '#' + at.id : ''
      const text = (at.innerText || at.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
      probe.covered = text ? name + id + ' "' + text + '"' : name + id
    }
  }
  return probe
}`

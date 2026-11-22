// The browser pane's pick mode: the page's own DevTools inspect overlay outlines the element under
// the pointer with its tag and classes, and a click there names it to the pane. Nothing is put in
// the page: Chromium draws the overlay in a layer of its own, which the page's styles never reach
// and its scripts never see, and it goes when the mode ends. The element's place, text and box are
// read in an isolated world; one screenshot of the page is the pane's still and its picture.

import type { WebContents } from 'electron'
import {
  SELECTOR_ATTRIBUTES,
  elementLabel,
  elementText,
  parseElementPath,
  selectorCandidates,
  type ElementPick,
  type PageBox,
  type PickColor,
  type PickEvent,
} from '@shared/page-notes'

const isChannel = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255

/** The color a pane names for the outline, or null when it is none. */
export function parsePickColor(value: unknown): PickColor | null {
  if (typeof value !== 'object' || value === null) return null
  const { r, g, b } = value as Record<string, unknown>
  return isChannel(r) && isChannel(g) && isChannel(b) ? { r, g, b } : null
}

/** The overlay's look: the box filled lightly, its border strong, the label with tag and size. */
export function highlightConfig(color: PickColor): Record<string, unknown> {
  const { r, g, b } = color
  return {
    showInfo: true,
    showStyles: false,
    showRulers: false,
    showAccessibilityInfo: false,
    showExtensionLines: false,
    contentColor: { r, g, b, a: 0.16 },
    paddingColor: { r, g, b, a: 0.1 },
    borderColor: { r, g, b, a: 0.75 },
    marginColor: { r, g, b, a: 0.05 },
  }
}

/** How long reading a picked element may take before the pick is given up. */
const READ_MS = 5_000
const GROUP = 'kite-pick'
const WORLD = 'kite-pick'

/**
 * Reads, in the page, the element's path up to its root, its text, its box in the top page's
 * viewport and whether it sits in a shadow root. A string, so the bundler never rewrites it.
 */
const READ_ELEMENT = `function (wanted) {
  const el = this
  const path = []
  for (let node = el; node && node.nodeType === 1 && path.length < 32; ) {
    const parent = node.parentNode
    const siblings = parent && parent.children ? Array.from(parent.children) : [node]
    const same = siblings.filter((s) => s.localName === node.localName)
    const attrs = {}
    for (const name of wanted) {
      const value = node.getAttribute(name)
      if (value !== null) attrs[name] = value.slice(0, 81)
    }
    path.push({
      tag: node.localName,
      id: node.id || null,
      classes: Array.from(node.classList || []).slice(0, 8),
      attrs,
      nth: Math.max(1, same.indexOf(node) + 1),
      ofType: Math.max(1, same.length),
    })
    node = parent && parent.nodeType === 1 ? parent : null
  }
  const tag = el.localName
  const type = (el.getAttribute('type') || '').toLowerCase()
  const button = tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')
  // A field's value may be a secret; its label and placeholder say what it is.
  const text =
    (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText || el.textContent || '').trim() ||
    (button ? el.value : '') ||
    el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || ''
  const rect = el.getBoundingClientRect()
  let x = rect.left
  let y = rect.top
  let view = el.ownerDocument.defaultView
  try {
    while (view && view !== view.top && view.frameElement) {
      const frame = view.frameElement.getBoundingClientRect()
      x += frame.left + view.frameElement.clientLeft
      y += frame.top + view.frameElement.clientTop
      view = view.parent
    }
  } catch (error) {}
  const root = el.getRootNode()
  const host = root && root.host ? root.host : null
  return {
    path,
    text: String(text).slice(0, 2000),
    box: { x, y, width: rect.width, height: rect.height },
    host: host ? { tag: host.localName, id: host.id || null, classes: Array.from(host.classList || []).slice(0, 8), attrs: {}, nth: 1, ofType: 1 } : null,
    title: el.ownerDocument.title || null,
  }
}`

/** The first selector of those given that matches the element alone in its root. */
const FIRST_UNIQUE = `function (candidates) {
  const root = this.getRootNode()
  for (const candidate of candidates) {
    try {
      const found = root.querySelectorAll(candidate)
      if (found.length === 1 && found[0] === this) return candidate
    } catch (error) {}
  }
  return null
}`

interface RemoteObject {
  objectId?: string
}

interface ReadResult {
  path: unknown
  text: unknown
  box: unknown
  host: unknown
  title: unknown
}

function send<T>(contents: WebContents, method: string, params?: object): Promise<T> {
  return contents.debugger.sendCommand(method, params) as Promise<T>
}

/** Starts the overlay's inspect mode on the page; false when its debugger could not. */
export async function beginInspect(contents: WebContents, color: PickColor): Promise<boolean> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return false
  try {
    await send(contents, 'DOM.enable')
    await send(contents, 'Overlay.enable')
    await send(contents, 'Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: highlightConfig(color),
    })
    return true
  } catch {
    return false
  }
}

/** Ends inspect mode and takes the overlay off; `keep` leaves the domain on for a resume. */
export async function endInspect(contents: WebContents, keep = false): Promise<void> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return
  await send(contents, 'Overlay.setInspectMode', {
    mode: 'none',
    highlightConfig: {},
  }).catch(() => {})
  await send(contents, 'Overlay.hideHighlight').catch(() => {})
  if (!keep) await send(contents, 'Overlay.disable').catch(() => {})
}

/** A PNG's width from its header, in base64; null when it is no PNG. */
export function pngWidth(base64: string): number | null {
  const head = Buffer.from(base64.slice(0, 32), 'base64')
  if (head.length < 24 || head.toString('ascii', 12, 16) !== 'IHDR') return null
  return head.readUInt32BE(16)
}

function isBox(value: unknown): value is PageBox {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** The part of `box` inside a viewport of `width` × `height`; null when none of it is. */
export function visiblePart(box: PageBox, width: number, height: number): PageBox | null {
  const left = Math.max(0, box.x)
  const top = Math.max(0, box.y)
  const right = Math.min(width, box.x + box.width)
  const bottom = Math.min(height, box.y + box.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** In the main frame's isolated world, or the node's own frame when it lies in another. */
async function resolve(contents: WebContents, backendNodeId: number): Promise<string | null> {
  try {
    const tree = await send<{ frameTree?: { frame?: { id?: string } } }>(
      contents,
      'Page.getFrameTree',
    )
    const frameId = tree.frameTree?.frame?.id
    if (frameId) {
      const world = await send<{ executionContextId: number }>(
        contents,
        'Page.createIsolatedWorld',
        { frameId, worldName: WORLD, grantUniveralAccess: false },
      )
      const { object } = await send<{ object: RemoteObject }>(contents, 'DOM.resolveNode', {
        backendNodeId,
        executionContextId: world.executionContextId,
        objectGroup: GROUP,
      })
      if (object.objectId) return object.objectId
    }
  } catch {
    // A node of a child frame is not the main frame world's.
  }
  try {
    const { object } = await send<{ object: RemoteObject }>(contents, 'DOM.resolveNode', {
      backendNodeId,
      objectGroup: GROUP,
    })
    return object.objectId ?? null
  } catch {
    return null
  }
}

async function call<T>(
  contents: WebContents,
  objectId: string,
  declaration: string,
  arg: unknown,
): Promise<T> {
  const answer = await send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    contents,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: declaration,
      arguments: [{ value: arg }],
      returnByValue: true,
    },
  )
  if (answer.exceptionDetails) throw new Error('The page could not read the element')
  return answer.result!.value as T
}

/**
 * The element the user clicked, by its backend id: its selector, label, text, box, and a
 * screenshot of the page with its visible part. `zoom` is the page's zoom factor, which scales its CSS
 * pixels to the view's. Null when the element could not be read.
 */
export async function readPick(
  contents: WebContents,
  backendNodeId: number,
  zoom: number,
): Promise<ElementPick | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), READ_MS)
  })
  try {
    return await Promise.race([readElement(contents, backendNodeId, zoom), timeout])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    void send(contents, 'Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {})
  }
}

async function readElement(
  contents: WebContents,
  backendNodeId: number,
  zoom: number,
): Promise<ElementPick | null> {
  const objectId = await resolve(contents, backendNodeId)
  if (!objectId) return null
  const read = await call<ReadResult>(contents, objectId, READ_ELEMENT, SELECTOR_ATTRIBUTES)
  const path = parseElementPath(read?.path)
  if (!path || !isBox(read.box)) return null
  const candidates = selectorCandidates(path)
  const unique = await call<string | null>(contents, objectId, FIRST_UNIQUE, candidates)
  const inner = unique ?? candidates.at(-1)!
  const host = parseElementPath(read.host ? [read.host] : null)
  const selector = host ? `${elementLabel(host[0]!)} >>> ${inner}` : inner
  const metrics = await send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
    contents,
    'Page.getLayoutMetrics',
  )
  const viewport = metrics.cssVisualViewport ?? { clientWidth: 0, clientHeight: 0 }
  const box = read.box
  // The whole viewport, unclipped: a clip moves the viewport to it, which a still taken right
  // after would show. Its fresh frame has none of the overlay, which left before.
  const image = await send<{ data: string }>(contents, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  const width = pngWidth(image.data)
  const seen = visiblePart(box, viewport.clientWidth, viewport.clientHeight)
  const scale = width && viewport.clientWidth > 0 ? width / viewport.clientWidth : 1
  const crop = seen
    ? {
        x: Math.floor(seen.x * scale),
        y: Math.floor(seen.y * scale),
        width: Math.max(1, Math.round(seen.width * scale)),
        height: Math.max(1, Math.round(seen.height * scale)),
      }
    : null
  const url = contents.getURL()
  return {
    url,
    title: typeof read.title === 'string' ? read.title : null,
    selector,
    label: elementLabel(path[0]!),
    text: elementText(typeof read.text === 'string' ? read.text : ''),
    box,
    viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
    frame: {
      x: box.x * zoom,
      y: box.y * zoom,
      width: box.width * zoom,
      height: box.height * zoom,
    },
    still: `data:image/png;base64,${image.data}`,
    crop,
  }
}

/** The page a session's pick mode is on: the pane's selected tab. */
export interface PickPage {
  tabId: string
  contents: WebContents
  /** The page's zoom factor. */
  zoom: number
}

export interface PagePickerDeps {
  /** The selected tab of the session's shown browser, when the user may use it now. */
  page(sessionId: string): PickPage | null
  /** Tells the pane of an element picked, or of the mode's end. */
  event(event: PickEvent): void
  /** Hides the page for the pane's still of it, which the pick carries, until the pane thaws it. */
  freeze(sessionId: string): void
  log(message: string): void
}

interface Picking {
  tabId: string
  contents: WebContents
  color: PickColor
  /** An element was picked, and inspect mode waits for the pane to resume it. */
  paused: boolean
  listener: (event: Electron.Event, method: string, params: unknown) => void
}

/** Each session's pick mode: one page at a time, on its selected tab, until the pane ends it. */
export class PagePicker {
  private readonly picking = new Map<string, Picking>()

  constructor(private readonly deps: PagePickerDeps) {}

  /** Whether a session's page is in pick mode. */
  has(sessionId: string): boolean {
    return this.picking.has(sessionId)
  }

  /**
   * Starts pick mode on the session's selected tab, or resumes it after a pick; false when the
   * page cannot take it now.
   */
  async start(sessionId: string, color: PickColor): Promise<boolean> {
    const page = this.deps.page(sessionId)
    const known = this.picking.get(sessionId)
    if (known && (!page || known.tabId !== page.tabId)) this.stop(sessionId, false)
    if (!page) return false
    let picking = this.picking.get(sessionId)
    if (!picking) {
      const contents = page.contents
      const listener = (_event: Electron.Event, method: string, params: unknown): void => {
        if (method === 'Overlay.inspectNodeRequested') {
          const id = (params as { backendNodeId?: unknown }).backendNodeId
          if (typeof id === 'number') void this.picked(sessionId, id)
        } else if (method === 'Overlay.inspectModeCanceled') {
          if (this.picking.get(sessionId)?.paused === false) this.stop(sessionId, true)
        }
      }
      picking = { tabId: page.tabId, contents, color, paused: false, listener }
      contents.debugger.on('message', listener)
      this.picking.set(sessionId, picking)
    }
    picking.color = color
    picking.paused = false
    const started = await beginInspect(picking.contents, color)
    if (!started && this.picking.get(sessionId) === picking) this.stop(sessionId, false)
    return started && this.picking.get(sessionId) === picking
  }

  /** Ends the session's pick mode; `notify` tells the pane, which did not end it itself. */
  stop(sessionId: string, notify: boolean): void {
    const picking = this.picking.get(sessionId)
    if (!picking) return
    this.picking.delete(sessionId)
    if (!picking.contents.isDestroyed()) {
      picking.contents.debugger.removeListener('message', picking.listener)
      void endInspect(picking.contents)
    }
    if (notify) this.deps.event({ sessionId, kind: 'ended' })
  }

  /** The pane may no longer show the page it picks on, or the agent took it: the mode ends. */
  check(sessionId: string): void {
    const picking = this.picking.get(sessionId)
    if (!picking) return
    const page = this.deps.page(sessionId)
    if (!page || page.tabId !== picking.tabId) this.stop(sessionId, true)
  }

  /** Escape on the picked page ends the mode; true when the key was the mode's. */
  key(tabId: string, input: Electron.Input): boolean {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return false
    for (const [sessionId, picking] of this.picking) {
      if (picking.tabId !== tabId || picking.paused) continue
      this.stop(sessionId, true)
      return true
    }
    return false
  }

  /** A new document in the tab: inspect mode starts over on it, as it does not carry over. */
  navigated(tabId: string): void {
    for (const picking of this.picking.values()) {
      if (picking.tabId !== tabId || picking.paused) continue
      void beginInspect(picking.contents, picking.color)
    }
  }

  /** The tab's page is gone. */
  tabGone(tabId: string): void {
    for (const [sessionId, picking] of [...this.picking]) {
      if (picking.tabId === tabId) this.stop(sessionId, true)
    }
  }

  private async picked(sessionId: string, backendNodeId: number): Promise<void> {
    const picking = this.picking.get(sessionId)
    if (!picking || picking.paused) return
    picking.paused = true
    await endInspect(picking.contents, true)
    const page = this.deps.page(sessionId)
    const pick =
      page?.tabId === picking.tabId
        ? await readPick(picking.contents, backendNodeId, page.zoom)
        : null
    if (this.picking.get(sessionId) !== picking) return
    if (!pick) {
      this.deps.log('Could not read a picked element')
      picking.paused = false
      void beginInspect(picking.contents, picking.color)
      return
    }
    this.deps.freeze(sessionId)
    this.deps.event({ sessionId, kind: 'picked', pick })
  }
}

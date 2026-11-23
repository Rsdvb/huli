// Huli: the mini window (小窗): a small window over the others that follows one session. It is made
// only when opened, from a session's menu or the tray, and gone once closed. Its page loads its
// own preload (src/preload/mini.ts), which exposes a few narrow calls, and main takes from it only
// its own channels; it may go nowhere else.

import { BrowserWindow, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import type { Locale } from '@shared/locale'
import { sendEvent } from './events'
import { createLogger } from './log'
import { loadRenderer, rendererPage } from './renderer'
import { backgroundPlace, keepInBackground, testInBackground } from './test-window'
import { backgroundColor, currentWindow, markOwnPage } from './window'

const log = createLogger('mini-window')

const WIDTH = 340
const HEIGHT = 176
const MARGIN = 24

export interface MiniWindowDeps {
  systemLocale: Locale
  /** Brings the session up in the main window. */
  showSession(sessionId: string): void
}

export class MiniWindow {
  private window: BrowserWindow | null = null
  private sessionId: string | null = null
  private loaded = false

  constructor(private readonly deps: MiniWindowDeps) {}

  /** Whether `sender` is the mini window's own page, the only one its calls are taken from. */
  owns(sender: WebContents): boolean {
    return this.window !== null && !this.window.isDestroyed() && sender === this.window.webContents
  }

  /** Shows the mini window on a session, made now if it is not open. */
  open(sessionId: string): void {
    this.sessionId = sessionId
    const window = this.window && !this.window.isDestroyed() ? this.window : this.create()
    if (this.loaded) sendEvent(window.webContents, 'mini:target', { sessionId })
    if (window.isMinimized()) window.restore()
    window.showInactive()
  }

  showSession(): void {
    if (this.sessionId) this.deps.showSession(this.sessionId)
  }

  close(): void {
    const window = this.window
    this.window = null
    this.loaded = false
    if (window && !window.isDestroyed()) window.destroy()
  }

  private create(): BrowserWindow {
    const place = testInBackground() ? backgroundPlace() : this.corner()
    const window = new BrowserWindow({
      ...place,
      width: WIDTH,
      height: HEIGHT,
      minWidth: 260,
      minHeight: 140,
      show: false,
      frame: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: backgroundColor(),
      webPreferences: {
        preload: join(__dirname, '../preload/mini.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        additionalArguments: [`--kettu-system-locale=${this.deps.systemLocale}`],
      },
    })
    markOwnPage(window, 'mini')
    if (testInBackground()) keepInBackground(window)
    window.setAlwaysOnTop(true, 'floating')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Its own page may reload, as the dev server asks after some changes; it goes nowhere else.
    window.webContents.on('will-navigate', (event, url) => {
      if (rendererPage(url) !== 'mini') event.preventDefault()
    })
    window.webContents.on('render-process-gone', () => this.close())
    window.webContents.on('did-finish-load', () => {
      this.loaded = true
      if (this.sessionId)
        sendEvent(window.webContents, 'mini:target', { sessionId: this.sessionId })
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = false
      }
    })
    this.window = window
    void loadRenderer(window, 'mini').catch((error: unknown) => {
      log.error('Could not load the mini window', error)
      this.close()
    })
    return window
  }

  /** The bottom right of the work area the main window is on, or the primary display's. */
  private corner(): { x: number; y: number } {
    const main = currentWindow()
    const display =
      main && !main.isDestroyed()
        ? screen.getDisplayMatching(main.getBounds())
        : screen.getPrimaryDisplay()
    const { x, y, width, height } = display.workArea
    return { x: x + width - WIDTH - MARGIN, y: y + height - HEIGHT - MARGIN }
  }
}

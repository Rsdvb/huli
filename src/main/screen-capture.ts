// Huli: the global screenshot (截图发到会话). Its hotkey is registered only while the user set one,
// and never in an agent's test copy. A press captures the display under the pointer with
// Electron's desktopCapturer and freezes it in a window of Kite's own over that display, where the
// user drags out a region; the crop goes to the main window, which attaches it to the session in
// focus or to New session's box. Nothing of it runs or loads until the hotkey is pressed.

import {
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  screen,
  type Display,
  type NativeImage,
  type WebContents,
} from 'electron'
import { join } from 'node:path'
import { parseCaptureRegion, type CaptureShot } from '@shared/capture'
import { acceleratorOf } from '@shared/shortcuts'
import { sendEvent } from './events'
import { createLogger } from './log'
import { loadRenderer, rendererPage } from './renderer'
import { testInBackground } from './test-window'
import { markOwnPage, showMainWindow } from './window'

const log = createLogger('screen-capture')

interface Pending {
  window: BrowserWindow
  display: Display
  image: NativeImage
}

export class ScreenCapture {
  private hotkey: string | null = null
  private pending: Pending | null = null
  private starting = false

  /** Registers the hotkey, or none with null; the same keys again change nothing. */
  setHotkey(keys: string | null): void {
    const accelerator = keys ? acceleratorOf(keys, process.platform === 'darwin') : null
    if (accelerator === this.hotkey) return
    if (this.hotkey) globalShortcut.unregister(this.hotkey)
    this.hotkey = null
    // An agent's test copy would take the owner's keys away from every other app.
    if (!accelerator || testInBackground()) return
    try {
      if (globalShortcut.register(accelerator, () => void this.start())) this.hotkey = accelerator
      else log.warn(`Another app holds ${accelerator}; the screenshot hotkey is not set`)
    } catch (error) {
      log.warn(`Could not register ${accelerator}: ${(error as Error).message}`)
    }
  }

  /** Whether `sender` is the overlay's page, the only one its answers are taken from. */
  owns(sender: WebContents): boolean {
    return this.pending !== null && sender === this.pending.window.webContents
  }

  /** The overlay's page sent the region it was dragged over. */
  done(region: unknown): void {
    const pending = this.pending
    if (!pending) return
    const { width, height } = pending.display.size
    const area = parseCaptureRegion(region, { width, height })
    this.close()
    if (!area) return
    const size = pending.image.getSize()
    const scale = size.width / width
    const crop = pending.image.crop({
      x: Math.round(area.x * scale),
      y: Math.round(area.y * scale),
      width: Math.max(1, Math.round(area.width * scale)),
      height: Math.max(1, Math.round(area.height * scale)),
    })
    this.deliver(crop.toPNG())
  }

  cancel(): void {
    this.close()
  }

  stop(): void {
    if (this.hotkey) globalShortcut.unregister(this.hotkey)
    this.hotkey = null
    this.close()
  }

  private async start(): Promise<void> {
    if (this.pending || this.starting) return
    this.starting = true
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const thumbnailSize = {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
      const source = sources.find((each) => each.display_id === String(display.id)) ?? sources[0]
      const image = source?.thumbnail
      // macOS gives an empty picture until the user allows screen recording for Kite.
      if (!image || image.isEmpty()) {
        log.warn('The screen capture came back empty; screen recording may not be allowed')
        return
      }
      this.open(display, image)
    } catch (error) {
      log.warn(`Could not capture the screen: ${(error as Error).message}`)
    } finally {
      this.starting = false
    }
  }

  private open(display: Display, image: NativeImage): void {
    const { x, y, width, height } = display.bounds
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, '../preload/capture.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    markOwnPage(window, 'capture')
    window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    this.pending = { window, display, image }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (rendererPage(url) !== 'capture') event.preventDefault()
    })
    window.webContents.on('render-process-gone', () => this.close())
    window.on('blur', () => this.close())
    window.on('closed', () => {
      if (this.pending?.window === window) this.pending = null
    })
    window.webContents.once('did-finish-load', () => {
      if (this.pending?.window !== window) return
      // A JPEG to look at, far smaller than the PNG; the crop is taken from the capture itself.
      const url = `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
      sendEvent(window.webContents, 'capture:image', { url })
      window.setBounds(display.bounds)
      window.show()
      window.focus()
    })
    void loadRenderer(window, 'capture').catch((error: unknown) => {
      log.error('Could not load the screenshot overlay', error)
      this.close()
    })
  }

  private close(): void {
    const pending = this.pending
    this.pending = null
    if (pending && !pending.window.isDestroyed()) pending.window.destroy()
  }

  private deliver(png: Buffer): void {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const shot: CaptureShot = { name: `screenshot-${stamp}.png`, data: new Uint8Array(png) }
    const { webContents } = showMainWindow()
    if (webContents.isLoadingMainFrame()) {
      webContents.once('did-finish-load', () => sendEvent(webContents, 'capture:shot', shot))
    } else {
      sendEvent(webContents, 'capture:shot', shot)
    }
  }
}

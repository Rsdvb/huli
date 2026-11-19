// Huli: a copy of the app an agent runs to test a change (`KITE_TEST_WINDOW=background`, unpackaged
// runs only) stays out of the owner's way. Its main window shows without taking the focus, past
// the right edge of every display and out of the taskbar, where it still paints at full rate, so
// CDP screenshots and `capturePage` work; a minimized or hidden window paints only when captured
// and throttles its animation frames. It has no tray icon and shows no notifications. See
// tools/huli/README.md (Testing without disturbing the owner).

import { app, screen, type BrowserWindow } from 'electron'

/** Whether this run is such a copy; an installed build never is, whatever its environment. */
export function testInBackground(): boolean {
  return !app.isPackaged && process.env.KITE_TEST_WINDOW === 'background'
}

/** The main window's place for such a run: off every display, and out of the taskbar. */
export function backgroundPlace(): { x: number; y: number; skipTaskbar: true } {
  const right = Math.max(...screen.getAllDisplays().map(({ bounds }) => bounds.x + bounds.width))
  return { x: right + 100, y: 0, skipTaskbar: true }
}

/**
 * Keeps `window` where `backgroundPlace` put it: every show, from its first to a second launch's,
 * the tray's or the quit dialog's, leaves the focus where it was, and nothing maximizes or
 * minimizes it, which would bring it onto a display or stop it painting.
 */
export function keepInBackground(window: BrowserWindow): void {
  window.show = () => window.showInactive()
  window.focus = () => {}
  window.maximize = () => {}
  window.minimize = () => {}
}

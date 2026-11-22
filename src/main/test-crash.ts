// Huli: imported first by the main entry, so it runs before any other module's top-level code. A
// test copy (`KITE_TEST_WINDOW=background`, unpackaged only) that throws while starting would
// otherwise get Electron's modal error box on the owner's screen; it logs the error and quits.

import { app } from 'electron'

if (!app.isPackaged && process.env.KITE_TEST_WINDOW === 'background') {
  process.on('uncaughtException', (error) => {
    console.error('[test copy] uncaught exception, quitting:', error)
    app.exit(1)
  })
}

// Huli: the screenshot overlay's preload: the frozen display to show, and the region the user
// dragged out or Cancel. Main takes from its page only these.

import { contextBridge } from 'electron'
import type { CaptureOverlayApi } from '@shared/capture'
import { send, subscribe } from './ipc'

const api: CaptureOverlayApi = {
  onImage: subscribe('capture:image'),
  done: (region) => send('capture:done', region),
  cancel: () => send('capture:cancel'),
}

contextBridge.exposeInMainWorld('kettuCapture', api)

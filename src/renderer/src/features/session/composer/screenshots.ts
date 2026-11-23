// Huli: the global screenshot's shots (截图发到会话), which main sends once a region was dragged
// out: each goes to the message box of the session in view, or New session's, opened for it.

import type { CaptureShot } from '@shared/capture'
import { newSession } from '@renderer/app/actions'
import { emitAppEvent } from '@renderer/app/events'
import { errorMessage, sessionHost } from '@renderer/lib/host'
import { useViewStore } from '@renderer/stores/view'
import { attachFiles } from './attachments'
import { NEW_SESSION_DRAFT } from './drafts'

function attachShot(shot: CaptureShot): void {
  const file = new File([shot.data as Uint8Array<ArrayBuffer>], shot.name, { type: 'image/png' })
  const { main } = useViewStore.getState()
  const sessionId = main.kind === 'session' ? main.sessionId : null
  if (sessionId === null) newSession()
  const draft = sessionId ?? NEW_SESSION_DRAFT
  attachFiles(draft, [file], sessionId === null ? null : sessionHost(sessionId))
    .then(() => emitAppEvent({ kind: 'focus-composer' }))
    .catch((error: unknown) =>
      console.warn(`Could not attach the screenshot: ${errorMessage(error)}`),
    )
}

/** Takes the shots main sends this window, for as long as it runs. */
export function followScreenshots(): void {
  window.kettu.capture?.onShot(attachShot)
}

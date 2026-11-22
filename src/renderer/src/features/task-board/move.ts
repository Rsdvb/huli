import type { BoardStatus } from '@shared/session-board'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'

/**
 * Moves a session to a column of the board: at once in the window, then on its host, whose
 * answer comes back as the session's summary. A refusal puts it back where it was and says why.
 */
export async function moveOnBoard(sessionId: string, status: BoardStatus): Promise<void> {
  const before = useSessionsStore.getState().byId[sessionId]
  if (!before?.board || before.board.status === status) return
  const moved = { status, at: Date.now() }
  useSessionsStore.getState().upsert({ ...before, board: moved })
  try {
    await host('sessions.setBoardStatus', { sessionId, status })
  } catch (error) {
    const now = useSessionsStore.getState().byId[sessionId]
    if (now?.board === moved) useSessionsStore.getState().upsert({ ...now, board: before.board })
    toast(errorMessage(error))
  }
}

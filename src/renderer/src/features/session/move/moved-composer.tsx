// Huli: in place of the composer of a session moved to another computer: where it went, a link to
// it there, the local worktree's removal (left alone by the move) and going on here after all.

import { useState } from 'react'
import { ComputerArrowUpIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  askRemoveWorktree,
  canRemoveWorktree,
} from '@renderer/features/worktrees/remove-worktree-model'
import { errorMessage, host } from '@renderer/lib/host'
import { openMoved } from './move'

export function MovedComposer({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('session')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const moved = summary.movedTo!
  const stay = async () => {
    setBusy(true)
    setError(null)
    try {
      await host('sessions.clearMoved', { sessionId: summary.id })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="ks-bar">
        <Glyph icon={ComputerArrowUpIcon} className="ks-bar__icon size-4 shrink-0" />
        <p>{t('move.moved', { name: moved.name })}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            className="ks-btn"
            onClick={() => openMoved(moved.hostId, moved.sessionId, moved.projectPath)}
          >
            {t('move.open')}
          </Button>
          {canRemoveWorktree(summary) && (
            <Button
              variant="outline"
              className="ks-btn"
              onClick={() => void askRemoveWorktree(summary)}
            >
              {t('move.cleanUp')}
            </Button>
          )}
          <Button variant="ghost" className="ks-btn" disabled={busy} onClick={() => void stay()}>
            {t('move.stay')}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

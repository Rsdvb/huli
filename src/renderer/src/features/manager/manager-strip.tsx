// Huli: above a manager's composer: how many workers work and wait, and the way to the 工人 pane
// and 全部停止, so the user sees it with the pane closed. It draws from the manager's summary alone.

import { Crown02Icon, StopCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { useSessionsStore } from '@renderer/stores/sessions'
import { toggleSidePane, useViewStore } from '@renderer/stores/view'
import { setPaused, stopAll } from './model'
import './manager.css'

export function ManagerStrip({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('session')
  const manager = useSessionsStore((s) => s.byId[sessionId]?.manager ?? null)
  const running = useSessionsStore((s) => {
    const status = s.byId[sessionId]?.status
    return status === 'running' || status === 'awaiting_permission'
  })
  const open = useViewStore((s) => s.sidePane[sessionId] === 'workers')
  if (!manager) return null
  const busy = manager.working > 0 || running
  const text = manager.stopped
    ? t('manager.strip.stopped')
    : manager.paused
      ? t('manager.strip.paused', { count: manager.working })
      : manager.working > 0
        ? t('manager.strip.working', { count: manager.working })
        : t('manager.strip.idle')
  return (
    <div className="km-strip" role="status">
      <Glyph icon={Crown02Icon} size={13} />
      <span className="km-strip__text">
        {text}
        {manager.waiting > 0 && (
          <span className="km-strip__asks">
            {' · '}
            {t('manager.strip.waiting', { count: manager.waiting })}
          </span>
        )}
        {manager.held > 0 && ` · ${t('manager.strip.held', { count: manager.held })}`}
      </span>
      {manager.paused && (
        <Button size="xs" variant="ghost" onClick={() => void setPaused(sessionId, false)}>
          {t('manager.pane.resume')}
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => toggleSidePane(sessionId, 'workers', !open)}>
        {open ? t('manager.strip.hide') : t('manager.strip.show')}
      </Button>
      {busy && (
        <Button
          size="xs"
          variant="ghost"
          className="text-danger"
          onClick={() => void stopAll(sessionId)}
        >
          <Glyph icon={StopCircleIcon} size={13} />
          {t('manager.stopAll')}
        </Button>
      )}
    </div>
  )
}

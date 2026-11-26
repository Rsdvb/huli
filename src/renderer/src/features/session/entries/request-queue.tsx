import { useState } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { bulkSplit, inQueue, type QueuedRequest } from '@shared/permission-queue'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import { host } from '@renderer/lib/host'
import { useThreadsStore } from '@renderer/stores/threads'
import { labelText, toolLabel } from './helpers'
import { RiskBadge } from './risk-badge'
import { KIND_GLYPH } from './tool-call-model'
import { useAnswering } from './use-answering'

type Decision = 'allow' | 'deny'

/** The line under the thread's oldest request, from the entries of the replica. */
export function ThreadRequestQueue({
  sessionId,
  queueKey,
  projectPath,
}: {
  sessionId: string
  queueKey: string
  projectPath: string
}) {
  const queue = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return queueKey.split('\n').map((id) => byId?.[id])
    }),
  )
  const queued = queue.filter(inQueue)
  if (queued.length < 2) return null
  return (
    <RequestQueue key={queueKey} sessionId={sessionId} queue={queued} projectPath={projectPath} />
  )
}

/**
 * Huli: what waits behind the request answered now, collapsed into one line under its card: it
 * opens to list them, and where two or more are plain requests, 全部同意 / 全部拒绝 list what they
 * answer and what they leave before anything is sent. An allow never takes a high request.
 * `queue` starts with the request answered now; key it by the queue so its state starts anew.
 */
export function RequestQueue({
  sessionId,
  queue,
  projectPath,
}: {
  sessionId: string
  queue: readonly QueuedRequest[]
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<Decision | null>(null)
  const { answering, error, away, send } = useAnswering(sessionId)
  const later = queue.slice(1)
  const splits = { allow: bulkSplit(queue, 'allow'), deny: bulkSplit(queue, 'deny') }
  const offers = (decision: Decision) => splits[decision].answered.length > 1
  const busy = away || answering !== null
  const split = confirming ? splits[confirming] : null

  const confirm = async () => {
    if (!confirming || !split || busy) return
    const decision = confirming
    const requestIds = split.answered.map((entry) => entry.permission.requestId)
    await send(decision, () =>
      host('permissions.respondAll', { sessionId, requestIds, decision }).then(() => {}),
    )
  }

  const rows = (entries: readonly QueuedRequest[]) => (
    <ul className="ks-queue__list">
      {entries.map((entry) => (
        <QueueRow key={entry.id} entry={entry} projectPath={projectPath} />
      ))}
    </ul>
  )

  return (
    <div className="ks-queue" data-open={open || confirming ? '' : undefined}>
      <div className="ks-queue__bar">
        <button
          type="button"
          className="ks-queue__toggle"
          aria-expanded={open}
          onClick={() => {
            // From a confirmation the line goes back to the list, else it opens or folds.
            if (confirming) setConfirming(null)
            else setOpen((was) => !was)
          }}
        >
          <span aria-hidden className="ks-queue__chevron">
            <Icon icon={ArrowDown01Icon} size={14} />
          </span>
          {t('permission.queue.later', { count: later.length })}
        </button>
        {!confirming && (offers('allow') || offers('deny')) && (
          <div className="ks-queue__actions">
            {offers('deny') && (
              <Button size="xs" variant="ghost" onClick={() => setConfirming('deny')}>
                {t('permission.queue.denyAll')}
              </Button>
            )}
            {offers('allow') && (
              <Button size="xs" variant="outline" onClick={() => setConfirming('allow')}>
                {t('permission.queue.allowAll')}
              </Button>
            )}
          </div>
        )}
      </div>
      {confirming && split ? (
        <div className="ks-queue__confirm">
          <p className="ks-queue__title">
            {t(`permission.queue.confirm.${confirming}`, { count: split.answered.length })}
          </p>
          {rows(split.answered)}
          {split.skipped.length > 0 && (
            <>
              <p className="ks-queue__title">{t(`permission.queue.skipped.${confirming}`)}</p>
              {rows(split.skipped)}
            </>
          )}
          <div className="ks-queue__buttons">
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
              {t('permission.queue.cancel')}
            </Button>
            <Button
              size="xs"
              variant={confirming === 'deny' ? 'destructive-outline' : 'default'}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {t(`permission.queue.do.${confirming}`, { count: split.answered.length })}
            </Button>
          </div>
          {error && (
            <p role="alert" className="ks-card-error">
              {error}
            </p>
          )}
        </div>
      ) : open ? (
        rows(later)
      ) : null}
    </div>
  )
}

function QueueRow({ entry, projectPath }: { entry: QueuedRequest; projectPath: string }) {
  const label = toolLabel(entry, projectPath)
  const text = (entry.question ?? labelText(label)).split('\n')[0]
  const risk = entry.permission.risk
  return (
    <li className="ks-queue__row">
      <Icon icon={KIND_GLYPH[entry.toolKind]} size={13} />
      <span className="ks-queue__what" dir="auto">
        {text}
      </span>
      {risk && <RiskBadge level={risk.level} />}
    </li>
  )
}

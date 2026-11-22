import { useState } from 'react'
import { AiChat02Icon, Alert02Icon, ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TakenPort, TaskProcess } from '@shared/task-processes'
import type { ForegroundTaskView } from '@shared/thread'
import { lastPort, type PortBlock } from '@shared/worktree-ports'
import { Button } from '@renderer/components/ui/button'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { storageBytes } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { Clock } from './row-parts'

const percent = (cpu: number): string =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: cpu < 10 ? 1 : 0 }).format(cpu)}%`

/**
 * Huli: what was read of a task's processes, in a line: its process id, CPU and memory, and the
 * ports it listens on, a port outside the session's block marked.
 */
export function TaskStats({ stats, block }: { stats: TaskProcess; block: PortBlock | null }) {
  const { t } = useTranslation('board')
  const facts = [
    stats.pid !== null ? t('process.pid', { pid: stats.pid }) : null,
    stats.cpu !== null ? t('process.cpu', { cpu: percent(stats.cpu) }) : null,
    stats.memory !== null ? storageBytes(stats.memory) : null,
  ].filter((fact): fact is string => fact !== null)
  if (facts.length === 0 && stats.ports.length === 0) return null
  const range = block ? `${block.first}–${lastPort(block)}` : ''
  return (
    <span className="kb-live__stats">
      {facts.length > 0 && <span>{facts.join(' · ')}</span>}
      {stats.ports.map((item) => (
        <span
          key={item.port}
          className="kb-port"
          data-state={item.collides ? 'collides' : item.outside ? 'outside' : undefined}
          title={
            item.collides
              ? t('process.collides', { port: item.port, range })
              : item.outside
                ? t('process.outside', { port: item.port, range })
                : t('process.listens', { port: item.port })
          }
        >
          {(item.outside || item.collides) && <PaneIcon icon={Alert02Icon} size={11} />}:
          {item.port}
        </span>
      ))}
    </span>
  )
}

/** Huli: the ports of the session's block that programs outside it hold, which its servers lose. */
export function TakenPorts({ taken, block }: { taken: TakenPort[]; block: PortBlock }) {
  const { t } = useTranslation('board')
  if (taken.length === 0) return null
  const range = `${block.first}–${lastPort(block)}`
  const ports = taken
    .map((item) =>
      item.process
        ? t('process.takenBy', { port: item.port, process: item.process })
        : `:${item.port}`,
    )
    .join(t('process.separator'))
  return (
    <p className="kb-taken" role="status">
      <PaneIcon icon={Alert02Icon} size={13} />
      <span>{t('process.taken', { count: taken.length, range, ports })}</span>
    </p>
  )
}

/** Huli: moves what holds up a tool call to the background; `error` says why the last try failed. */
export function useToBackground(sessionId: string, toolCallId: string) {
  const { t } = useTranslation('board')
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = () => {
    setMoving(true)
    setError(null)
    host('sessions.toBackground', { sessionId, toolCallId })
      .then(({ moved }) => {
        if (!moved) setError(t('held.notMoved'))
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setMoving(false))
  }
  return { move, moving, error }
}

/** Huli: To background on a command's row in the thread, while the turn waits for it. */
export function ToBackgroundButton({
  sessionId,
  toolCallId,
}: {
  sessionId: string
  toolCallId: string
}) {
  const { t } = useTranslation('session')
  const { move, moving, error } = useToBackground(sessionId, toolCallId)
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={moving}
      title={error ?? t('tool.toBackgroundTitle')}
      onClick={move}
    >
      {t('tool.toBackground')}
    </Button>
  )
}

/**
 * Huli: a command or subagent that holds up its tool call, and with it the turn: its name and
 * clock, and To background, which lets the turn go on while it runs.
 */
export function HeldLive({ sessionId, task }: { sessionId: string; task: ForegroundTaskView }) {
  const { t } = useTranslation('board')
  const { move, moving, error } = useToBackground(sessionId, task.toolCallId)
  return (
    <div className="kb-item">
      <div className="kb-live" data-kind="held">
        <span className="kb-mark">
          <PaneIcon
            icon={task.kind === 'subagent' ? AiChat02Icon : ComputerTerminal01Icon}
            size={14}
          />
        </span>
        <span className="kb-live__name">{task.title}</span>
        <span className="kb-live__end">
          <Clock since={task.startedAt} />
        </span>
        <span className="kb-live__what kb-live__what--held">
          {t(task.kind === 'subagent' ? 'held.subagent' : 'held.command')}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="kb-live__act kb-live__move"
          disabled={moving}
          onClick={move}
        >
          {t('actions.toBackground')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="kb-item__error">
          {error}
        </p>
      )}
    </div>
  )
}

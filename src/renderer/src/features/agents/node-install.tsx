// Huli: installing Kite's own Node.js from wherever Kite says Node.js is missing or too old: the
// one-click install with its progress and errors, and the small link to install it by hand. The
// host does the work (`environment.installNode`) and reports in `environment.changed`.

import { Cancel01Icon, Download04Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { NodeTask } from '@shared/agent-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Meter, SetButton, Spin } from '@renderer/features/settings/controls'
import { cn } from '@renderer/lib/utils'
import type { HostScope } from '@renderer/stores/host-scope'
import { nodePhaseText, useNodeInstall } from './node-runtime'

/** Settings' own controls, or the window's elsewhere, as under New session's composer. */
type Look = 'settings' | 'inline'

/** The small link to nodejs.org's download page, for installing Node.js by hand. */
export function ManualNodeLink({ look = 'settings' }: { look?: Look }) {
  const { t } = useTranslation('agents')
  return (
    <a
      href={t('node.manualUrl')}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'shrink-0 text-xs text-secondary',
        look === 'settings'
          ? 'k-link'
          : 'underline decoration-(--line-strong) underline-offset-3 hover:text-foreground',
      )}
    >
      {t('node.manual')}
    </a>
  )
}

/** The install's progress: its phase, how much arrived, and Stop. */
function NodeProgress({ task, look, onStop }: { task: NodeTask; look: Look; onStop: () => void }) {
  const { t } = useTranslation('agents')
  const text = nodePhaseText(t, task)
  const percent =
    task.phase === 'downloading' && task.progress !== null ? Math.floor(task.progress * 100) : null
  const stop =
    task.kind === 'install' &&
    (look === 'settings' ? (
      <button
        type="button"
        className="k-pill-close shrink-0"
        aria-label={t('node.stop')}
        title={t('node.stop')}
        onClick={onStop}
      >
        <Icon icon={Cancel01Icon} size={10} />
      </button>
    ) : (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('node.stop')}
        title={t('node.stop')}
        onClick={onStop}
      >
        <Icon icon={Cancel01Icon} size={12} />
      </Button>
    ))
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-secondary" role="status">
      {percent !== null && look === 'settings' ? (
        <>
          <span className="truncate">{text}</span>
          <Meter value={percent} label={text} />
        </>
      ) : (
        <>
          {look === 'settings' ? <Spin label={text} /> : <Spinner className="size-3.5 shrink-0" />}
          <span className="truncate">{percent === null ? text : `${text} · ${percent}%`}</span>
        </>
      )}
      {stop}
    </span>
  )
}

/**
 * One-click install of Kite's Node.js, its progress while it runs, and why it failed, with the
 * link to install it by hand beside it. Only the link where the host cannot install it.
 */
export function NodeInstallAction(props: {
  scope?: HostScope
  look?: Look
  /** Whether the link to install it by hand shows beside the button. */
  manual?: boolean
  /** In place of Install Node.js, such as Update for Kite's own. */
  label?: string
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  const { scope, look = 'settings', manual = true, variant = 'primary', className } = props
  const { t } = useTranslation('agents')
  const { node, task, running, install, cancel, dismiss, failure } = useNodeInstall(scope)
  if (!node?.installable) return manual ? <ManualNodeLink look={look} /> : null
  const label =
    failure && task?.kind !== 'remove' ? t('node.retry') : (props.label ?? t('node.install'))
  const icon = <Icon icon={Download04Icon} size={look === 'settings' ? 14 : 12} />
  return (
    <span className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="flex min-w-0 items-center gap-3">
        {running && task ? (
          <NodeProgress task={task} look={look} onStop={cancel} />
        ) : look === 'settings' ? (
          <SetButton variant={variant} icon={icon} onClick={install} className="shrink-0">
            {label}
          </SetButton>
        ) : (
          <Button variant="outline" size="xs" className="shrink-0" onClick={install}>
            {icon}
            {label}
          </Button>
        )}
        {manual && <ManualNodeLink look={look} />}
      </span>
      {failure && !running && (
        <span
          role="alert"
          className={cn('text-xs', look === 'settings' ? 'k-error' : 'text-destructive')}
          data-wrap=""
          data-selectable=""
        >
          {t(task?.kind === 'remove' ? 'node.removeFailed' : 'node.failed', { error: failure })}{' '}
          {look === 'settings' && (
            <button type="button" className="k-link" onClick={dismiss}>
              {t('node.dismiss')}
            </button>
          )}
        </span>
      )}
    </span>
  )
}

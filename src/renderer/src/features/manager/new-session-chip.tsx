// Huli: New session's 总管模式 chip: whether the session starts as a manager, with its review loop
// and who answers its workers' requests, and the roster it dispatches to. Turning it on moves the
// agent to the manager the settings suggest; an agent that cannot be held to reading cannot be one.

import { Crown02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { canManage } from '@shared/manager'
import type { AgentId } from '@shared/thread'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { openSettings } from '@renderer/stores/view'
import { useManagerDraft } from './draft'
import { useManagerSettings } from './model'

export function ManagerChip({
  agentId,
  projectPath,
  onSuggest,
}: {
  agentId: AgentId | null
  projectPath: string | null
  /** Moves New session to the suggested manager agent, profile and model. */
  onSuggest: (agentId: AgentId, profileId: string | null, model: string | null) => void
}) {
  const { t } = useTranslation('session')
  const draft = useManagerDraft()
  const settings = useManagerSettings(projectPath)
  const able = agentId !== null && canManage(agentId)
  const on = draft.on && able
  const autoReview = draft.autoReview ?? settings?.autoReview ?? true
  const approvals = draft.approvals ?? settings?.approvals ?? 'user'
  const workers = settings?.workers ?? []
  const reviewer = workers.find((w) => w.id === settings?.reviewerId)
  const limits = settings?.limits

  const turnOn = (next: boolean) => {
    useManagerDraft.setState({ on: next })
    const suggestion = settings?.suggestion
    if (next && suggestion) onSuggest(suggestion.agentId, suggestion.profileId, suggestion.model)
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t('manager.chip.label')}
            aria-pressed={on}
            className={cn('ui-as-tray-link', on && 'kettu-manager-chip--on')}
          />
        }
      >
        <Glyph icon={Crown02Icon} size={13} />
        <span className="kettu-tray-link__text">
          {on ? t('manager.chip.on') : t('manager.chip.off')}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-85 gap-3 p-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <b className="block text-ui font-medium text-foreground">{t('manager.chip.title')}</b>
            <p className="text-xs text-muted-foreground">{t('manager.chip.lead')}</p>
          </div>
          <Switch
            checked={on}
            disabled={!able && !draft.on}
            onCheckedChange={turnOn}
            aria-label={t('manager.chip.title')}
          />
        </div>
        {!able && agentId !== null && (
          <p className="text-xs text-danger">{t('manager.chip.cannot')}</p>
        )}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t('manager.chip.workers')}</span>
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={() => openSettings('manager')}
            >
              {t('manager.chip.editRoster')}
            </button>
          </div>
          {workers.length === 0 ? (
            <p className="text-muted-foreground">{t('manager.chip.noWorkers')}</p>
          ) : (
            <p className="text-foreground">
              {workers.map((w) => (w.id === reviewer?.id ? `${w.name} ★` : w.name)).join(' · ')}
            </p>
          )}
        </div>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-foreground">{t('manager.chip.autoReview')}</span>
            <span className="text-muted-foreground">
              {reviewer
                ? t('manager.chip.autoReviewHint', {
                    name: reviewer.name,
                    count: limits?.reviewRounds ?? 3,
                  })
                : t('manager.chip.noReviewer')}
            </span>
          </span>
          <Switch
            checked={autoReview && !!reviewer}
            disabled={!reviewer}
            onCheckedChange={(next) => useManagerDraft.setState({ autoReview: next })}
            aria-label={t('manager.chip.autoReview')}
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <span className="block text-foreground">{t('manager.chip.approvals')}</span>
            <span className="text-muted-foreground">
              {approvals === 'low'
                ? t('manager.approvals.lowHint')
                : t('manager.approvals.userHint')}
            </span>
          </span>
          <Switch
            checked={approvals === 'low'}
            onCheckedChange={(next) =>
              useManagerDraft.setState({ approvals: next ? 'low' : 'user' })
            }
            aria-label={t('manager.chip.approvals')}
          />
        </label>
        {limits && (
          <p className="text-xs text-muted-foreground">
            {t('manager.chip.limits', {
              concurrent: limits.concurrent,
              turns: limits.turnsPerTask,
            })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Huli: Settings › 总管模式: the manager the new manager sessions suggest, the roster of workers
// it dispatches to, the review loop, who answers the workers' requests, and the limits, for all
// projects or a project of its own. See tools/huli/README.md (Manager mode).
import { Crown02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Segmented, SettingSelect, SettingSwitch } from './controls'
import {
  BUDGETS,
  CONCURRENT,
  ROUNDS,
  saveLimits,
  saveProject,
  TURNS,
  useEdited,
  withCurrent,
} from './manager-data'
import {
  RosterActions,
  ScopeSelect,
  SuggestButton,
  SuggestionControl,
  WorkerRow,
} from './manager-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { EmptyRow, GroupNote } from './rows'

export function useManagerSection(): SectionDef {
  const { t } = useTranslation('settings')
  const edited = useEdited()
  const { value, inherits, project } = edited
  const scopeGroup: GroupDef = {
    id: 'manager-scope',
    label: t('manager.groups.scope'),
    note: <GroupNote>{t('manager.notes.scope')}</GroupNote>,
  }
  const managerGroup: GroupDef = {
    id: 'manager-suggestion',
    label: t('manager.groups.manager'),
    note: <GroupNote>{t('manager.notes.manager')}</GroupNote>,
  }
  const rosterGroup: GroupDef = {
    id: 'manager-roster',
    label: t('manager.groups.roster'),
    count: value.workers.length,
    actions: <RosterActions />,
    note: <GroupNote>{t('manager.notes.roster')}</GroupNote>,
  }
  const reviewGroup: GroupDef = { id: 'manager-review', label: t('manager.groups.review') }
  const limitsGroup: GroupDef = {
    id: 'manager-limits',
    label: t('manager.groups.limits'),
    note: <GroupNote>{t('manager.notes.limits')}</GroupNote>,
  }
  const rows: RowDef[] = [
    {
      id: 'scope',
      setting: 'manager.scope',
      group: scopeGroup,
      render: () => <ScopeSelect />,
    },
  ]
  if (project !== null) {
    rows.push({
      id: 'project',
      setting: 'manager.project',
      group: scopeGroup,
      render: () => (
        <SettingSwitch
          label={t('manager.project.name')}
          checked={!inherits}
          onChange={(on) =>
            void saveProject(
              project,
              on
                ? {
                    workers: value.workers,
                    reviewerId: value.reviewerId,
                    autoReview: value.autoReview,
                    approvals: value.approvals,
                    limits: value.limits,
                  }
                : null,
            )
          }
        />
      ),
    })
  }
  if (project !== null && inherits) {
    return {
      id: 'manager',
      title: t('sections.manager'),
      description: t('pages.manager'),
      icon: Crown02Icon,
      rows,
    }
  }
  if (project === null) {
    rows.push({
      id: 'suggestion',
      setting: 'manager.suggestion',
      group: managerGroup,
      layout: 'block',
      render: (text) => <SuggestionControl text={text} />,
    })
  }
  if (value.workers.length === 0) {
    rows.push({
      id: 'roster-empty',
      setting: 'manager.roster',
      group: rosterGroup,
      layout: 'custom',
      render: () => (
        <EmptyRow
          title={t('manager.empty.title')}
          hint={t('manager.empty.hint')}
          action={<SuggestButton />}
        />
      ),
    })
  } else {
    for (const worker of value.workers) {
      rows.push({
        id: `worker:${worker.id}`,
        setting: 'manager.roster',
        item: { name: worker.name, description: t(`manager.roles.${worker.role}`) },
        group: rosterGroup,
        layout: 'custom',
        render: () => <WorkerRow worker={worker} />,
      })
    }
  }
  rows.push(
    {
      id: 'auto-review',
      setting: 'manager.auto-review',
      group: reviewGroup,
      description: value.reviewerId ? null : t('manager.autoReview.noReviewer'),
      render: () => (
        <SettingSwitch
          label={t('manager.autoReview.name')}
          checked={value.autoReview}
          onChange={(autoReview) => edited.save({ ...value, autoReview })}
        />
      ),
    },
    {
      id: 'rounds',
      setting: 'manager.rounds',
      group: reviewGroup,
      render: () => (
        <SettingSelect<string>
          label={t('manager.rounds.name')}
          value={String(value.limits.reviewRounds)}
          options={ROUNDS.map((n) => ({
            value: String(n),
            label: t('manager.rounds.count', { count: n }),
          }))}
          onChange={(n) => saveLimits(edited, { reviewRounds: Number(n) })}
        />
      ),
    },
    {
      id: 'approvals',
      setting: 'manager.approvals',
      group: reviewGroup,
      layout: 'block',
      render: (text) => (
        <div className="grid gap-2">
          {text}
          <Segmented<'user' | 'low'>
            label={t('manager.approvals.name')}
            value={value.approvals}
            options={[
              { value: 'user', label: t('manager.approvals.user') },
              { value: 'low', label: t('manager.approvals.low') },
            ]}
            onChange={(approvals) => edited.save({ ...value, approvals })}
          />
        </div>
      ),
    },
    {
      id: 'concurrent',
      setting: 'manager.concurrent',
      group: limitsGroup,
      render: () => (
        <SettingSelect<string>
          label={t('manager.concurrent.name')}
          value={String(value.limits.concurrent)}
          options={CONCURRENT.map((n) => ({
            value: String(n),
            label: t('manager.concurrent.count', { count: n }),
          }))}
          onChange={(n) => saveLimits(edited, { concurrent: Number(n) })}
        />
      ),
    },
    {
      id: 'turns',
      setting: 'manager.turns',
      group: limitsGroup,
      render: () => (
        <SettingSelect<string>
          label={t('manager.turns.name')}
          value={String(value.limits.turnsPerTask)}
          options={withCurrent(TURNS, value.limits.turnsPerTask).map((n) => ({
            value: String(n),
            label: t('manager.turns.count', { count: n }),
          }))}
          onChange={(n) => saveLimits(edited, { turnsPerTask: Number(n) })}
        />
      ),
    },
    {
      id: 'budget',
      setting: 'manager.budget',
      group: limitsGroup,
      render: () => (
        <SettingSelect<string>
          label={t('manager.budget.name')}
          value={String(value.limits.tokenBudget ?? 0)}
          options={withCurrent(BUDGETS, value.limits.tokenBudget ?? 0).map((n) => ({
            value: String(n),
            label:
              n === 0
                ? t('manager.budget.none')
                : t('manager.budget.tokens', {
                    wan: String(n / 10_000),
                    short: n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`,
                  }),
          }))}
          onChange={(n) => saveLimits(edited, { tokenBudget: Number(n) === 0 ? null : Number(n) })}
        />
      ),
    },
  )
  if (project === null) {
    rows.push({
      id: 'after-restart',
      setting: 'manager.after-restart',
      group: limitsGroup,
      render: () => (
        <SettingSelect<'resume' | 'tell'>
          label={t('manager.afterRestart.name')}
          value={value.afterRestart}
          options={[
            { value: 'resume', label: t('manager.afterRestart.resume') },
            { value: 'tell', label: t('manager.afterRestart.tell') },
          ]}
          onChange={(afterRestart) => edited.save({ ...value, afterRestart })}
        />
      ),
    })
  }
  return {
    id: 'manager',
    title: t('sections.manager'),
    description: t('pages.manager'),
    icon: Crown02Icon,
    rows,
  }
}

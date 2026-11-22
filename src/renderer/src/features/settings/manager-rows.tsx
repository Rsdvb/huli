// Huli: Settings › 总管模式's controls: the scope, the suggested manager, the roster's rows and actions.
import { useState, type ReactNode } from 'react'
import { Delete02Icon, PencilEdit02Icon, StarIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { canManage, writes, type ManagerSettings, type RosterWorker } from '@shared/manager'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { IconAction, SetButton, SettingSelect } from './controls'
import {
  GLOBAL,
  NONE,
  newId,
  suggestedRoster,
  useAgents,
  useEdited,
  useScope,
} from './manager-data'
import { WorkerDialog } from './manager-worker-dialog'
import { RowLine, Thing } from './rows'

/** All projects, or one of this computer's projects with a roster of its own. */
export function ScopeSelect() {
  const { t } = useTranslation('settings')
  const path = useScope((s) => s.path)
  const projects = useProjectsStore(
    useShallow((s) => s.projects.filter((p) => hostOfPath(p.path) === null && !p.missing)),
  )
  return (
    <SettingSelect<string>
      label={t('manager.scope.name')}
      value={path ?? GLOBAL}
      options={[
        { value: GLOBAL, label: t('manager.scope.global') },
        ...projects.map((p) => ({
          value: p.path,
          label: p.manager ? t('manager.scope.own', { name: p.name }) : p.name,
        })),
      ]}
      onChange={(next) => useScope.setState({ path: next === GLOBAL ? null : next })}
    />
  )
}

/** The agent, model and profile new manager sessions start with. */
export function SuggestionControl({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const edited = useEdited()
  const agents = useAgents().filter((a) => canManage(a.id))
  const suggestion = edited.value.suggestion
  const agent = agents.find((a) => a.id === suggestion?.agentId)
  const options = useAgentOptionsStore((s) =>
    suggestion ? (s.byId[suggestion.agentId] ?? null) : null,
  )
  const models =
    options?.config
      .find((o) => o.category === 'model')
      ?.choices?.map((c) => ({ value: c.value, label: c.name })) ?? []
  const profiles = agent?.profiles?.items ?? []
  const set = (next: ManagerSettings['suggestion']) =>
    edited.save({ ...edited.value, suggestion: next })
  return (
    <div className="grid gap-2">
      {text}
      <div className="flex flex-wrap gap-2">
        <SettingSelect<string>
          label={t('manager.suggestion.agent')}
          value={suggestion?.agentId ?? NONE}
          options={[
            { value: NONE, label: t('manager.suggestion.none') },
            ...agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
          onChange={(id) =>
            set(
              id === NONE
                ? null
                : { agentId: id as AgentStatus['id'], model: null, profileId: null },
            )
          }
        />
        {suggestion && profiles.length > 0 && (
          <SettingSelect<string>
            label={t('manager.suggestion.profile')}
            value={suggestion.profileId ?? NONE}
            options={[
              { value: NONE, label: t('manager.suggestion.ownSignIn') },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(id) => set({ ...suggestion, profileId: id === NONE ? null : id })}
          />
        )}
        {suggestion && models.length > 0 && (
          <SettingSelect<string>
            label={t('manager.suggestion.model')}
            value={suggestion.model ?? NONE}
            options={[{ value: NONE, label: t('manager.suggestion.defaultModel') }, ...models]}
            onChange={(id) => set({ ...suggestion, model: id === NONE ? null : id })}
          />
        )}
      </div>
    </div>
  )
}

export function RosterActions() {
  const { t } = useTranslation('settings')
  const edited = useEdited()
  const agents = useAgents()
  const [adding, setAdding] = useState<RosterWorker | null>(null)
  if (agents.length === 0) return null
  const fresh = (): RosterWorker => ({
    id: newId(),
    name: '',
    role: 'implement',
    agentId: agents[0]!.id,
    model: null,
    effort: null,
    profileId: null,
    mode: null,
    worktree: false,
    persona: '',
  })
  return (
    <>
      <SetButton
        size="sm"
        onClick={() => setAdding(fresh())}
        disabled={edited.value.workers.length >= 12}
      >
        {t('manager.actions.add')}
      </SetButton>
      {adding && (
        <WorkerDialog
          open
          worker={adding}
          roster={edited.value.workers}
          onClose={() => setAdding(null)}
          onSave={(worker) => {
            const workers = [...edited.value.workers, worker]
            const reviewerId =
              edited.value.reviewerId ?? (worker.role === 'review' ? worker.id : null)
            edited.save({ ...edited.value, workers, reviewerId })
            setAdding(null)
          }}
        />
      )}
    </>
  )
}

export function SuggestButton() {
  const { t } = useTranslation('settings')
  const edited = useEdited()
  const agents = useAgents()
  return (
    <SetButton
      size="sm"
      disabled={agents.length === 0}
      onClick={() => {
        const roster = suggestedRoster(agents, (key) => t(key as never))
        edited.save({
          ...edited.value,
          workers: roster.workers,
          reviewerId: roster.reviewerId,
          ...(edited.project === null && !edited.value.suggestion
            ? { suggestion: roster.suggestion }
            : {}),
        })
      }}
    >
      {t('manager.actions.suggest')}
    </SetButton>
  )
}

export function WorkerRow({ worker }: { worker: RosterWorker }) {
  const { t } = useTranslation('settings')
  const edited = useEdited()
  const [editing, setEditing] = useState(false)
  const agent = useAgentsStore((s) => s.byId[worker.agentId])
  const reviewer = edited.value.reviewerId === worker.id
  const runs = [agent?.name ?? worker.agentId, worker.model].filter(Boolean).join(' · ')
  const remove = () => {
    const workers = edited.value.workers.filter((w) => w.id !== worker.id)
    edited.save({
      ...edited.value,
      workers,
      reviewerId: reviewer ? null : edited.value.reviewerId,
    })
  }
  return (
    <>
      <RowLine
        text={
          <Thing
            mark={<AgentMark agent={worker.agentId} size={20} />}
            name={
              <>
                {worker.name}
                {reviewer && <span className="ml-1 text-(--shell-muted)">★</span>}
              </>
            }
          >
            <small>
              {t(`manager.roles.${worker.role}`)} · {runs}
              {writes(worker.role) && worker.worktree
                ? ` · ${t('manager.worker.worktreeShort')}`
                : ''}
              {agent ? '' : ` · ${t('manager.worker.agentGone')}`}
            </small>
          </Thing>
        }
      >
        {worker.role === 'review' && !reviewer && (
          <IconAction
            label={t('manager.actions.makeReviewer')}
            icon={StarIcon}
            onClick={() => edited.save({ ...edited.value, reviewerId: worker.id })}
          />
        )}
        <IconAction
          label={t('manager.actions.edit')}
          icon={PencilEdit02Icon}
          onClick={() => setEditing(true)}
        />
        <IconAction
          label={t('manager.actions.remove')}
          icon={Delete02Icon}
          danger
          onClick={remove}
        />
      </RowLine>
      {editing && (
        <WorkerDialog
          open
          worker={worker}
          roster={edited.value.workers}
          onClose={() => setEditing(false)}
          onSave={(next) => {
            const workers = edited.value.workers.map((w) => (w.id === next.id ? next : w))
            const reviewerId =
              edited.value.reviewerId === next.id && next.role !== 'review'
                ? null
                : edited.value.reviewerId
            edited.save({ ...edited.value, workers, reviewerId })
            setEditing(false)
          }}
        />
      )}
    </>
  )
}

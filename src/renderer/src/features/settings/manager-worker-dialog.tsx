// Huli: Settings › 总管模式's worker dialog: a roster entry's name, role, agent, model, level,
// profile, mode, worktree choice and persona, checked as the settings file checks it.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import {
  PERSONA_CHARS,
  WORKER_NAME_CHARS,
  WORKER_ROLES,
  findWorker,
  workerProblem,
  writes,
  type RosterWorker,
  type WorkerRole,
} from '@shared/manager'
import type { AgentId, ConfigOption } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { Segmented, SettingSelect } from './controls'

const DEFAULT = '__default__'

/** The flat choices of a select option, its groups' ones included. */
function choicesOf(option: ConfigOption | undefined): { value: string; name: string }[] {
  if (!option?.choices) return []
  return option.choices.flatMap((choice) =>
    typeof choice.value === 'string' ? [{ value: choice.value, name: choice.name }] : [],
  )
}

export function WorkerDialog({
  open,
  worker,
  roster,
  onSave,
  onClose,
}: {
  open: boolean
  /** The entry to edit, or a new one's first values. */
  worker: RosterWorker
  /** The roster it goes in, for the name it must not repeat. */
  roster: readonly RosterWorker[]
  onSave: (worker: RosterWorker) => void
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState(worker)
  const [seen, setSeen] = useState(worker)
  if (seen !== worker) {
    setSeen(worker)
    setDraft(worker)
  }
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (agent) => isInstalled(agent) && !agent.hidden && !agent.disabled,
      ),
    ),
  )
  const agent = agents.find((a) => a.id === draft.agentId) as AgentStatus | undefined
  const options = useAgentOptionsStore((s) => s.byId[draft.agentId] ?? null)
  const modelOption = options?.config.find((o) => o.category === 'model')
  const models = choicesOf(modelOption)
  const levelOption =
    (draft.model ? options?.levels[draft.model] : undefined) ??
    options?.config.find((o) => o.category === 'thought_level')
  const levels = choicesOf(levelOption)
  const modeOption = options?.config.find((o) => o.category === 'mode' && o.type === 'select')
  const modes = choicesOf(modeOption)
  const profiles = agent?.profiles?.items ?? []
  const set = (changes: Partial<RosterWorker>) => setDraft((d) => ({ ...d, ...changes }))
  const others = roster.filter((w) => w.id !== draft.id)
  const repeated = draft.name.trim() !== '' && !!findWorker(others, draft.name)
  const problem = workerProblem({ ...draft, name: draft.name.trim() })
  const invalid = repeated || problem !== null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {roster.some((w) => w.id === worker.id)
              ? t('manager.worker.editTitle')
              : t('manager.worker.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('manager.worker.lead')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs">
            <span className="text-(--shell-muted)">{t('manager.worker.name')}</span>
            <Input
              value={draft.name}
              maxLength={WORKER_NAME_CHARS}
              placeholder={t('manager.worker.namePlaceholder')}
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
          <div className="grid gap-1 text-xs">
            <span className="text-(--shell-muted)">{t('manager.worker.role')}</span>
            <Segmented<WorkerRole>
              label={t('manager.worker.role')}
              value={draft.role}
              options={WORKER_ROLES.map((role) => ({
                value: role,
                label: t(`manager.roles.${role}`),
              }))}
              onChange={(role) => set({ role, ...(writes(role) ? {} : { worktree: false }) })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-(--shell-muted)">{t('manager.worker.agent')}</span>
              <SettingSelect<string>
                label={t('manager.worker.agent')}
                value={draft.agentId}
                className="w-full"
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
                onChange={(agentId) =>
                  set({
                    agentId: agentId as AgentId,
                    model: null,
                    effort: null,
                    profileId: null,
                    mode: null,
                  })
                }
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-(--shell-muted)">{t('manager.worker.model')}</span>
              <SettingSelect<string>
                label={t('manager.worker.model')}
                value={draft.model ?? DEFAULT}
                className="w-full"
                options={[
                  { value: DEFAULT, label: t('manager.worker.agentDefault') },
                  ...models.map((m) => ({ value: m.value, label: m.name })),
                ]}
                onChange={(model) => set({ model: model === DEFAULT ? null : model, effort: null })}
              />
            </label>
            {levels.length > 0 && (
              <label className="grid gap-1 text-xs">
                <span className="text-(--shell-muted)">{t('manager.worker.effort')}</span>
                <SettingSelect<string>
                  label={t('manager.worker.effort')}
                  value={draft.effort ?? DEFAULT}
                  className="w-full"
                  options={[
                    { value: DEFAULT, label: t('manager.worker.agentDefault') },
                    ...levels.map((l) => ({ value: l.value, label: l.name })),
                  ]}
                  onChange={(effort) => set({ effort: effort === DEFAULT ? null : effort })}
                />
              </label>
            )}
            {profiles.length > 0 && (
              <label className="grid gap-1 text-xs">
                <span className="text-(--shell-muted)">{t('manager.worker.profile')}</span>
                <SettingSelect<string>
                  label={t('manager.worker.profile')}
                  value={draft.profileId ?? DEFAULT}
                  className="w-full"
                  options={[
                    { value: DEFAULT, label: t('manager.worker.profileDefault') },
                    ...profiles.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(profileId) =>
                    set({ profileId: profileId === DEFAULT ? null : profileId })
                  }
                />
              </label>
            )}
            {writes(draft.role) && modes.length > 0 && (
              <label className="grid gap-1 text-xs">
                <span className="text-(--shell-muted)">{t('manager.worker.mode')}</span>
                <SettingSelect<string>
                  label={t('manager.worker.mode')}
                  value={draft.mode ?? DEFAULT}
                  className="w-full"
                  options={[
                    { value: DEFAULT, label: t('manager.worker.modeDefault') },
                    ...modes.map((m) => ({ value: m.value, label: m.name })),
                  ]}
                  onChange={(mode) => set({ mode: mode === DEFAULT ? null : mode })}
                />
              </label>
            )}
          </div>
          {!writes(draft.role) && (
            <p className="text-xs text-(--shell-muted)">{t('manager.worker.readOnly')}</p>
          )}
          {writes(draft.role) && (
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>
                <span className="block">{t('manager.worker.worktree')}</span>
                <span className="text-(--shell-muted)">{t('manager.worker.worktreeHint')}</span>
              </span>
              <Switch
                checked={draft.worktree}
                onCheckedChange={(worktree) => set({ worktree })}
                aria-label={t('manager.worker.worktree')}
              />
            </label>
          )}
          <label className="grid gap-1 text-xs">
            <span className="text-(--shell-muted)">{t('manager.worker.persona')}</span>
            <Textarea
              rows={5}
              value={draft.persona}
              maxLength={PERSONA_CHARS}
              placeholder={t('manager.worker.personaPlaceholder')}
              onChange={(event) => set({ persona: event.target.value })}
            />
            <span className="text-(--shell-muted)">{t('manager.worker.personaNote')}</span>
          </label>
          {repeated && <p className="text-xs text-danger">{t('manager.worker.repeated')}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="dialog" onClick={onClose}>
            {t('manager.worker.cancel')}
          </Button>
          <Button
            size="dialog"
            disabled={invalid}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            {t('manager.worker.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

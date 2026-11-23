import { Add01Icon, Delete02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { GROUP_RUNS_MAX, GROUP_RUNS_MIN } from '@shared/run-groups'
import type { AgentId, ConfigOption } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { addRun, removeRun, setRun, useBestOfN, type RunPick } from '@renderer/stores/best-of-n'
import { readFirstOptions } from './prepared'
import { modelOption } from './run-starts'
import { menuAgents, startConfig } from './start-options'

// A model's value is never empty, so the agent's own model takes the empty value.
const OWN_MODEL = ''

type Choices = NonNullable<ConfigOption['choices']>

/** The models a run may pick, the agent's current ones first; one shown as another is left out. */
function runModels(choices: Choices): Choices {
  const listed = choices.filter((c) => !c.shownAs)
  return [...listed.filter((c) => !c.older), ...listed.filter((c) => c.older)]
}

/** The agents New session can start on the host, as the agent picker lists them. */
function useStartable(hostId: string | null) {
  return useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return menuAgents(usableAgents(order, byId)).filter((a) => !a.disabled)
    }),
  )
}

/**
 * Huli: New session's runs while its message goes to several agents at once: a chip for each, its
 * agent and model, whose menu changes or removes it, and a button to add one, from 2 to 4.
 */
export function RunsBar({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('session')
  const runs = useBestOfN((s) => s.runs)
  const agents = useStartable(hostId)
  const first = agents[0]?.id ?? null
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 px-2.75"
      role="group"
      aria-label={t('group.runs.label')}
    >
      <span className="text-xs text-secondary">{t('group.runs.label')}</span>
      {runs.map((run, index) => (
        <RunChip
          key={index}
          index={index}
          run={run}
          hostId={hostId}
          agents={agents}
          removable={runs.length > GROUP_RUNS_MIN}
        />
      ))}
      {runs.length < GROUP_RUNS_MAX && (
        <button
          type="button"
          className="inline-flex h-6.5 items-center gap-1 rounded-full border border-dashed border-default px-2 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
          disabled={!first && runs.length === 0}
          onClick={() => {
            const last = runs[runs.length - 1]
            const agentId = last?.agentId ?? first
            if (agentId) addRun({ agentId, model: null })
          }}
        >
          <Glyph icon={Add01Icon} size={12} />
          {t('group.runs.add')}
        </button>
      )}
    </div>
  )
}

function RunChip({
  index,
  run,
  hostId,
  agents,
  removable,
}: {
  index: number
  run: RunPick
  hostId: string | null
  agents: ReturnType<typeof useStartable>
  removable: boolean
}) {
  const { t } = useTranslation('session')
  const entry = useAgentOptionsStore((s) => optionsOn(s, hostId)[run.agentId])
  const config = entry?.config
  const model = modelOption(config)
  const choices: Choices = model?.choices ?? []
  const models = runModels(choices)
  // The agent's own model is the one a session would start with: its default or the last used.
  const ownValue = entry ? modelOption(startConfig(entry, {}, { startMode: true }))?.value : null
  const own =
    typeof ownValue === 'string' ? (choices.find((c) => c.value === ownValue)?.name ?? null) : null
  const shown = run.model ? (choices.find((c) => c.value === run.model)?.name ?? run.model) : own
  const usable = agents.some((a) => a.id === run.agentId)
  const name = agentName(run.agentId, hostId)
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void readFirstOptions(hostId, run.agentId)
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('group.runs.edit', { n: index + 1 })}
            data-unusable={!usable || undefined}
            className="inline-flex h-6.5 max-w-56 min-w-0 items-center gap-1.5 rounded-full border border-default bg-surface px-2 text-xs text-primary transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus data-unusable:border-danger data-unusable:text-danger"
          />
        }
      >
        <AgentMark agent={run.agentId} size={13} className="shrink-0" hostId={hostId} />
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-tertiary">·</span>
        <span className="truncate text-secondary">{shown ?? t('group.runs.ownModel')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('group.runs.agent')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={run.agentId}
            onValueChange={(value) => {
              const agentId = String(value) as AgentId
              if (agentId !== run.agentId) setRun(index, { agentId, model: null })
            }}
          >
            {agents.map((agent) => (
              <DropdownMenuRadioItem key={agent.id} value={agent.id} closeOnClick={false}>
                <AgentMark agent={agent.id} size={14} className="shrink-0" hostId={hostId} />
                <span className="truncate">{agent.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('group.runs.model')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={run.model ?? OWN_MODEL}
            onValueChange={(value) => {
              const picked = String(value)
              setRun(index, { agentId: run.agentId, model: picked === OWN_MODEL ? null : picked })
            }}
          >
            <DropdownMenuRadioItem value={OWN_MODEL} closeOnClick>
              <span className="truncate">
                {own ? t('group.runs.ownModelNamed', { model: own }) : t('group.runs.ownModel')}
              </span>
            </DropdownMenuRadioItem>
            {models.map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value} closeOnClick>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{choice.name}</span>
                  {choice.description && (
                    <span className="truncate text-meta text-tertiary">{choice.description}</span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {!config && (
            <p className="px-2 py-1.5 text-meta text-tertiary">{t('group.runs.readingModels')}</p>
          )}
        </DropdownMenuGroup>
        {removable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => removeRun(index)}>
              <MenuGlyph icon={Delete02Icon} />
              {t('group.runs.remove')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

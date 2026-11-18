// A Claude Code agent's common settings on its page: the auto-compact window for all models and
// for each model, and the prompt cache duration, read from and saved to its settings file on the
// agent's host; and Kettu's own settings for how its sessions run, the fallback model and budget.

import { useCallback, useEffect, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, ClaudeCompactRow, ClaudeSettings } from '@shared/agent-host'
import {
  AUTO_COMPACT_STEPS,
  canonicalClaudeModel,
  KNOWN_CLAUDE_MODELS,
  PROMPT_CACHE_TTLS,
  type PromptCacheTtl,
} from '@shared/agents'
import {
  CLAUDE_RUN_DEFAULTS,
  CLAUDE_TEST_ENTRYPOINT_LABEL_CHARS,
  isClaudeBudgetUsd,
  isClaudeTestEntrypointLabel,
  type ClaudeRunSettings,
} from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SetButton, SettingSelect, SettingSwitch, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'
import { DIALOG_MONO_FIELD } from './settings-dialog'

const AUTO = 'auto'
const NO_FALLBACK = ''
const MAX_MODEL_CHARS = 256

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

/** A model the add menu offers: a known one, or what the user typed. */
interface ModelChoice {
  id: string
  name: string | null
  custom?: true
}

const knownName = (id: string): string | null =>
  KNOWN_CLAUDE_MODELS.find((model) => model.id === id)?.name ?? null

/** A window as the select writes it: 200K, 750K, 1M. */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  return `${Math.round(tokens / 1000)}K`
}

/** The steps beside Auto, with a window the file holds that is not one of them kept in place. */
function windowOptions(current: number | null, auto: string): { value: string; label: string }[] {
  const steps =
    current !== null && !AUTO_COMPACT_STEPS.includes(current)
      ? [...AUTO_COMPACT_STEPS, current].sort((a, b) => a - b)
      : AUTO_COMPACT_STEPS
  return [
    { value: AUTO, label: auto },
    ...steps.map((tokens) => ({ value: String(tokens), label: windowLabel(tokens) })),
  ]
}

function isTtl(value: string): value is PromptCacheTtl {
  return (PROMPT_CACHE_TTLS as readonly string[]).includes(value)
}

export function ClaudeSettingsRows({ status }: { status: AgentStatus }) {
  const { hostId, request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
  // Models typed in, kept as rows until the file holds a window for them.
  const [added, setAdded] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saveCompact, compactBusy, compactError] = useAction()
  const [saveCache, cacheBusy, cacheError] = useAction()
  const load = useCallback(
    () =>
      request('agents.claudeSettings', { agentId: status.id }).then(
        (settings) => setRead({ state: 'ready', settings }),
        (error: unknown) => setRead({ state: 'failed', error: errorMessage(error) }),
      ),
    [request, status.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const settings = read.state === 'ready' ? read.settings : null
  const rows: ClaudeCompactRow[] = settings
    ? [
        ...settings.compact,
        ...added
          .filter((model) => !settings.compact.some((row) => row.model === model))
          .map((model) => ({ model, name: null, window: null })),
      ]
    : []
  const auto = t('agents.claudeSettings.auto')
  const compactName = t('agents.claudeSettings.compact.name')
  const cacheName = t('agents.claudeSettings.cache.name')
  const compactNote = compactError ?? (read.state === 'failed' ? read.error : null)
  const cacheNote = cacheError ?? (read.state === 'failed' ? read.error : null)

  const saveWindow = (model: string | null, next: string): void =>
    saveCompact(async () => {
      await request('agents.setClaudeSetting', {
        agentId: status.id,
        change: {
          setting: 'autoCompactWindow',
          model,
          value: next === AUTO ? null : Number(next),
        },
      })
      await load()
    })

  const addModel = (model: string): void => {
    const id = canonicalClaudeModel(model)
    setAdded((current) => (current.includes(id) ? current : [...current, id]))
    setMenuOpen(false)
  }

  // Known models not shown yet that match the text, and the text itself when it could be an id.
  const text = query.trim()
  const shownIds = new Set(rows.map((row) => row.model))
  const suggestions: ModelChoice[] = KNOWN_CLAUDE_MODELS.filter(
    (model) =>
      !shownIds.has(model.id) &&
      `${model.name} ${model.id}`.toLowerCase().includes(text.toLowerCase()),
  ).map((model) => ({ id: model.id, name: model.name }))
  const typed = canonicalClaudeModel(text)
  const choices: ModelChoice[] =
    text !== '' &&
    text.length <= MAX_MODEL_CHARS &&
    !/\s/.test(text) &&
    !shownIds.has(typed) &&
    !suggestions.some((choice) => choice.id === typed)
      ? [...suggestions, { id: text, name: null, custom: true }]
      : suggestions

  return (
    <>
      <RowShell>
        <div className="k-block">
          <BlockLine
            text={
              <RowText
                name={compactName}
                description={t('agents.claudeSettings.compact.description')}
              />
            }
          />
          {read.state === 'loading' && (
            <BlockLine text={<Skel width={120} />}>
              <Skel width={210} className="k-skel--field" />
            </BlockLine>
          )}
          {settings && (
            <BlockLine text={<RowText name={t('agents.claudeSettings.compact.all')} />}>
              <SettingSelect
                label={`${compactName}: ${t('agents.claudeSettings.compact.all')}`}
                value={settings.defaultWindow === null ? AUTO : String(settings.defaultWindow)}
                disabled={compactBusy}
                options={windowOptions(settings.defaultWindow, auto)}
                onChange={(next) => saveWindow(null, next)}
              />
            </BlockLine>
          )}
          {settings &&
            rows.map((row) => {
              const name = row.name ?? knownName(row.model) ?? row.model
              return (
                <BlockLine key={row.model} text={<RowText name={name} />}>
                  <SettingSelect
                    label={`${compactName}: ${name}`}
                    value={row.window === null ? AUTO : String(row.window)}
                    disabled={compactBusy}
                    options={windowOptions(
                      row.window,
                      settings.defaultWindow === null
                        ? auto
                        : t('agents.claudeSettings.compact.sameAsAll'),
                    )}
                    onChange={(next) => saveWindow(row.model, next)}
                  />
                </BlockLine>
              )
            })}
          {settings && (
            <BlockLine text={<RowText name={t('agents.claudeSettings.compact.add')} />}>
              <Combobox<ModelChoice>
                items={choices}
                filteredItems={choices}
                value={null}
                open={menuOpen}
                onOpenChange={(next) => {
                  setMenuOpen(next)
                  if (!next) setQuery('')
                }}
                inputValue={query}
                onInputValueChange={setQuery}
                onValueChange={(choice) => choice && addModel(choice.id)}
                itemToStringLabel={(choice) => choice.id}
                isItemEqualToValue={(a, b) => a.id === b.id}
                autoHighlight
              >
                <ComboboxPrimitive.Trigger
                  render={
                    <button
                      type="button"
                      className="ui-ss-select k-select"
                      aria-label={t('agents.claudeSettings.compact.add')}
                      disabled={compactBusy}
                    />
                  }
                >
                  <span className="k-select__value">
                    {t('agents.claudeSettings.compact.choose')}
                  </span>
                  <Icon icon={ArrowDown01Icon} size={14} />
                </ComboboxPrimitive.Trigger>
                <ComboboxContent align="end" sideOffset={6} className="flex w-72 flex-col">
                  <ComboboxInput
                    showTrigger={false}
                    placeholder={t('agents.claudeSettings.compact.search')}
                    aria-label={t('agents.claudeSettings.compact.search')}
                    spellCheck={false}
                    className="h-10.5! px-2"
                  />
                  <ComboboxList className="px-1.5 pt-0.5 pb-1.5">
                    {(choice: ModelChoice) => (
                      <ComboboxItem
                        key={choice.id}
                        value={choice}
                        className="h-9 gap-2.5 rounded-lg py-1 pr-2 pl-2 data-highlighted:bg-hover [&>span.absolute]:hidden"
                      >
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="truncate text-menu text-primary">
                            {choice.custom
                              ? t('agents.claudeSettings.compact.addCustom', { id: choice.id })
                              : choice.name}
                          </span>
                          {!choice.custom && (
                            <span className="truncate text-small text-tertiary">{choice.id}</span>
                          )}
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>{t('agents.claudeSettings.compact.noMatch')}</ComboboxEmpty>
                </ComboboxContent>
              </Combobox>
            </BlockLine>
          )}
        </div>
        {compactNote && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {compactNote}
          </p>
        )}
      </RowShell>
      <RowShell>
        <RowLine
          text={
            <RowText name={cacheName} description={t('agents.claudeSettings.cache.description')} />
          }
        >
          {read.state === 'loading' ? (
            <Skel width={210} className="k-skel--field" />
          ) : (
            <SettingSelect
              label={cacheName}
              value={settings?.promptCacheTtl ?? AUTO}
              disabled={settings === null || cacheBusy}
              options={[
                { value: AUTO, label: auto },
                ...PROMPT_CACHE_TTLS.map((ttl) => ({
                  value: ttl,
                  label: t(`agents.claudeSettings.cache.${ttl}`),
                })),
              ]}
              onChange={(next) =>
                saveCache(async () => {
                  await request('agents.setClaudeSetting', {
                    agentId: status.id,
                    change: { setting: 'promptCacheTtl', value: isTtl(next) ? next : null },
                  })
                  await load()
                })
              }
            />
          )}
        </RowLine>
        {cacheNote && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {cacheNote}
          </p>
        )}
      </RowShell>
      <ClaudeRunRows
        agentId={status.id}
        models={settings ? settings.compact.filter((row) => row.name !== null) : []}
        loading={read.state === 'loading'}
      />
      {hostId === null && <ClaudeTestEntrypointRow />}
    </>
  )
}

/** The typed budget: null when empty, undefined when it is no budget. */
function parseBudget(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return isClaudeBudgetUsd(value) ? value : undefined
}

/** The fallback model and the budget per run, kept in Kettu's settings by agent. */
function ClaudeRunRows({
  agentId,
  models,
  loading,
}: {
  agentId: AgentId
  models: readonly ClaudeCompactRow[]
  loading: boolean
}) {
  const { useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const [save, busy, error] = useAction()
  const [draft, setDraft] = useState<string | null>(null)
  // An older host sends none.
  const run =
    useSettingsStore((s) => s.settings.general.claudeRuns?.[agentId]) ?? CLAUDE_RUN_DEFAULTS
  const stored = run.budgetUsd === null ? '' : String(run.budgetUsd)
  const text = draft ?? stored
  const budget = parseBudget(text)
  const canSave = !busy && budget !== undefined && text.trim() !== stored
  const fallbackName = t('agents.claudeSettings.runs.fallback.name')
  const budgetName = t('agents.claudeSettings.runs.budget.name')
  const allName = t('agents.claudeSettings.runs.allSessions.name')

  const write = (change: Partial<ClaudeRunSettings>): Promise<void> => {
    const store = useSettingsStore.getState()
    const runs = { ...store.settings.general.claudeRuns }
    const next = { ...CLAUDE_RUN_DEFAULTS, ...runs[agentId], ...change }
    if (next.fallbackModel === null && next.budgetUsd === null && !next.budgetAllSessions) {
      delete runs[agentId]
    } else {
      runs[agentId] = next
    }
    return store.update({ general: { claudeRuns: runs } })
  }

  const fallback = run.fallbackModel
  const fallbackOptions = [
    { value: NO_FALLBACK, label: t('agents.claudeSettings.runs.fallback.none') },
    ...models.map((model) => ({ value: model.model, label: model.name ?? model.model })),
    ...(fallback !== null && !models.some((model) => model.model === fallback)
      ? [
          {
            value: fallback,
            label: t('agents.claudeSettings.runs.fallback.unlisted', {
              id: knownName(fallback) ?? fallback,
            }),
          },
        ]
      : []),
  ]

  return (
    <>
      <RowShell>
        <RowLine
          text={
            <RowText
              name={fallbackName}
              description={t('agents.claudeSettings.runs.fallback.description')}
            />
          }
        >
          {loading ? (
            <Skel width={210} className="k-skel--field" />
          ) : (
            <SettingSelect
              label={fallbackName}
              value={fallback ?? NO_FALLBACK}
              disabled={busy}
              options={fallbackOptions}
              onChange={(next) =>
                save(() => write({ fallbackModel: next === NO_FALLBACK ? null : next }))
              }
            />
          )}
        </RowLine>
      </RowShell>
      <RowShell>
        <div className="k-block">
          <BlockLine
            text={
              <RowText
                name={budgetName}
                description={t('agents.claudeSettings.runs.budget.description')}
              />
            }
          >
            <form
              className="flex min-w-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!canSave || budget === undefined) return
                save(async () => {
                  await write({ budgetUsd: budget })
                  setDraft(null)
                })
              }}
            >
              <input
                className={DIALOG_MONO_FIELD + ' w-28 min-w-0'}
                aria-label={budgetName}
                aria-invalid={budget === undefined}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('agents.claudeSettings.runs.budget.placeholder')}
                value={text}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
              />
              <SetButton type="submit" disabled={!canSave}>
                {t('agents.key.save')}
              </SetButton>
            </form>
          </BlockLine>
          <BlockLine
            text={
              <RowText
                name={allName}
                description={t('agents.claudeSettings.runs.allSessions.description')}
              />
            }
          >
            <SettingSwitch
              label={allName}
              checked={run.budgetAllSessions}
              disabled={busy || run.budgetUsd === null}
              onChange={(next) => save(() => write({ budgetAllSessions: next }))}
            />
          </BlockLine>
        </div>
        {(error || budget === undefined) && (
          <p role="status" className="k-row-note k-error" data-wrap="">
            {error ?? t('agents.claudeSettings.runs.budget.invalid')}
          </p>
        )}
      </RowShell>
    </>
  )
}

function ClaudeTestEntrypointRow() {
  const { useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const [save, busy, error] = useAction()
  const [draft, setDraft] = useState<string | null>(null)
  const checked = useSettingsStore((s) => s.settings.general.claudeTestEntrypoint)
  const stored = useSettingsStore((s) => s.settings.general.claudeTestEntrypointLabel)
  const value = draft ?? stored
  const valid = isClaudeTestEntrypointLabel(value)
  const canSave = !busy && valid && value !== stored
  const name = t('agents.claudeSettings.testEntrypoint.name')
  const label = t('agents.claudeSettings.testEntrypoint.label')
  return (
    <RowShell>
      <div className="k-block">
        <BlockLine
          text={
            <RowText
              name={name}
              description={t('agents.claudeSettings.testEntrypoint.description')}
            />
          }
        >
          <SettingSwitch
            label={name}
            checked={checked}
            disabled={busy}
            onChange={(next) =>
              save(() =>
                useSettingsStore.getState().update({ general: { claudeTestEntrypoint: next } }),
              )
            }
          />
        </BlockLine>
        <BlockLine
          text={
            <RowText
              name={label}
              description={t('agents.claudeSettings.testEntrypoint.labelHint')}
            />
          }
        >
          <form
            className="flex min-w-0 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!canSave) return
              save(async () => {
                await useSettingsStore
                  .getState()
                  .update({ general: { claudeTestEntrypointLabel: value } })
                setDraft(null)
              })
            }}
          >
            <input
              className={DIALOG_MONO_FIELD + ' min-w-0 max-w-56'}
              aria-label={label}
              aria-invalid={!valid}
              autoComplete="off"
              spellCheck={false}
              maxLength={CLAUDE_TEST_ENTRYPOINT_LABEL_CHARS}
              value={value}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <SetButton type="submit" disabled={!canSave}>
              {t('agents.key.save')}
            </SetButton>
          </form>
        </BlockLine>
      </div>
      {(error || !valid) && (
        <p role="status" className="k-row-note k-error" data-wrap="">
          {error ?? t('agents.claudeSettings.testEntrypoint.invalid')}
        </p>
      )}
    </RowShell>
  )
}

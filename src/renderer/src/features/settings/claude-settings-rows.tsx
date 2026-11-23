// A Claude Code agent's prompt cache duration on its page, read from and saved to its settings
// file on the agent's host. Its auto-compact windows are the auto-compact rows every harness has.
// Huli: and Kettu's own settings for how its sessions run, the fallback model and budget, and
// whether they predict the next prompt.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentStatus,
  ClaudeCompactRow,
  ClaudeSettings,
  OutputStyleInfo,
} from '@shared/agent-host'
import { KNOWN_CLAUDE_MODELS, PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@shared/agents'
import {
  CLAUDE_RUN_DEFAULTS,
  CLAUDE_TEST_ENTRYPOINT_LABEL_CHARS,
  isClaudeBudgetUsd,
  isClaudeTestEntrypointLabel,
  type ClaudeRunSettings,
} from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAction } from './agent-helpers'
import { SetButton, SettingSelect, SettingSwitch, Skel } from './controls'
import { BlockLine, RowLine, RowShell, RowText } from './rows'
import { DIALOG_MONO_FIELD } from './settings-dialog'

const AUTO = 'auto'
const NO_FALLBACK = ''
const FOLLOW_STYLE = ''

const knownName = (id: string): string | null =>
  KNOWN_CLAUDE_MODELS.find((model) => model.id === id)?.name ?? null

type Read =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; settings: ClaudeSettings }

function isTtl(value: string): value is PromptCacheTtl {
  return (PROMPT_CACHE_TTLS as readonly string[]).includes(value)
}

export function ClaudeSettingsRows({ status }: { status: AgentStatus }) {
  const { hostId, request } = useHostScope()
  const { t } = useTranslation('settings')
  const [read, setRead] = useState<Read>({ state: 'loading' })
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
  const auto = t('agents.claudeSettings.auto')
  const cacheName = t('agents.claudeSettings.cache.name')
  const cacheNote = cacheError ?? (read.state === 'failed' ? read.error : null)

  return (
    <>
      <RowShell id="prompt-cache">
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
        styles={settings?.outputStyles ?? null}
        ownStyle={settings?.outputStyle ?? null}
      />
      <PromptSuggestionsRow />
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
  styles,
  ownStyle,
}: {
  agentId: AgentId
  models: readonly ClaudeCompactRow[]
  loading: boolean
  /** Huli: Claude Code's output styles; null from an older host, which keeps none. */
  styles: readonly OutputStyleInfo[] | null
  /** Huli: the style Claude Code's own settings name; null for its default. */
  ownStyle: string | null
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
    if (
      next.fallbackModel === null &&
      next.budgetUsd === null &&
      !next.budgetAllSessions &&
      !next.outputStyle
    ) {
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

  // Huli: the output style new sessions start in, or Claude Code's own setting.
  const styleName = t('agents.claudeSettings.runs.outputStyle.name')
  const chosenStyle = run.outputStyle ?? null
  const labelOf = (name: string): string =>
    styles?.find((style) => style.name === name)?.label ?? name
  const styleOptions = styles
    ? [
        {
          value: FOLLOW_STYLE,
          label: t('agents.claudeSettings.runs.outputStyle.follow', {
            style: labelOf(ownStyle ?? 'default'),
          }),
        },
        ...styles.map((style) => ({ value: style.name, label: style.label })),
        ...(chosenStyle !== null && !styles.some((style) => style.name === chosenStyle)
          ? [
              {
                value: chosenStyle,
                label: t('agents.claudeSettings.runs.outputStyle.missing', { style: chosenStyle }),
              },
            ]
          : []),
      ]
    : null

  return (
    <>
      {styleOptions && (
        <RowShell>
          <RowLine
            text={
              <RowText
                name={styleName}
                description={t('agents.claudeSettings.runs.outputStyle.description')}
              />
            }
          >
            <SettingSelect
              label={styleName}
              value={chosenStyle ?? FOLLOW_STYLE}
              disabled={busy}
              options={styleOptions}
              onChange={(next) =>
                save(() => write({ outputStyle: next === FOLLOW_STYLE ? null : next }))
              }
            />
          </RowLine>
        </RowShell>
      )}
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

/** Claude Code's predicted next prompt in the composer, for every Claude Code agent. */
function PromptSuggestionsRow() {
  const { useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const [save, busy, error] = useAction()
  // An older host sends none, and offers them as the default does.
  const checked = useSettingsStore((s) => s.settings.general.promptSuggestions) ?? true
  const name = t('agents.claudeSettings.suggestions.name')
  return (
    <RowShell>
      <RowLine
        text={
          <RowText name={name} description={t('agents.claudeSettings.suggestions.description')} />
        }
      >
        <SettingSwitch
          label={name}
          checked={checked}
          disabled={busy}
          onChange={(next) =>
            save(() => useSettingsStore.getState().update({ general: { promptSuggestions: next } }))
          }
        />
      </RowLine>
      {error && (
        <p role="status" className="k-row-note k-error" data-wrap="">
          {error}
        </p>
      )}
    </RowShell>
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

// Marketplace › Sync › Instructions: the shared snippets Kite keeps, edited here, and which of them
// each agent's instructions file holds in Kite's block at its end.

import { useState } from 'react'
import { Add01Icon, Delete02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  SYNC_SNIPPET_BODY_CHARS,
  SYNC_SNIPPET_TITLE_CHARS,
  type AgentSyncState,
  type SyncInstructionsPlace,
  type SyncSnippet,
} from '@shared/agent-sync'
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { Pill } from '@renderer/features/settings/controls'
import { DIALOG_FIELD } from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { chosenFor, type Pending } from './model'
import { useAgentsLabel, useProblemText } from './labels'
import { CellBox, PlaceHead } from './parts'

const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

export function InstructionsSection({
  state,
  pending,
  onChange,
  onSaved,
}: {
  state: AgentSyncState
  pending: Pending
  onChange: (next: Pending) => void
  onSaved: (snippets: SyncSnippet[]) => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const label = useAgentsLabel()
  const problemText = useProblemText()
  const [selected, setSelected] = useState<string | null>(state.snippets[0]?.id ?? null)
  const [draft, setDraft] = useState<SyncSnippet | null>(null)
  const [saving, setSaving] = useState(false)
  const current = state.snippets.find((snippet) => snippet.id === selected) ?? null
  const editing = draft && draft.id === selected ? draft : current

  const save = async (snippets: SyncSnippet[]) => {
    setSaving(true)
    try {
      await scope.request('sync.saveSnippets', { snippets })
      setDraft(null)
      onSaved(snippets)
    } catch (e) {
      toast(t('sync.instructions.saveFailed', { error: errorMessage(e) }), undefined, {
        tone: 'warning',
      })
    } finally {
      setSaving(false)
    }
  }

  const add = () => {
    const snippet = { id: newId(), title: t('sync.instructions.untitled'), body: '' }
    setSelected(snippet.id)
    setDraft(snippet)
    void save([...state.snippets, snippet])
  }

  const toggle = (place: SyncInstructionsPlace, id: string) => {
    const chosen = chosenFor(place, pending)
    const next = chosen.includes(id)
      ? chosen.filter((item) => item !== id)
      : state.snippets.map((s) => s.id).filter((item) => item === id || chosen.includes(item))
    const instructions = new Map(pending.instructions)
    instructions.set(place.id, next)
    onChange({ ...pending, instructions })
  }

  const overwrite = (place: SyncInstructionsPlace) => {
    const instructions = new Map(pending.instructions)
    instructions.set(place.id, [...chosenFor(place, pending)])
    onChange({ ...pending, instructions })
  }

  const dirty =
    draft !== null &&
    current !== null &&
    (draft.title !== current.title || draft.body !== current.body)

  return (
    <div className="k-sync-instr">
      <p className="k-mkt-section-note">{t('sync.instructions.note')}</p>
      <div className="k-sync-lib">
        <div
          className="k-sync-lib__list"
          role="listbox"
          aria-label={t('sync.instructions.snippets')}
        >
          {state.snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              role="option"
              aria-selected={snippet.id === selected}
              className="k-sync-lib__item"
              onClick={() => {
                setSelected(snippet.id)
                setDraft(null)
              }}
            >
              <b>{snippet.title || t('sync.instructions.untitled')}</b>
              <span>{snippet.body.split('\n').find((line) => line.trim() !== '') ?? ''}</span>
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon icon={Add01Icon} size={14} />}
            onClick={add}
          >
            {t('sync.instructions.add')}
          </Button>
        </div>
        {editing ? (
          <div className="k-sync-lib__editor">
            <input
              className={DIALOG_FIELD}
              aria-label={t('sync.instructions.titleLabel')}
              value={editing.title}
              maxLength={SYNC_SNIPPET_TITLE_CHARS}
              onChange={(event) => setDraft({ ...editing, title: event.target.value })}
            />
            <Textarea
              className="k-sync-lib__body k-mkt-mono"
              aria-label={t('sync.instructions.bodyLabel')}
              placeholder={t('sync.instructions.bodyPlaceholder')}
              value={editing.body}
              maxLength={SYNC_SNIPPET_BODY_CHARS}
              onChange={(event) => setDraft({ ...editing, body: event.target.value })}
            />
            <div className="k-sync-lib__actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon icon={Delete02Icon} size={14} />}
                onClick={() => {
                  const rest = state.snippets.filter((s) => s.id !== editing.id)
                  setSelected(rest[0]?.id ?? null)
                  void save(rest)
                }}
              >
                {t('sync.instructions.delete')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!dirty}
                loading={saving}
                onClick={() =>
                  void save(state.snippets.map((s) => (s.id === editing.id ? editing : s)))
                }
              >
                {t('sync.instructions.save')}
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState
            bare
            title={t('sync.instructions.noneTitle')}
            text={t('sync.instructions.none')}
          />
        )}
      </div>
      {state.instructions.length > 0 && state.snippets.length > 0 && (
        <div className="k-sync-matrix">
          <table className="k-sync-table">
            <thead>
              <tr>
                <th scope="col" className="k-sync-rowhead">
                  {t('sync.instructions.snippet')}
                </th>
                {state.instructions.map((place) => (
                  <PlaceHead
                    key={place.id}
                    agentIds={place.agentIds}
                    path={place.id}
                    home={state.home}
                    note={place.problem ? problemText(place.problem) : undefined}
                  >
                    {!place.problem && (
                      <BlockState place={place} onOverwrite={() => overwrite(place)} />
                    )}
                  </PlaceHead>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.snippets.map((snippet) => (
                <tr key={snippet.id}>
                  <th scope="row" className="k-sync-rowhead">
                    <b className="k-sync-item__title">
                      {snippet.title || t('sync.instructions.untitled')}
                    </b>
                  </th>
                  {state.instructions.map((place) => {
                    const on = chosenFor(place, pending).includes(snippet.id)
                    return (
                      <CellBox
                        key={place.id}
                        checked={on}
                        changed={on !== place.snippetIds.includes(snippet.id)}
                        disabled={place.problem !== null}
                        label={t('sync.instructions.include', {
                          snippet: snippet.title,
                          agent: label(place.agentIds),
                        })}
                        onToggle={() => toggle(place, snippet.id)}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BlockState({
  place,
  onOverwrite,
}: {
  place: SyncInstructionsPlace
  onOverwrite: () => void
}) {
  const { t } = useTranslation('marketplace')
  const tone = place.block === 'synced' ? 'success' : place.block === 'none' ? 'neutral' : 'warning'
  return (
    <span className="k-sync-col__state">
      <Pill tone={tone}>{t(`sync.instructions.block.${place.block}`)}</Pill>
      {place.block === 'edited' && (
        <button type="button" className="k-sync-link" onClick={onOverwrite}>
          {t('sync.instructions.overwrite')}
        </button>
      )}
    </span>
  )
}

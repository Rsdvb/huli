// Marketplace › Sync: the MCP servers, skills and instructions each agent keeps in its own files,
// read from the host when the tab opens. Changes wait on the page until a preview shows each
// file's exact lines, and only a confirmed preview writes.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentSyncState, SyncPreview } from '@shared/agent-sync'
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Segmented } from '@renderer/features/settings/controls'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { InstructionsSection } from './instructions'
import { McpMatrix } from './mcp-matrix'
import { changesOf, NO_PENDING, pendingCounts, type Pending, type SyncSection } from './model'
import { PreviewDialog } from './preview-dialog'
import { SkillsMatrix } from './skills-matrix'
import './sync.css'

export default function SyncView({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [state, setState] = useState<AgentSyncState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [section, setSection] = useState<SyncSection>('mcp')
  const [pending, setPending] = useState<Pending>(NO_PENDING)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<SyncPreview | null>(null)

  // State is set only once the read answers, so the effect below sets nothing itself.
  const load = useCallback(
    () =>
      scope.request('sync.read', undefined).then(
        (next) => {
          setState(next)
          setError(null)
        },
        (e: unknown) => setError(errorMessage(e)),
      ),
    [scope],
  )

  const refresh = async () => {
    setReading(true)
    await load()
    setReading(false)
  }

  // Read each time the tab shows; nothing is read before.
  useEffect(() => {
    void load()
  }, [load])

  const changes = useMemo(() => (state ? changesOf(state, pending) : []), [state, pending])
  const counts = state ? pendingCounts(state, pending) : null

  const openPreview = async () => {
    if (changes.length === 0) return
    setPreviewing(true)
    try {
      setPreview(await scope.request('sync.preview', { changes }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setPreviewing(false)
    }
  }

  const label = (id: SyncSection, text: string) =>
    counts && counts[id] > 0 ? `${text} · ${counts[id]}` : text

  return (
    <section className="ui-as-int-section ui-as-rise k-sync" aria-label={t('sync.title')}>
      <div className="k-sync-head">
        <div className="k-sync-head__text">
          <h2 className="ui-as-int-section__title">{t('sync.title')}</h2>
          <p className="k-mkt-section-note">{t('sync.intro')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon icon={RefreshIcon} size={14} />}
          loading={reading}
          onClick={() => void refresh()}
        >
          {t('sync.refresh')}
        </Button>
      </div>
      <div className="k-sync-tabs">
        <Segmented
          label={t('sync.title')}
          value={section}
          onChange={setSection}
          options={[
            { value: 'mcp', label: label('mcp', t('sync.sections.mcp')) },
            { value: 'skills', label: label('skills', t('sync.sections.skills')) },
            {
              value: 'instructions',
              label: label('instructions', t('sync.sections.instructions')),
            },
          ]}
        />
      </div>
      {error && (
        <p role="alert" className="k-mkt-error k-sync-error">
          {t('sync.readFailed', { error })}
        </p>
      )}
      {!state ? (
        error ? null : (
          <div className="k-sync-loading" aria-busy>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )
      ) : section === 'mcp' ? (
        state.mcp.length === 0 ? (
          <EmptyState title={t('sync.mcp.noAgentsTitle')} text={t('sync.mcp.noAgents')} />
        ) : (
          <McpMatrix state={state} query={query} pending={pending} onChange={setPending} />
        )
      ) : section === 'skills' ? (
        state.skills.length === 0 ? (
          <EmptyState title={t('sync.skills.noneTitle')} text={t('sync.skills.none')} />
        ) : (
          <SkillsMatrix state={state} query={query} pending={pending} onChange={setPending} />
        )
      ) : (
        <InstructionsSection
          state={state}
          pending={pending}
          onChange={setPending}
          onSaved={(snippets) => {
            setState((current) => (current ? { ...current, snippets } : current))
            void load()
          }}
        />
      )}
      {changes.length > 0 && (
        <div className="k-sync-bar" role="status">
          <span>{t('sync.bar.count', { count: changes.length })}</span>
          <div className="k-sync-bar__actions">
            <Button size="md" variant="ghost" onClick={() => setPending(NO_PENDING)}>
              {t('sync.bar.discard')}
            </Button>
            <Button
              size="md"
              variant="primary"
              loading={previewing}
              onClick={() => void openPreview()}
            >
              {t('sync.bar.preview')}
            </Button>
          </div>
        </div>
      )}
      <PreviewDialog
        preview={preview}
        home={state?.home ?? ''}
        onClose={() => {
          setPreview(null)
          void load()
        }}
        onApplied={(written) => {
          setPreview(null)
          if (written) setPending(NO_PENDING)
          void load()
        }}
      />
    </section>
  )
}

// Marketplace › Sync › MCP servers: a row per server, a column per agent's file, and a box in each
// cell to add the server there or take it out.

import { useTranslation } from 'react-i18next'
import type { AgentSyncState, SyncMcpPlace, SyncServerView } from '@shared/agent-sync'
import { Pill } from '@renderer/features/settings/controls'
import { cellKey, serverRows, type Pending, type ServerRow } from './model'
import { useAgentsLabel, useProblemText } from './labels'
import { CellBox, PlaceHead } from './parts'

export function McpMatrix({
  state,
  query,
  pending,
  onChange,
}: {
  state: AgentSyncState
  query: string
  pending: Pending
  onChange: (next: Pending) => void
}) {
  const { t } = useTranslation('marketplace')
  const rows = serverRows(state.mcp, query)
  const label = useAgentsLabel()
  const problemText = useProblemText()

  const toggle = (row: ServerRow, place: SyncMcpPlace) => {
    const key = cellKey(row.name, place.id)
    const mcp = new Map(pending.mcp)
    if (mcp.has(key)) mcp.delete(key)
    else mcp.set(key, row.in.has(place.id) ? 'remove' : 'add')
    onChange({ ...pending, mcp })
  }

  return (
    <div className="k-sync-matrix">
      <table className="k-sync-table">
        <thead>
          <tr>
            <th scope="col" className="k-sync-rowhead">
              {t('sync.mcp.server')}
            </th>
            {state.mcp.map((place) => (
              <PlaceHead
                key={place.id}
                agentIds={place.agentIds}
                path={place.path}
                home={state.home}
                note={
                  place.problem
                    ? problemText(place.problem, place.detail)
                    : !place.exists
                      ? t('sync.newFile')
                      : place.unreadable.length > 0
                        ? t('sync.mcp.unreadable', {
                            count: place.unreadable.length,
                            names: place.unreadable.join(', '),
                          })
                        : undefined
                }
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={state.mcp.length + 1} className="k-sync-empty">
                {query ? t('sync.noMatch', { query }) : t('sync.mcp.none')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.name}>
                <th scope="row" className="k-sync-rowhead">
                  <ServerHead row={row} />
                </th>
                {state.mcp.map((place) => {
                  const has = row.in.has(place.id)
                  const action = pending.mcp.get(cellKey(row.name, place.id))
                  const takes = place.transports.includes(row.source.server.transport)
                  const blocked = place.problem !== null || (!has && !takes)
                  const agents = label(place.agentIds)
                  return (
                    <CellBox
                      key={place.id}
                      checked={action === 'add' || (has && action !== 'remove')}
                      changed={action !== undefined}
                      disabled={blocked}
                      label={
                        has
                          ? t('sync.mcp.removeFrom', { server: row.name, agent: agents })
                          : t('sync.mcp.addTo', { server: row.name, agent: agents })
                      }
                      title={
                        !has && !takes
                          ? t('sync.mcp.noTransport', {
                              agent: agents,
                              transport: t(`sync.transport.${row.source.server.transport}`),
                            })
                          : undefined
                      }
                      onToggle={() => toggle(row, place)}
                    />
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function ServerHead({ row }: { row: ServerRow }) {
  const { t } = useTranslation('marketplace')
  const server: SyncServerView = row.source.server
  const secrets = [...server.env, ...server.headers]
  return (
    <div className="k-sync-item">
      <span className="k-sync-item__title">
        <b>{row.name}</b>
        <Pill>{t(`sync.transport.${server.transport}`)}</Pill>
        {!server.enabled && <Pill tone="warning">{t('sync.mcp.disabled')}</Pill>}
        {row.differs && (
          <span title={t('sync.mcp.differsLine')}>
            <Pill tone="attention">{t('sync.mcp.differs')}</Pill>
          </span>
        )}
      </span>
      <span className="k-sync-item__line k-mkt-mono" title={server.target}>
        {server.target}
      </span>
      {secrets.length > 0 && (
        <span className="k-sync-item__line k-mkt-mono">
          {secrets.map((pair) => `${pair.name}=${pair.value}`).join('  ')}
        </span>
      )}
    </div>
  )
}

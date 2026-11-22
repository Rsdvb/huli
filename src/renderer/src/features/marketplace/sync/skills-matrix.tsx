// Marketplace › Sync › Skills: a row per skill folder, a column per skills folder the agents read,
// and Sync to, which copies a skill into the folders of the agents that do not have it yet.

import { useState } from 'react'
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentSyncState, SyncSkillPlace } from '@shared/agent-sync'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { cellKey, reachable, shortPath, skillRows, type Pending, type SkillRow } from './model'
import { useAgentsLabel } from './labels'
import { CellBox, PlaceHead } from './parts'

export function SkillsMatrix({
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
  const label = useAgentsLabel()
  const rows = skillRows(state.skills, query)
  const places = state.skills

  const set = (row: SkillRow, place: SyncSkillPlace, on: boolean) => {
    const skills = new Set(pending.skills)
    if (on) skills.add(cellKey(row.name, place.id))
    else skills.delete(cellKey(row.name, place.id))
    onChange({ ...pending, skills })
  }
  /** The folders a copy can go to: an agent's own, without the skill, that no agent reads it from. */
  const targets = (row: SkillRow) =>
    places.filter(
      (place) => place.owners.length > 0 && !row.in.has(place.id) && !reachable(row, place, places),
    )

  return (
    <div className="k-sync-matrix">
      <table className="k-sync-table">
        <thead>
          <tr>
            <th scope="col" className="k-sync-rowhead">
              {t('sync.skills.skill')}
            </th>
            {places.map((place) => (
              <PlaceHead
                key={place.id}
                agentIds={place.owners.length > 0 ? place.owners : place.readers}
                path={place.id}
                home={state.home}
                note={
                  place.owners.length === 0
                    ? t('sync.skills.readOnly', { agents: label(place.readers) })
                    : place.readers.length > 0
                      ? t('sync.skills.alsoRead', { agents: label(place.readers) })
                      : undefined
                }
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={places.length + 1} className="k-sync-empty">
                {query ? t('sync.noMatch', { query }) : t('sync.skills.none')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.name}>
                <th scope="row" className="k-sync-rowhead">
                  <div className="k-sync-item">
                    <span className="k-sync-item__title">
                      <b>{row.skill.title}</b>
                      {row.skill.title !== row.name && (
                        <span className="k-sync-item__aside k-mkt-mono">{row.name}</span>
                      )}
                    </span>
                    {row.skill.description && (
                      <span className="k-sync-item__line" title={row.skill.description}>
                        {row.skill.description}
                      </span>
                    )}
                    <SyncTo
                      row={row}
                      targets={targets(row)}
                      pending={pending}
                      home={state.home}
                      set={set}
                    />
                  </div>
                </th>
                {places.map((place) => {
                  if (row.in.has(place.id)) {
                    return (
                      <td key={place.id} className="k-sync-cell" title={t('sync.skills.has')}>
                        <span className="k-sync-has">
                          <Icon icon={Tick02Icon} size={14} />
                        </span>
                      </td>
                    )
                  }
                  if (place.owners.length === 0) {
                    return <td key={place.id} className="k-sync-cell k-sync-cell--none" />
                  }
                  if (reachable(row, place, places)) {
                    return (
                      <td key={place.id} className="k-sync-cell" title={t('sync.skills.reachable')}>
                        <span className="k-sync-via">{t('sync.skills.via')}</span>
                      </td>
                    )
                  }
                  const on = pending.skills.has(cellKey(row.name, place.id))
                  return (
                    <CellBox
                      key={place.id}
                      checked={on}
                      changed={on}
                      label={t('sync.skills.copyTo', {
                        skill: row.skill.title,
                        agent: label(place.owners),
                      })}
                      onToggle={() => set(row, place, !on)}
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

/** Sync to: the folders a skill can be copied into, each with a box. */
function SyncTo({
  row,
  targets,
  pending,
  home,
  set,
}: {
  row: SkillRow
  targets: SyncSkillPlace[]
  pending: Pending
  home: string
  set: (row: SkillRow, place: SyncSkillPlace, on: boolean) => void
}) {
  const { t } = useTranslation('marketplace')
  const label = useAgentsLabel()
  const [open, setOpen] = useState(false)
  if (targets.length === 0) return null
  return (
    <span className="ui-as-anchor k-sync-syncto">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        iconRight={<Icon icon={ArrowDown01Icon} size={12} />}
        onClick={() => setOpen((value) => !value)}
      >
        {t('sync.skills.syncTo')}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} className="ui-as-menu k-sync-pop">
        <div className="k-sync-pop__body">
          <b>{t('sync.skills.syncToTitle', { skill: row.skill.title })}</b>
          {targets.map((place) => {
            const on = pending.skills.has(cellKey(row.name, place.id))
            return (
              <label key={place.id} className="k-sync-pop__row">
                <Checkbox checked={on} onCheckedChange={(next) => set(row, place, next === true)} />
                <span>
                  {label(place.owners)}
                  <span className="k-sync-pop__path k-mkt-mono">{shortPath(place.id, home)}</span>
                </span>
              </label>
            )
          })}
        </div>
      </Popover>
    </span>
  )
}

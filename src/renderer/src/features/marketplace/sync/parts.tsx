// Marketplace › Sync's shared parts: a place's column head and a matrix's cell checkbox.

import type { ReactNode } from 'react'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAgentsLabel } from './labels'
import { shortPath } from './model'

/** A column's head: the agents that use the place, its path, and what else it says. */
export function PlaceHead({
  agentIds,
  path,
  home,
  note,
  children,
}: {
  agentIds: readonly AgentId[]
  path: string
  home: string
  note?: string
  children?: ReactNode
}) {
  const { hostId } = useHostScope()
  const label = useAgentsLabel()
  return (
    <th scope="col" className="k-sync-col" title={path}>
      <span className="k-sync-col__agents">
        {agentIds.slice(0, 3).map((agent) => (
          <AgentMark key={agent} agent={agent} size={14} hostId={hostId} />
        ))}
        <span className="k-sync-col__name">{label(agentIds)}</span>
      </span>
      <span className="k-sync-col__path k-mkt-mono">{shortPath(path, home)}</span>
      {note && <span className="k-sync-col__note">{note}</span>}
      {children}
    </th>
  )
}

/** A matrix cell's box: what the place has, and whether that is a change waiting on the page. */
export function CellBox({
  checked,
  changed,
  disabled,
  label,
  title,
  onToggle,
}: {
  checked: boolean
  changed: boolean
  disabled?: boolean
  label: string
  title?: string
  onToggle: () => void
}) {
  return (
    <td className="k-sync-cell" data-changed={changed || undefined} title={title}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={() => onToggle()}
      />
    </td>
  )
}

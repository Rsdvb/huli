import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadEntry } from '@shared/thread'
import { ToolCallCard, type ToolCallLabels } from '@renderer/components/affect/tool-call-card'
import { cn } from '@renderer/lib/utils'
import { isFresh } from '@renderer/stores/threads'
import { thoughtTitle, toolLabel } from './helpers'
import { MemoryStep } from './memory-entry'
import { entryPictures } from './row-pictures'
import { RowThumbs } from './row-thumbs'
import { ThoughtBody, ToolBody, ToolSummary } from './tool-call-parts'
import { toolHasBody, type StepFacts } from './tool-call-model'
import { useOpenedOnce } from './use-opened'

/**
 * Stands in for a step's card while its group is folded. The group's line reads the icon, status
 * and times off its children's props, so it needs them even when nothing is drawn.
 */
export function StepStub(props: Omit<StepFacts, 'glyph'> & { icon: ReactNode }): null {
  void props
  return null
}

/**
 * A step of the thread's work on affectUI's Tool Call Card: a tool call, a thought or a project
 * memory write. Its facts come as props of their own (tool-call-model.ts), which a group reads.
 * `note` follows a tool call's target; a call a routine allowed says so by default. Its content
 * renders once the card first opens; until then the body is null, since false would leave the card
 * without one. A step on its own leads with its chevron, as the runs around it do; on a run's
 * `rail` the chevron closes the row.
 */
export function StepCard({
  sessionId,
  entry,
  projectPath,
  labels,
  note,
  rail = false,
  status,
  startedAt,
  duration,
  time,
  icon,
  late = false,
}: Omit<StepFacts, 'glyph'> & {
  sessionId: string
  entry: ThreadEntry
  projectPath: string
  labels: Partial<ToolCallLabels>
  note?: string
  rail?: boolean
  icon: ReactNode
  /** Mounted after its run first opened, out of view, so it takes no part in the entrance. */
  late?: boolean
}) {
  const { t } = useTranslation('session')
  // A step that arrived while shown draws its part of a run's timeline in (session.css).
  const [fresh] = useState(() => isFresh(sessionId, entry.id))
  const [opened, onOpenChange, opening] = useOpenedOnce(status)
  const facts = {
    status,
    startedAt,
    duration,
    time,
    icon,
    labels,
    chevron: rail ? ('after' as const) : ('before' as const),
    className:
      cn(fresh && 'ks-step-new', opening && 'ks-step-opening', late && 'ks-step-late') || undefined,
    shine: true,
    onOpenChange,
  }
  if (entry.kind === 'tool') {
    const label = toolLabel(entry, projectPath, entry.status === 'completed')
    const pictures = entryPictures(entry)
    const result = entry.permissionResult
    if (note === undefined && typeof result === 'object' && result?.by === 'routine') {
      note = t('permission.answer.allowedByRoutine')
    }
    // Huli: what the host allowed by itself says so, with the level it judged.
    if (note === undefined && typeof result === 'object' && result?.by === 'risk') {
      note = t('permission.answer.autoApproved', {
        level: t(`permission.risk.${result.risk?.level ?? 'low'}`),
      })
    }
    // Huli: manager mode's guard, or the manager's agent, answered it.
    if (note === undefined && typeof result === 'object' && result?.by === 'readonly') {
      note = t(
        result.kind === 'allow_once'
          ? 'permission.answer.readOnlyAllowed'
          : 'permission.answer.readOnlyDenied',
      )
    }
    if (note === undefined && typeof result === 'object' && result?.by === 'manager') {
      note = t(
        result.kind === 'allow_once'
          ? 'permission.answer.managerAllowed'
          : 'permission.answer.managerDenied',
      )
    }
    // Huli: a denied call reads Denied, not Cancelled, and says what denied it.
    const denial = entry.denied
    const appeal = entry.review?.status === 'denied' ? entry.review.appeal : undefined
    if (note === undefined && appeal) {
      note = t(appeal.allowed ? 'tool.appeal.noteAllowed' : 'tool.appeal.note')
    }
    if (note === undefined && denial && denial.by !== 'user') note = t(`tool.deniedBy.${denial.by}`)
    // Huli: how far a running call says it got.
    const running = entry.status === 'pending' || entry.status === 'in_progress'
    if (note === undefined && running && entry.progress) note = entry.progress
    const review = entry.review
    if (
      note === undefined &&
      review &&
      (review.status === 'approved' || review.status === 'reviewing')
    ) {
      note = review.risk
        ? t(`tool.review.${review.status}Risk`, { risk: t(`tool.review.risk.${review.risk}`) })
        : t(`tool.review.${review.status}`)
    }
    const cardLabels = denial ? { ...labels, cancelled: t('status.denied') } : labels
    return (
      <ToolCallCard
        {...facts}
        labels={cardLabels}
        name={label.verb ?? label.target ?? entry.title}
        summary={
          label.verb && label.target ? (
            <ToolSummary entry={entry} target={label.target} note={note} />
          ) : (
            note
          )
        }
        trail={
          pictures.length > 0 ? <RowThumbs sessionId={sessionId} pictures={pictures} /> : undefined
        }
      >
        {toolHasBody(entry, projectPath) ? (
          opened ? (
            <ToolBody sessionId={sessionId} entryId={entry.id} projectPath={projectPath} />
          ) : null
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  if (entry.kind === 'memory') {
    return <MemoryStep sessionId={sessionId} entry={entry} card={facts} />
  }
  if (entry.kind === 'thought') {
    return (
      <ToolCallCard
        {...facts}
        name={t('summary.thought')}
        summary={thoughtTitle(entry.markdown) ?? undefined}
      >
        {entry.markdown.trim() ? (
          opened ? (
            <ThoughtBody sessionId={sessionId} entryId={entry.id} />
          ) : null
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  return null
}

import { useEffect, useMemo } from 'react'
import { EyeIcon, GitMergeIcon, RadioButtonIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { GitHubReference } from '@shared/git'
import type { PrFlowState, SessionIssue, SessionPrFlow } from '@shared/github-flow'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { loadReference } from '@renderer/stores/git'
import { ReferenceHoverCard, ReferenceIcon } from './gh-reference'
import { useReferenceData } from './gh-reference-data'

function issueReference(issue: SessionIssue): GitHubReference {
  return {
    kind: 'issue',
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    url: issue.url,
  }
}

/** The issue a session was started for, as a chip in its top bar that opens it and shows its card. */
export function IssueBarChip({ issue }: { issue: SessionIssue }) {
  const { t } = useTranslation('git')
  const reference = useMemo(() => issueReference(issue), [issue])
  const { data } = useReferenceData(reference)
  useEffect(() => loadReference(reference), [reference])
  const chip = (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      aria-label={t('issues.linked', { number: issue.number })}
      className="ks-chip app-region-no-drag"
    >
      <ReferenceIcon kind="issue" data={data} size={13} className="text-current" />
      <span className="tabular">#{issue.number}</span>
    </a>
  )
  return <ReferenceHoverCard reference={reference} trigger={chip} />
}

const STATE_TONE: Partial<Record<PrFlowState, string>> = {
  checks_failed: 'text-danger',
  conflict: 'text-danger',
  failed: 'text-danger',
  changes_requested: 'text-warning',
  merged: 'text-merged',
}

/**
 * What the session's pull request automation sees now, as a chip in its top bar: merging once the
 * checks pass, or watching, with the state the last read found.
 */
export function PrFlowChip({ flow }: { flow: SessionPrFlow }) {
  const { t } = useTranslation('git')
  const state = flow.state
    ? t(`prFlow.state.${flow.state}`)
    : flow.autoMerge
      ? t('prFlow.state.waiting')
      : t('prFlow.watching')
  const label = t('prFlow.chip', { number: flow.number, state })
  const detail = [
    flow.autoMerge && t('prFlow.autoMergeOn', { number: flow.number }),
    flow.watch && t('prFlow.watchOn'),
    flow.message,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn('ks-chip app-region-no-drag', flow.state && STATE_TONE[flow.state])}
          />
        }
      >
        <Glyph icon={flow.autoMerge ? GitMergeIcon : EyeIcon} size={13} />
        <span className="ks-chip__text text-current">{state}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <span className="block font-medium">{label}</span>
        {detail && <span className="mt-0.5 block">{detail}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/** A session's linked issue on its row: the issue's icon, and its card on hover. */
export function IssueBadge({ issue, onEnter }: { issue: SessionIssue; onEnter: () => void }) {
  const { t } = useTranslation('sidebar')
  const reference = useMemo(() => issueReference(issue), [issue])
  const { data } = useReferenceData(reference)
  const badge = (
    <span
      role="img"
      aria-label={t('row.issue', { number: issue.number })}
      onPointerEnter={onEnter}
      className="relative inline-flex h-5 shrink-0 items-center rounded-[5px] px-[3px] text-tertiary hover:bg-selected data-popup-open:bg-selected"
    >
      {data ? (
        <ReferenceIcon kind="issue" data={data} size={13} />
      ) : (
        <Glyph icon={RadioButtonIcon} size={13} />
      )}
    </span>
  )
  return <ReferenceHoverCard reference={reference} side="right" trigger={badge} />
}

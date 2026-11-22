// Huli: which pull request a session's automation is for, and its switches.

import type { SessionSummary } from '@shared/agent-host'
import type { PullRequest } from '@shared/git'
import type { PrFlowState, SessionPrFlow } from '@shared/github-flow'
import { toast } from '@renderer/components/ui/toast'
import { sessionPullRequests } from '@renderer/features/sidebar/session-prs'
import { errorMessage, host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'

/** Huli: the states after which a session's pull request automation does nothing more. */
const ENDED: readonly (PrFlowState | null)[] = ['merged', 'closed', 'failed']

/** Whether the session's automation still runs, merging or watching. */
export function prFlowActive(flow: SessionPrFlow | null | undefined): boolean {
  return !!flow && !ENDED.includes(flow.state)
}

/**
 * The pull request a session's automation is for: the one it automates now, else its first open
 * one, else its folder's branch's open one.
 */
export function prFlowTarget(
  summary: SessionSummary,
  current: PullRequest | null,
): { url: string; number: number } | null {
  if (summary.prFlow && prFlowActive(summary.prFlow)) return summary.prFlow
  const live = sessionPullRequests(summary).find(
    (pr) => pr.state === 'open' || pr.state === 'draft',
  )
  if (live) return live
  if (current && (current.state === 'open' || current.state === 'draft')) return current
  return null
}

/** Turns one switch of the session's automation for `url`, and shows the host's word on it. */
export function setPrFlow(
  sessionId: string,
  url: string,
  change: { autoMerge: boolean } | { watch: boolean },
): void {
  void host('sessions.setPrFlow', { sessionId, url, ...change })
    .then((summary) => useSessionsStore.getState().upsert(summary))
    .catch((error: unknown) => toast(errorMessage(error)))
}

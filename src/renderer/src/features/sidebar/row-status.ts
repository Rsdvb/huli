import type { SessionNode } from '@renderer/stores/sessions'

/** What a row's status slot can show. */
export interface RowStatus {
  /** Permission requests waiting for an answer. */
  waiting: number
  failed: boolean
  running: boolean
  starting: boolean
  unread: boolean
  /** Huli: stopped at its plan limit, to go on by itself once the plan resets. */
  paused?: boolean
}

const failed = (node: SessionNode): boolean =>
  node.summary.attention === 'error' || node.summary.status === 'failed'

/**
 * A row's status: its own, with its sub-agents' waits and runs; with `rolledUp`, as a collapsed
 * parent shows it, the loudest of it and its sub-sessions.
 */
export function rowStatus(node: SessionNode, rolledUp: boolean): RowStatus {
  const own: RowStatus = {
    waiting: node.own.permissionCount,
    failed: failed(node),
    running: node.own.running,
    starting: node.summary.status === 'starting',
    unread: node.summary.attention === 'unread',
    paused: Boolean(node.summary.limitPause),
  }
  if (!rolledUp || node.children.length === 0) return own
  return {
    waiting: node.permissionCount,
    failed: own.failed || node.children.some(failed),
    running: node.running,
    starting: own.starting,
    unread: own.unread || node.children.some((child) => child.summary.attention === 'unread'),
    paused: own.paused,
  }
}

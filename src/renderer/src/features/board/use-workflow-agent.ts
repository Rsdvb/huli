import { useEffect, useState } from 'react'
import type { WorkflowAgentDetail, WorkflowAgentView } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'

export interface WorkflowAgentRead {
  detail: WorkflowAgentDetail | null
  error: string | null
}

const UNREAD: WorkflowAgentRead = { detail: null, error: null }

/**
 * What one agent of a workflow was asked and gave back, read while its row is open: at once, and
 * again when its state changes, as when it ends. Never on a timer.
 */
export function useWorkflowAgent(
  sessionId: string,
  taskId: string,
  index: number,
  state: WorkflowAgentView['state'],
  enabled: boolean,
): WorkflowAgentRead {
  const [read, setRead] = useState<WorkflowAgentRead>(UNREAD)
  useEffect(() => {
    if (!enabled) return
    let current = true
    host('sessions.workflowAgent', { sessionId, taskId, index })
      .then((detail) => {
        if (current) setRead({ detail, error: null })
      })
      .catch((error: unknown) => {
        if (current) setRead((prev) => ({ ...prev, error: errorMessage(error) }))
      })
    return () => {
      current = false
    }
  }, [sessionId, taskId, index, state, enabled])
  return read
}

// Huli: Kite's own Node.js as the window sees it: whether an agent waits for Node.js, what the
// host says of its Node.js, and starting or stopping the host's install of it.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, NodeRuntimeInfo, NodeTask } from '@shared/agent-host'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'

/** Waiting for Node.js: missing, or older than the agent needs. */
export function needsNode(status: Pick<AgentStatus, 'state'>): boolean {
  return status.state === 'node-missing' || status.state === 'node-outdated'
}

/** The host's Node.js as it last said, or null for a host without Kite's own install. */
export function useNodeRuntime(scope?: HostScope): NodeRuntimeInfo | null {
  const own = useHostScope()
  const { useAgentsStore } = scope ?? own
  return useAgentsStore((s) => s.environment?.node ?? null)
}

/** Starts and stops the host's install; a refused request's error, which no task carries. */
export function useNodeInstall(scope?: HostScope) {
  const own = useHostScope()
  const { request, useAgentsStore } = scope ?? own
  const { t } = useTranslation('agents')
  const node = useNodeRuntime(scope)
  const [error, setError] = useState<string | null>(null)
  const task = node?.task ?? null
  const running = task?.state === 'running'
  const install = () => {
    setError(null)
    void request('environment.installNode', undefined).then(
      (result) => {
        toast(
          t(result.installed ? 'node.done' : 'node.upToDate', { version: result.version }),
          undefined,
          {
            tone: 'success',
          },
        )
        void useAgentsStore
          .getState()
          .refresh()
          .catch(() => {})
      },
      (failure: unknown) => {
        // The host keeps a failed install's reason as its task; the request's says the same.
        if (useAgentsStore.getState().environment?.node?.task?.state !== 'failed') {
          setError(errorMessage(failure))
        }
      },
    )
  }
  const cancel = () => {
    setError(null)
    void request('environment.cancelNodeInstall', undefined).catch(() => {})
  }
  const failure = task?.state === 'failed' ? task.error : error
  return { node, task, running, install, cancel, failure }
}

/** What the install is doing, in a few words. */
export function nodePhaseText(t: ReturnType<typeof useTranslation<'agents'>>['t'], task: NodeTask) {
  return t(`node.phase.${task.phase}`, { version: task.version ?? '' })
}

// Huli: Kite's own Node.js as the window sees it: whether an agent waits for Node.js, what the
// host says of its Node.js, and starting or stopping the host's install of it.

import { useRef, useState } from 'react'
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
  // A stop this window asked for ends the request with an error that is no failure to show.
  const stopped = useRef(false)
  const task = node?.task ?? null
  const running = task?.state === 'running'
  const install = () => {
    setError(null)
    stopped.current = false
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
        if (
          !stopped.current &&
          useAgentsStore.getState().environment?.node?.task?.state !== 'failed'
        ) {
          setError(errorMessage(failure))
        }
      },
    )
  }
  const cancel = () => {
    setError(null)
    stopped.current = true
    void request('environment.cancelNodeInstall', undefined).catch(() => {})
  }
  /** Clears a failure: the host's failed install or removal, or a refusal this window heard. */
  const dismiss = () => {
    setError(null)
    if (task?.state === 'failed') {
      void request('environment.cancelNodeInstall', undefined).catch(() => {})
    }
  }
  const failure = task?.state === 'failed' ? task.error : error
  return { node, task, running, install, cancel, dismiss, failure }
}

/** What the install is doing, in a few words. */
export function nodePhaseText(t: ReturnType<typeof useTranslation<'agents'>>['t'], task: NodeTask) {
  return t(`node.phase.${task.phase}`, { version: task.version ?? '' })
}

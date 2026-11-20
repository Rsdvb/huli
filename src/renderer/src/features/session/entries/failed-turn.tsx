import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { retryableTurn } from '@shared/thread'
import { continueWith, retryTurn } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import { errorMessage } from '@renderer/lib/host'
import { limitPercent } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { useFallback } from '../plan-quota'
import { FailedActions } from '../session-states'

/**
 * Retry and Report a problem under the notice of a failed turn, while it ends the latest turn and
 * the session is free. Retry sends the turn's message again under its own entry. A turn the plan
 * limit stopped also offers to go on with the agent whose plan has the most room.
 */
export function FailedTurnActions({
  sessionId,
  entryId,
  error,
  planLimit = false,
}: {
  sessionId: string
  entryId: string
  /** What the report carries as the error. */
  error: string
  /** The agent's plan refused the turn. */
  planLimit?: boolean
}) {
  const { t } = useTranslation('session')
  const prompt = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state || state.session.origin === 'subagent') return null
    const { status } = state.session
    // Checked first, so a streaming turn never walks the thread here.
    if (status !== 'ready' && status !== 'closed') return null
    const turn = retryableTurn(state)
    return turn?.notice.id === entryId ? turn.prompt : null
  })
  const agentId = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.agentId)
  const hostId = useSessionsStore((s) => {
    const summary = s.byId[sessionId]
    return summary ? hostOfSession(summary) : null
  })
  const now = useNow()
  const view = useLimitView()
  const fallback = useFallback(hostId, agentId ?? null, planLimit && !!prompt, now)
  const [retrying, setRetrying] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (!prompt) return null
  const retry = () => {
    setRetrying(true)
    setFailed(null)
    // Held after a success: the actions go once the turn that starts reaches the replica.
    retryTurn(sessionId, prompt.content).catch((e: unknown) => {
      setFailed(errorMessage(e))
      setRetrying(false)
    })
  }
  const carryOn = () => {
    if (!fallback) return
    setContinuing(true)
    setFailed(null)
    continueWith(sessionId, fallback.agentId, prompt.content).catch((e: unknown) => {
      setFailed(errorMessage(e))
      setContinuing(false)
    })
  }
  const busy = retrying || continuing
  return (
    <>
      <FailedActions
        className="col-start-2 mt-2"
        onRetry={retry}
        retrying={busy}
        report={{ hostId, sessionId, ...(agentId ? { agentId } : {}) }}
        origin="turn"
        error={error}
        lead={
          fallback && (
            <Tooltip>
              <TooltipTrigger render={<Button size="compact" disabled={busy} onClick={carryOn} />}>
                {continuing ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <AgentMark agent={fallback.agentId} size={12} />
                )}
                {t('quota.continueWith', { agent: fallback.name })}
              </TooltipTrigger>
              <TooltipContent>
                {t(view === 'left' ? 'quota.continueHintLeft' : 'quota.continueHint', {
                  agent: fallback.name,
                  percent: limitPercent(fallback, view),
                })}
              </TooltipContent>
            </Tooltip>
          )
        }
      />
      {failed && <p className="col-start-2 mt-1 text-small text-danger">{failed}</p>}
    </>
  )
}

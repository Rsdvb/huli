import { memo } from 'react'
import { DashboardSquare01Icon, Shield01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ComputerAppAnswer } from '@shared/computer-use'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

const ANSWER_TEXT = {
  session: 'computerApp.answer.session',
  always: 'computerApp.answer.always',
  deny: 'computerApp.answer.deny',
  timeout: 'computerApp.answer.timeout',
} as const satisfies Record<ComputerAppAnswer, string>

const ELEVATED_ANSWER = {
  session: 'computerApp.elevated.answer.allow',
  always: 'computerApp.elevated.answer.allow',
  deny: 'computerApp.elevated.answer.deny',
  timeout: 'computerApp.answer.timeout',
} as const satisfies Record<ComputerAppAnswer, string>

/**
 * An agent asked to use an app on the user's computer for the first time in its session; or, in
 * Huli, to drive an app run as administrator, which has no Always allow and is answered only on
 * this computer.
 */
export const ComputerAppEntry = memo(function ComputerAppEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'computer_app')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const app = entry.appName
  const request = (decision: 'session' | 'always' | 'deny') =>
    host('computer.answerApp', { sessionId, entryId: entry.id, decision })
  if (entry.ask === 'elevated') {
    return (
      <AccessCard
        sessionId={sessionId}
        entryId={entryId}
        agentName={agentName}
        className={animation}
        action={t('computerApp.elevated.action', { app })}
        target={app}
        glyph={Shield01Icon}
        reason={t('computerApp.elevated.where', { app })}
        answer={entry.decision}
        device={entry.device}
        risk="risky"
        trailing={null}
        words={{
          allow: { session: t('computerApp.elevated.allow'), always: '' },
          deny: t('computerApp.elevated.deny'),
          answer: (a) => t(ELEVATED_ANSWER[a as ComputerAppAnswer] ?? ELEVATED_ANSWER.deny),
        }}
        request={request}
      />
    )
  }
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.app')}
      target={app}
      glyph={DashboardSquare01Icon}
      reason={t('computerApp.where')}
      answer={entry.decision}
      device={entry.device}
      words={{
        allow: {
          session: t('computerApp.decision.session'),
          always: t('computerApp.decision.always', { app }),
        },
        deny: t('computerApp.decision.deny'),
        answer: (a) => t(ANSWER_TEXT[a as ComputerAppAnswer] ?? ANSWER_TEXT.deny),
      }}
      request={request}
    />
  )
})

import { memo } from 'react'
import { DashboardSquare01Icon, Shield01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ComputerAppAnswer } from '@shared/computer-use'
import type { ComputerRiskyStep } from '@shared/thread'
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

const RISKY_ANSWER = {
  session: 'computerApp.risky.answer.allow',
  always: 'computerApp.risky.answer.allow',
  deny: 'computerApp.risky.answer.deny',
  timeout: 'computerApp.answer.timeout',
} as const satisfies Record<ComputerAppAnswer, string>

const STEP_TEXT = {
  click: 'computerApp.risky.step.click',
  type: 'computerApp.risky.step.type',
  key: 'computerApp.risky.step.key',
  drag: 'computerApp.risky.step.drag',
  menu: 'computerApp.risky.step.menu',
} as const satisfies Record<ComputerRiskyStep['kind'], string>

/**
 * An agent asked to use an app on the user's computer for the first time in its session; or, in
 * Huli, to drive an app run as administrator, or to take a risky step in one. Those two have no
 * Always allow and are answered only on this computer.
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
  if (entry.ask === 'elevated' || entry.ask === 'risky') {
    const elevated = entry.ask === 'elevated'
    const step = entry.step ?? null
    const answers = elevated ? ELEVATED_ANSWER : RISKY_ANSWER
    return (
      <AccessCard
        sessionId={sessionId}
        entryId={entryId}
        agentName={agentName}
        className={animation}
        action={t(elevated ? 'computerApp.elevated.action' : 'computerApp.risky.action', { app })}
        target={
          elevated
            ? app
            : step
              ? t(STEP_TEXT[step.kind], { text: step.text ?? '' })
              : t('computerApp.risky.step.unknown')
        }
        glyph={Shield01Icon}
        reason={t(elevated ? 'computerApp.elevated.where' : 'computerApp.risky.where', { app })}
        answer={entry.decision}
        device={entry.device}
        risk={elevated ? 'risky' : 'destructive'}
        trailing={null}
        words={{
          allow: {
            session: t(elevated ? 'computerApp.elevated.allow' : 'computerApp.risky.allow'),
            always: '',
          },
          deny: t(elevated ? 'computerApp.elevated.deny' : 'computerApp.risky.deny'),
          answer: (a) => t(answers[a as ComputerAppAnswer] ?? answers.deny),
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

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  EVENT_BRANCH_CHARS,
  EVENT_LABEL_CHARS,
  GITHUB_EVENT_KINDS,
  isBranchName,
  type GithubEvent,
  type GithubEventKind,
} from '@shared/github-flow'
import type { RoutineTrigger, Schedule } from '@shared/routines'
import { Row, Select } from './kit'

type Kind = RoutineTrigger['kind']

/** A new event of a kind, its branch or label carried over from the one it replaces. */
function eventOf(kind: GithubEventKind, from: GithubEvent | null): GithubEvent {
  const branch = from && 'branch' in from ? from.branch : 'main'
  switch (kind) {
    case 'issue_opened':
      return { kind, label: from?.kind === 'issue_opened' ? from.label : null }
    case 'pr_opened':
    case 'checks_failed':
      return { kind }
    case 'pushed':
    case 'behind':
      return { kind, branch }
  }
}

/**
 * Huli: when a routine runs: on its schedule, which the schedule card below sets, on a GitHub
 * event in its project's repository, with the label or branch the event takes, or on a request
 * to its webhook, which the webhook card below sets up.
 */
export function TriggerField({
  trigger,
  onTrigger,
  noProject,
  github,
}: {
  trigger: RoutineTrigger
  onTrigger: (trigger: RoutineTrigger) => void
  /** The routine works in no project, which a GitHub event needs. */
  noProject: boolean
  /** GitHub events are offered: GitHub automation is on, or the routine runs on one. */
  github: boolean
}) {
  const { t } = useTranslation('routines')
  const schedule: Schedule = trigger.schedule
  const event = trigger.kind === 'github' ? trigger.event : null
  const kindOptions: { value: Kind; label: string }[] = [
    { value: 'schedule', label: t('on.schedule') },
    ...(github ? [{ value: 'github' as const, label: t('on.github') }] : []),
    { value: 'webhook', label: t('on.webhook') },
  ]
  const eventOptions = GITHUB_EVENT_KINDS.map((kind) => ({
    value: kind,
    label: t(`on.events.${kind}`),
  }))

  return (
    <div className="ui-sg-card">
      <Row
        title={t('on.kind')}
        note={event ? t('on.hint') : trigger.kind === 'webhook' ? t('on.webhookHint') : undefined}
      >
        <Select
          label={t('on.kind')}
          value={trigger.kind}
          options={kindOptions}
          onChange={(kind) =>
            onTrigger(
              kind === 'github'
                ? { kind, event: { kind: 'issue_opened', label: null }, schedule }
                : kind === 'webhook'
                  ? { kind, schedule }
                  : { kind, schedule },
            )
          }
        />
      </Row>
      {event && (
        <>
          <Row title={t('on.event')} note={noProject ? t('on.needsProject') : undefined}>
            <Select
              label={t('on.event')}
              value={event.kind}
              options={eventOptions}
              width={280}
              onChange={(kind) =>
                onTrigger({ kind: 'github', event: eventOf(kind, event), schedule })
              }
            />
          </Row>
          {event.kind === 'issue_opened' && (
            <Row title={t('on.label')} note={t('on.labelHint')}>
              <TextValue
                key={`label:${event.label ?? ''}`}
                value={event.label ?? ''}
                maxLength={EVENT_LABEL_CHARS}
                label={t('on.label')}
                placeholder="bug"
                valid={(value) => !/[\n\r,]/.test(value)}
                onCommit={(value) =>
                  onTrigger({
                    kind: 'github',
                    event: { kind: 'issue_opened', label: value.trim() || null },
                    schedule,
                  })
                }
              />
            </Row>
          )}
          {(event.kind === 'pushed' || event.kind === 'behind') && (
            <Row title={t('on.branch')} note={t('on.branchHint')}>
              <TextValue
                key={`branch:${event.branch}`}
                value={event.branch}
                maxLength={EVENT_BRANCH_CHARS}
                label={t('on.branch')}
                placeholder="main"
                valid={(value) => isBranchName(value.trim())}
                onCommit={(value) =>
                  onTrigger({
                    kind: 'github',
                    event: { kind: event.kind, branch: value.trim() },
                    schedule,
                  })
                }
              />
            </Row>
          )}
        </>
      )}
    </div>
  )
}

/** A short text that is committed when it loses the focus or Enter is pressed, if it reads. */
function TextValue({
  value,
  maxLength,
  label,
  placeholder,
  valid,
  onCommit,
}: {
  value: string
  maxLength: number
  label: string
  placeholder: string
  valid: (value: string) => boolean
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState(value)
  const ok = valid(text)
  const commit = (): void => {
    if (ok && text.trim() !== value) onCommit(text)
  }
  return (
    <input
      className="ui-sg-input k-trigger-input"
      value={text}
      maxLength={maxLength}
      aria-label={label}
      aria-invalid={!ok || undefined}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(change) => setText(change.target.value)}
      onBlur={commit}
      onKeyDown={(key) => {
        if (key.key === 'Enter' && !key.nativeEvent.isComposing && key.keyCode !== 229) commit()
      }}
    />
  )
}

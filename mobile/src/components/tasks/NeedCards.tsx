// What waits for the user on a task, a card each in the order it came, as the desktop's needs.tsx:
// a hand-in to approve or send back, a step of the user's own to answer with an outcome, a step's
// agent asking in its session, a step that cannot start (retry, or pin another agent), a stuck
// step, and a branch that would not merge at the end.

import { useState, type ReactNode } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentId } from '@shared/agents'
import type { RoundView, TaskNeed, TaskView } from '@shared/workflow'
import { useComments } from '../../artifact-view/comments'
import { useAgents, useMaybeLink } from '../../host'
import { errorText } from '../../sessions'
import { haptic } from '../../ui/haptics'
import { blockedText, canDoSteps, stepTitle, STUCK_TEXT, taskRequest } from '../../tasks'
import { Clamp } from '../../ui/session/Clamp'
import { MONO } from '../../ui/session/palette'
import { space, type as typeScale, useTokens } from '../../ui/tokens'
import { Markdown } from '../Markdown'
import { Sheet, type SheetItem } from '../Sheet'
import { Actions, ActionButton, DocumentChip, NeedCard, NoteField, useRequest } from './parts'

function needKey(need: TaskNeed): string {
  switch (need.kind) {
    case 'person':
    case 'review':
    case 'asking':
    case 'stuck':
      return `${need.kind}:${need.roundId}`
    case 'blocked':
    case 'end_merge':
      return `${need.kind}:${need.stepId}`
  }
}

/** Where the approved hand-in leads, by name: the next steps, or null at the end. */
function nextAfter(view: TaskView, round: RoundView): string | null {
  const step = view.workflow.steps.find((s) => s.id === round.stepId)
  const outcome = step?.outcomes.find((o) => o.name === round.outcome) ?? step?.outcomes[0]
  if (!outcome || outcome.end) return null
  return outcome.to.map((id) => stepTitle(view.workflow, id)).join('和')
}

function useAgentName(): (id: string) => string {
  const agents = useAgents()
  return (id) => agents.get(id)?.name ?? id
}

export function NeedCards(props: { view: TaskView; onPin(stepId: string): void }) {
  const { view } = props
  if (view.status !== 'running' || view.needs.length === 0) return null
  return (
    <View style={styles.list}>
      {view.needs.map((need) => (
        <Need key={needKey(need)} view={view} need={need} onPin={props.onPin} />
      ))}
    </View>
  )
}

function Need(props: { view: TaskView; need: TaskNeed; onPin(stepId: string): void }) {
  const { view, need } = props
  switch (need.kind) {
    case 'review':
      return <ReviewCard view={view} roundId={need.roundId} />
    case 'person':
      return <PersonCard view={view} roundId={need.roundId} />
    case 'asking':
      return <AskingCard view={view} need={need} />
    case 'blocked':
      return <BlockedCard view={view} need={need} onPin={props.onPin} />
    case 'stuck':
      return <StuckCard view={view} need={need} />
    case 'end_merge':
      return <MergeCard view={view} need={need} />
  }
}

function ReviewCard(props: { view: TaskView; roundId: string }) {
  const { view, roundId } = props
  const { c } = useTokens()
  const link = useMaybeLink()
  const agentName = useAgentName()
  const round = view.rounds.find((r) => r.id === roundId)
  const [note, setNote] = useState('')
  const request = useRequest()
  const { threads } = useComments(round?.document ? link : null, round?.document?.artifactId ?? '')
  if (!round || !link) return null
  const step = stepTitle(view.workflow, round.stepId)
  const agent = round.by ? agentName(round.by.agentId) : '你'
  const outcome = round.outcome ?? '完成'
  const next = nextAfter(view, round)
  const comments = round.document
    ? (threads?.filter((thread) => thread.resolvedAt === null).length ?? 0)
    : 0
  const answer = (approve: boolean) =>
    void request.run(approve ? 'approve' : 'back', () =>
      taskRequest(link, 'tasks.review', {
        taskId: view.id,
        roundId,
        approve,
        ...(!approve && note.trim() ? { note: note.trim() } : {}),
      }),
    )
  return (
    <NeedCard
      icon="doc"
      tone="warning"
      over={`${step} · 第 ${round.n} 轮 · ${agent}`}
      title={`${step} 在等你审阅`}
      body={
        round.note ? `${agent} 上报了 ${outcome}：${round.note}` : `${agent} 上报了 ${outcome}。`
      }
      error={request.error}
    >
      {round.document ? (
        <DocumentChip
          artifactId={round.document.artifactId}
          title={round.document.title}
          detail={`v${round.document.version} · 点按打开`}
        />
      ) : null}
      {comments > 0 ? (
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
          {comments === 1
            ? `退回时，你在文档上的评论会一起交回给 ${agent}`
            : `退回时，你在文档上的 ${comments} 条评论会一起交回给 ${agent}`}
        </Text>
      ) : null}
      <NoteField value={note} onChange={setNote} placeholder={`给 ${agent} 的说明（可选）`} />
      <Actions>
        <ActionButton
          label="退回"
          icon="restore"
          busy={request.busy === 'back'}
          disabled={request.busy !== null}
          onPress={() => answer(false)}
        />
        <ActionButton
          label={next ? `批准，进入${next}` : '批准'}
          tone="primary"
          busy={request.busy === 'approve'}
          disabled={request.busy !== null}
          onPress={() => answer(true)}
        />
      </Actions>
    </NeedCard>
  )
}

function PersonCard(props: { view: TaskView; roundId: string }) {
  const { view, roundId } = props
  const { c } = useTokens()
  const link = useMaybeLink()
  const round = view.rounds.find((r) => r.id === roundId)
  const step = view.workflow.steps.find((s) => s.id === round?.stepId)
  const [note, setNote] = useState('')
  const request = useRequest()
  if (!round || !step || !link) return null
  return (
    <NeedCard
      icon="person"
      tone="warning"
      title={`轮到你：${stepTitle(view.workflow, step.id)}`}
      body={
        step.prompt.trim() ? (
          <Clamp maxHeight={140} more="展开全部">
            <Markdown markdown={step.prompt} size="compact" color={c.textSecondary} />
          </Clamp>
        ) : undefined
      }
      error={request.error}
    >
      <NoteField value={note} onChange={setNote} placeholder="附一段说明（可选）" />
      <Actions>
        {step.outcomes.map((outcome, i) => (
          <ActionButton
            key={outcome.name}
            label={outcome.name}
            tone={i === 0 ? 'primary' : 'plain'}
            busy={request.busy === outcome.name}
            disabled={request.busy !== null}
            onPress={() =>
              void request.run(outcome.name, () =>
                taskRequest(link, 'tasks.answer', {
                  taskId: view.id,
                  roundId,
                  outcome: outcome.name,
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              )
            }
          />
        ))}
      </Actions>
    </NeedCard>
  )
}

function AskingCard(props: { view: TaskView; need: Extract<TaskNeed, { kind: 'asking' }> }) {
  const { view, need } = props
  const agentName = useAgentName()
  const round = view.rounds.find((r) => r.id === need.roundId)
  const agent = round?.by ? agentName(round.by.agentId) : ''
  return (
    <NeedCard
      icon="hand"
      tone="warning"
      title={`${stepTitle(view.workflow, need.stepId)} 的 ${agent} 在问你`}
      body="它的会话在等一个授权或回答。"
    >
      <Actions>
        <ActionButton
          label="打开会话"
          tone="primary"
          onPress={() => router.push(`/session/${need.sessionId}`)}
        />
      </Actions>
    </NeedCard>
  )
}

function BlockedCard(props: {
  view: TaskView
  need: Extract<TaskNeed, { kind: 'blocked' }>
  onPin(stepId: string): void
}) {
  const { view, need } = props
  const agentName = useAgentName()
  const canPin = view.workflow.steps.find((s) => s.id === need.stepId)?.by === 'agent'
  return (
    <NeedCard
      icon="warning"
      tone="warning"
      title={`${stepTitle(view.workflow, need.stepId)} 开不了工`}
      body={blockedText(need.reason, agentName)}
    >
      <RetryRow
        view={view}
        stepId={need.stepId}
        extra={
          canPin ? (
            <ActionButton label="固定别的 Agent…" onPress={() => props.onPin(need.stepId)} />
          ) : null
        }
      />
    </NeedCard>
  )
}

function StuckCard(props: { view: TaskView; need: Extract<TaskNeed, { kind: 'stuck' }> }) {
  const { view, need } = props
  const { c } = useTokens()
  const round = view.rounds.find((r) => r.id === need.roundId)
  const step = stepTitle(view.workflow, need.stepId)
  const sessionId = round?.sessionId ?? null
  return (
    <NeedCard
      icon="failed"
      tone="danger"
      title={`${step} 卡住了`}
      body={
        <View style={styles.body}>
          <Text selectable style={[typeScale.callout, { color: c.textSecondary }]}>
            {STUCK_TEXT[need.reason](step)}
          </Text>
          {need.detail ? (
            <Text selectable style={[styles.mono, { color: c.textTertiary }]}>
              {need.detail}
            </Text>
          ) : null}
        </View>
      }
    >
      <RetryRow
        view={view}
        stepId={need.stepId}
        extra={
          sessionId ? (
            <ActionButton label="打开会话" onPress={() => router.push(`/session/${sessionId}`)} />
          ) : null
        }
      />
    </NeedCard>
  )
}

function MergeCard(props: { view: TaskView; need: Extract<TaskNeed, { kind: 'end_merge' }> }) {
  const { view, need } = props
  const { c } = useTokens()
  return (
    <NeedCard
      icon="branch"
      tone="danger"
      title="结束时需求的分支没能合并"
      body={
        <View style={styles.body}>
          <Text selectable style={[typeScale.callout, { color: c.textSecondary }]}>
            {need.error ?? `${need.conflicts.length} 个文件有冲突。在需求的工作树里解决后重试。`}
          </Text>
          {need.conflicts.map((file) => (
            <Text
              key={file}
              selectable
              numberOfLines={1}
              style={[styles.mono, { color: c.textTertiary }]}
            >
              {file}
            </Text>
          ))}
        </View>
      }
    >
      <RetryRow view={view} stepId={need.stepId} />
    </NeedCard>
  )
}

/** Retry with an optional note for the step's agent, beside the card's other actions. */
function RetryRow(props: { view: TaskView; stepId: string; extra?: ReactNode }) {
  const link = useMaybeLink()
  const [note, setNote] = useState('')
  const request = useRequest()
  return (
    <>
      <NoteField value={note} onChange={setNote} placeholder="给这一步 Agent 的说明（可选）" />
      <Actions>
        {props.extra}
        <ActionButton
          label="重试"
          icon="refresh"
          tone="primary"
          busy={request.busy === 'retry'}
          disabled={!link}
          onPress={() =>
            link &&
            void request.run('retry', () =>
              taskRequest(link, 'tasks.retry', {
                taskId: props.view.id,
                stepId: props.stepId,
                ...(note.trim() ? { note: note.trim() } : {}),
              }),
            )
          }
        />
      </Actions>
      {request.error ? <RequestError text={request.error} /> : null}
    </>
  )
}

function RequestError(props: { text: string }) {
  const { c } = useTokens()
  return (
    <Text accessibilityRole="alert" style={[typeScale.footnote, { color: c.danger }]}>
      {props.text}
    </Text>
  )
}

/**
 * Who does a step for this task alone: an agent that can do steps, with its own model and effort;
 * 改回 Auto drops a pin made before.
 */
export function PinSheet(props: { view: TaskView; stepId: string | null; onClose(): void }) {
  const { view, stepId } = props
  const agentsMap = useAgents()
  const link = useMaybeLink()
  const pinned = stepId ? (view.pins[stepId] ?? null) : null
  const agents = [...agentsMap.values()].filter(
    (a) =>
      canDoSteps(a.harnessId) &&
      !a.disabled &&
      !a.uninstalled &&
      !a.hidden &&
      a.registered !== false,
  )
  const send = (agentId: AgentId | null) => {
    if (!stepId || !link) return
    taskRequest(link, 'tasks.pin', {
      taskId: view.id,
      stepId,
      pick: agentId ? { agentId, model: null, effort: null } : null,
    }).then(
      () => haptic.success(),
      (failure: unknown) => {
        haptic.warning()
        Alert.alert('没能固定', errorText(failure))
      },
    )
  }
  const items: SheetItem[] = [
    ...agents.map((a) => ({
      key: a.id,
      label: a.name,
      detail: a.harnessName,
      checked: pinned?.agentId === a.id,
      onPress: () => send(a.id),
    })),
    ...(pinned ? [{ key: '__auto', label: '改回 Auto', onPress: () => send(null) }] : []),
  ]
  return (
    <Sheet
      visible={stepId !== null}
      title={pinned ? '更改固定…' : '为这条需求固定…'}
      message={`${stepId ? stepTitle(view.workflow, stepId) : ''} 由谁来做。只有 Claude Code 和 Codex 的 Agent 能做步骤。`}
      items={items}
      onClose={props.onClose}
    />
  )
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  body: { gap: space.xs },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
})

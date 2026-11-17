// One task in a list: who is on it (an agent, or 你 when it waits for the user), its title, its
// workflow and the step it is on with step n/N, and how long it has gone or when it ended.

import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { TaskSummary, TaskView } from '@shared/workflow'
import { useAgent } from '../../host'
import { listTime } from '../../sessions'
import {
  ENDED_TEXT,
  frontStep,
  needsAttention,
  progressText,
  spanText,
  stepTitle,
  stepWord,
  useTick,
  WORD_TEXT,
  workflowTitle,
} from '../../tasks'
import { AgentAvatar, type AvatarBadge } from '../../ui/AgentAvatar'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { SwipeRow, type SwipeAction } from '../../ui/SwipeRow'
import { size as sizes, space, type as typeScale, useTokens } from '../../ui/tokens'

/** The user as a step's doer: a person on the avatar's disc, amber when something waits. */
export function YouAvatar(props: { size?: number; waiting?: boolean }) {
  const { c } = useTokens()
  const side = props.size ?? sizes.rowAvatar
  return (
    <View
      style={[
        styles.you,
        {
          width: side,
          height: side,
          borderRadius: side / 2,
          backgroundColor: props.waiting ? c.warning : c.avatar,
        },
      ]}
      accessibilityLabel="你"
    >
      <Icon
        name="person"
        size={Math.round(side * 0.5)}
        color={props.waiting ? c.onAccent : c.textSecondary}
      />
    </View>
  )
}

export const TaskRow = memo(function TaskRow(props: {
  task: TaskSummary
  view?: TaskView
  projectName?: string
  start?: SwipeAction
  end?: SwipeAction
  onPress(): void
  onLongPress?(): void
}) {
  const { c } = useTokens()
  const task = props.task
  const running = task.status === 'running'
  const waiting = needsAttention(task)
  const now = useTick(running)
  const step = frontStep(task)
  const word = step ? stepWord(step, props.view) : null
  const stepName = step ? stepTitle(props.view?.workflow, step.id, step.name) : null
  const progress = progressText(task)
  const yours = !!step && (step.state === 'needs_you' || step.agentId === null)
  const agentId = step?.agentId ?? task.agents[task.agents.length - 1] ?? null
  const agent = useAgent(agentId)
  const badge: AvatarBadge = !running
    ? task.unread
      ? 'unread'
      : null
    : task.error
      ? 'error'
      : waiting
        ? 'waiting'
        : task.running
          ? 'live'
          : null
  const time = running ? spanText(now - task.createdAt) : listTime(task.updatedAt)

  const state: { text: string; color: string } = !running
    ? {
        text: ENDED_TEXT[task.status],
        color: task.status === 'done' ? c.success : c.textTertiary,
      }
    : task.error
      ? { text: '卡住了', color: c.danger }
      : waiting
        ? { text: word ? WORD_TEXT[word] : '需要你', color: c.warning }
        : yours
          ? { text: '你', color: c.textSecondary }
          : {
              text: agentId ? `${agent?.name ?? agentId} 在做` : '进行中',
              color: c.textSecondary,
            }

  const row = (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={350}
      scale={false}
      accessibilityRole="button"
      accessibilityLabel={[
        task.title,
        workflowTitle(task, props.view),
        stepName ?? '',
        progress ? `第 ${task.at} 步，共 ${task.steps.length} 步` : '',
        state.text,
      ]
        .filter(Boolean)
        .join('，')}
      accessibilityHint={props.onLongPress ? '长按查看更多操作' : undefined}
      style={styles.row}
    >
      {yours && running ? (
        <YouAvatar waiting={waiting} />
      ) : agentId ? (
        <AgentAvatar
          size={sizes.rowAvatar}
          agentId={agentId}
          name={agent?.name}
          badge={badge}
        />
      ) : (
        <YouAvatar />
      )}
      <View style={styles.body}>
        <View style={styles.line}>
          {task.pinnedAt !== null && (
            <Icon name="pin" size={13} color={c.accent} weight="semibold" />
          )}
          <Text style={[typeScale.rowTitle, styles.title, { color: c.text }]} numberOfLines={1}>
            {task.title}
          </Text>
          <View style={styles.flex} />
          {progress ? (
            <Text style={[typeScale.subhead, styles.tabular, { color: c.textTertiary }]}>
              {progress}
            </Text>
          ) : null}
          <Text style={[typeScale.subhead, styles.time, { color: c.textTertiary }]}>{time}</Text>
        </View>
        <View style={styles.line}>
          <Icon name="flow" size={13} color={c.textTertiary} />
          <Text
            style={[typeScale.footnote, styles.shrink, { color: c.textTertiary }]}
            numberOfLines={1}
          >
            {[
              props.projectName,
              workflowTitle(task, props.view),
              running && stepName ? stepName : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Text
            style={[
              typeScale.footnote,
              styles.state,
              { color: state.color, fontWeight: waiting || task.error ? '600' : '500' },
            ]}
            numberOfLines={1}
          >
            {state.text}
          </Text>
        </View>
      </View>
    </Press>
  )

  if (!props.start && !props.end) return row
  return (
    <SwipeRow start={props.start} end={props.end}>
      {row}
    </SwipeRow>
  )
})

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  you: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  title: { flexShrink: 1 },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  state: { flexShrink: 0, maxWidth: '45%' },
  tabular: { fontVariant: ['tabular-nums'], fontWeight: '400' },
  time: { fontVariant: ['tabular-nums'], fontWeight: '400' },
})

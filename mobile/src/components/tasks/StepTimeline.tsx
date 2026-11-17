// A task's workflow as a vertical timeline, the phone's take on the desktop's flowchart: each step
// in the workflow's order on a rail, its state, who does it and how long it took; its rounds with
// their outcome, what they were sent back with, their note and document, each opening its
// session; and its arrows: where each outcome leads, which send work back and how often they were
// taken. Steps an outcome starts together sit side by side in a bracket, as parallel branches.

import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import {
  isBackArrow,
  type RoundView,
  type StepState,
  type TaskStepSummary,
  type TaskView,
  type WorkflowStep,
} from '@shared/workflow'
import { useAgents } from '../../host'
import { spanText, stepTitle, stepWord, useTick, WORD_TEXT } from '../../tasks'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { Clamp } from '../../ui/session/Clamp'
import { radius, space, type as typeScale, useTokens, type Palette } from '../../ui/tokens'
import { Markdown } from '../Markdown'
import { DocumentChip, Tag } from './parts'
import { YouAvatar } from './TaskRow'

const DOT = 14

function stateColor(c: Palette, state: StepState): string {
  switch (state) {
    case 'done':
      return c.success
    case 'running':
      return c.accent
    case 'needs_you':
      return c.warning
    case 'error':
      return c.danger
    default:
      return c.borderStrong
  }
}

/** The groups the rail shows: one step, or the steps one outcome starts at once. */
function groupsOf(workflow: TaskView['workflow']): WorkflowStep[][] {
  const together = new Map<string, string>()
  for (const step of workflow.steps) {
    for (const outcome of step.outcomes) {
      if (outcome.to.length < 2 || isBackArrow(workflow, step.id, outcome)) continue
      const key = [...outcome.to].sort().join('|')
      for (const id of outcome.to) if (!together.has(id)) together.set(id, key)
    }
  }
  const out: WorkflowStep[][] = []
  const placed = new Set<string>()
  for (const step of workflow.steps) {
    if (placed.has(step.id)) continue
    const key = together.get(step.id)
    const group = key ? workflow.steps.filter((s) => together.get(s.id) === key) : [step]
    for (const s of group) placed.add(s.id)
    out.push(group)
  }
  return out
}

export function StepTimeline(props: { view: TaskView }) {
  const { view } = props
  const groups = useMemo(() => groupsOf(view.workflow), [view.workflow])
  const front = view.at !== null ? view.steps[view.at - 1]?.id : undefined
  return (
    <View>
      {groups.map((group, g) => {
        const last = g === groups.length - 1
        if (group.length === 1) {
          return (
            <StepNode
              key={group[0]!.id}
              view={view}
              step={group[0]!}
              front={front === group[0]!.id}
              last={last}
            />
          )
        }
        return (
          <Parallel
            key={group.map((s) => s.id).join('|')}
            view={view}
            group={group}
            last={last}
            front={front}
          />
        )
      })}
      <EndMark view={view} />
    </View>
  )
}

function Parallel(props: {
  view: TaskView
  group: WorkflowStep[]
  last: boolean
  front: string | undefined
}) {
  const { c } = useTokens()
  return (
    <View style={styles.parallel}>
      <View style={styles.rail}>
        <View style={[styles.fork, { borderColor: c.borderStrong }]}>
          <Icon name="branch" size={11} color={c.textSecondary} />
        </View>
        <View style={[styles.line, { backgroundColor: c.border }]} />
      </View>
      <View style={styles.flex}>
        <Text style={[typeScale.caption, styles.parallelLabel, { color: c.textTertiary }]}>
          同时进行 · {props.group.length} 个分支
        </Text>
        <View style={[styles.bracket, { borderColor: c.border }]}>
          {props.group.map((step, i) => (
            <StepNode
              key={step.id}
              view={props.view}
              step={step}
              front={props.front === step.id}
              last={i === props.group.length - 1}
            />
          ))}
        </View>
        {!props.last ? <View style={styles.gap} /> : null}
      </View>
    </View>
  )
}

function StepNode(props: { view: TaskView; step: WorkflowStep; front: boolean; last: boolean }) {
  const { view, step } = props
  const { c } = useTokens()
  const agents = useAgents()
  const summary: TaskStepSummary | undefined = view.steps.find((s) => s.id === step.id)
  const state = summary?.state ?? 'not_reached'
  const word = summary ? stepWord(summary, view) : null
  const rounds = view.rounds.filter((r) => r.stepId === step.id).sort((a, b) => a.n - b.n)
  const running = state === 'running' && view.status === 'running'
  const now = useTick(running)
  const time =
    summary?.startedAt != null
      ? spanText((summary.endedAt ?? (running ? now : summary.startedAt)) - summary.startedAt)
      : null
  const pin = view.pins[step.id]
  const latest = rounds[rounds.length - 1]
  const agentId = latest?.by?.agentId ?? summary?.agentId ?? pin?.agentId ?? null
  const reached = state !== 'not_reached'
  const color = stateColor(c, state)
  const waiting = view.waiting.find((w) => w.stepId === step.id)

  const who =
    step.by === 'you' ? '你' : agentId ? (agents.get(agentId)?.name ?? agentId) : 'Auto'
  const whyWho = pin && !latest ? '已固定' : null

  return (
    <View style={styles.node}>
      <View style={styles.rail}>
        <View
          style={[
            styles.dot,
            reached && state !== 'waiting'
              ? { backgroundColor: color, borderColor: color }
              : { borderColor: color, backgroundColor: c.bg },
          ]}
        >
          {state === 'done' ? (
            <Icon name="check" size={9} color={c.onAccent} weight="bold" />
          ) : null}
        </View>
        {!props.last ? <View style={[styles.line, { backgroundColor: c.border }]} /> : null}
      </View>
      <View style={[styles.flex, styles.content]}>
        <View style={styles.titleLine}>
          <Text
            style={[
              typeScale.callout,
              styles.shrink,
              {
                color: reached ? c.text : c.textSecondary,
                fontWeight: props.front && view.status === 'running' ? '700' : '600',
              },
            ]}
            numberOfLines={2}
          >
            {stepTitle(view.workflow, step.id)}
          </Text>
          {step.by === 'you' ? <Tag label="你" color={c.warning} background={c.fill} /> : null}
          {step.youReview ? <Tag label="你审阅" color={c.warning} background={c.fill} /> : null}
          <View style={styles.flex} />
          {word ? (
            <Text
              style={[
                typeScale.footnote,
                {
                  color:
                    state === 'needs_you'
                      ? c.warning
                      : state === 'error'
                        ? c.danger
                        : state === 'done'
                          ? c.success
                          : c.textSecondary,
                  fontWeight: '600',
                },
              ]}
            >
              {WORD_TEXT[word]}
            </Text>
          ) : null}
          {time ? (
            <Text style={[typeScale.footnote, styles.tabular, { color: c.textTertiary }]}>
              {time}
            </Text>
          ) : null}
        </View>

        <View style={styles.whoLine}>
          {step.by === 'you' ? (
            <YouAvatar size={18} />
          ) : agentId ? (
            <AgentAvatar agentId={agentId} name={agents.get(agentId)?.name} size={18} />
          ) : null}
          <Text
            style={[typeScale.footnote, styles.shrink, { color: c.textSecondary }]}
            numberOfLines={1}
          >
            {[
              who,
              whyWho,
              step.reviewOf.length > 0
                ? `审查 ${step.reviewOf.map((id) => stepTitle(view.workflow, id)).join('、')}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>

        {waiting && !latest && waiting.blocked?.kind === 'picking' ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>它在等前一步选人。</Text>
        ) : null}

        {rounds.map((round) => (
          <RoundBlock key={round.id} view={view} round={round} several={rounds.length > 1} />
        ))}

        <Arrows view={view} step={step} />
        {!props.last ? <View style={styles.gap} /> : null}
      </View>
    </View>
  )
}

/** What a round was sent back with, when the user did it in a review. */
function reviewedBack(view: TaskView, round: RoundView) {
  return (
    view.rounds.find((r) => r.sentBack?.by === 'person' && r.sentBack.roundId === round.id)
      ?.sentBack ?? null
  )
}

function RoundBlock(props: { view: TaskView; round: RoundView; several: boolean }) {
  const { view, round } = props
  const { c } = useTokens()
  const running = round.endedAt === null && round.startedAt !== null
  const now = useTick(running && view.status === 'running')
  const back = reviewedBack(view, round)
  const step = view.workflow.steps.find((s) => s.id === round.stepId)
  const outcome = step?.outcomes.find((o) => o.name === round.outcome)
  const backward = !!outcome && isBackArrow(view.workflow, round.stepId, outcome)
  const badge = roundBadge(c, round, !!back, backward)
  const time = round.startedAt !== null ? spanText((round.endedAt ?? now) - round.startedAt) : null
  const sessionId = round.sessionId

  const head = (
    <View style={styles.roundHead}>
      {props.several ? (
        <Text style={[typeScale.caption, { color: c.textTertiary }]}>第 {round.n} 轮</Text>
      ) : null}
      <View style={[styles.badge, { backgroundColor: c.fill }]}>
        {badge.icon ? (
          <Icon name={badge.icon} size={11} color={badge.color} weight="semibold" />
        ) : null}
        <Text style={[typeScale.caption, { color: badge.color }]} numberOfLines={1}>
          {badge.text}
        </Text>
      </View>
      <View style={styles.flex} />
      {time && props.several ? (
        <Text style={[typeScale.caption, styles.tabular, { color: c.textTertiary }]}>{time}</Text>
      ) : null}
      {sessionId ? (
        <View style={styles.open}>
          <Icon name="message" size={12} color={c.tint} />
          <Text style={[typeScale.caption, { color: c.tint }]}>会话</Text>
          <Icon name="chevronRight" size={10} color={c.tint} weight="semibold" />
        </View>
      ) : null}
    </View>
  )

  return (
    <View style={[styles.round, { backgroundColor: c.surface, borderColor: c.border }]}>
      {sessionId ? (
        <Press
          onPress={() => router.push(`/session/${sessionId}`)}
          scale={false}
          accessibilityRole="button"
          accessibilityLabel={`打开${stepTitle(view.workflow, round.stepId)}第 ${round.n} 轮的会话`}
        >
          {head}
        </Press>
      ) : (
        head
      )}
      {round.sentBack ? (
        <Text style={[typeScale.footnote, { color: c.warning }]}>
          {round.sentBack.by === 'person'
            ? '你退回的'
            : `${stepTitle(view.workflow, round.sentBack.stepId)} 退回的`}
          {round.sentBack.outcome ? ` · ${round.sentBack.outcome}` : ''}
          {round.sentBack.limit > 0
            ? round.sentBack.count >= round.sentBack.limit
              ? ' · 这是最后一次能退回'
              : ` · 还能退回 ${round.sentBack.limit - round.sentBack.count} 次`
            : ''}
        </Text>
      ) : null}
      {round.reason ? (
        <Text selectable style={[typeScale.footnote, { color: c.textSecondary }]}>
          理由：“{round.reason}”
        </Text>
      ) : null}
      {back ? (
        <Text selectable style={[typeScale.footnote, { color: c.text }]}>
          你：“{back.note ?? '退回时没有附说明'}”
        </Text>
      ) : round.note ? (
        <Clamp maxHeight={110} more="展开全部">
          <Markdown markdown={round.note} size="compact" />
        </Clamp>
      ) : null}
      {round.document ? (
        <DocumentChip
          artifactId={round.document.artifactId}
          title={round.document.title}
          detail={`第 ${round.document.version} 版`}
        />
      ) : null}
      {round.stuck?.detail ? (
        <Text selectable style={[typeScale.footnote, { color: c.danger }]} numberOfLines={4}>
          {round.stuck.detail}
        </Text>
      ) : null}
    </View>
  )
}

function roundBadge(
  c: Palette,
  round: RoundView,
  sentBack: boolean,
  backward: boolean,
): { text: string; color: string; icon?: 'restore' | 'check' } {
  if (backward && round.state === 'done') {
    return { text: round.outcome ?? '已退回', color: c.warning, icon: 'restore' }
  }
  if (sentBack) return { text: '已退回', color: c.warning, icon: 'restore' }
  switch (round.state) {
    case 'done':
      return { text: round.outcome ?? '完成', color: c.success, icon: 'check' }
    case 'stopped':
      return { text: '已停止', color: c.textTertiary }
    case 'stuck':
      return { text: '卡住了', color: c.danger }
    case 'picking':
      return { text: '正在选下一步的人', color: c.tint }
    case 'reviewing':
      return { text: '等你审阅', color: c.warning }
    case 'person':
      return { text: '轮到你', color: c.warning }
    case 'queued':
      return { text: '等待中', color: c.textSecondary }
    case 'starting':
    case 'working':
      return { text: '进行中', color: c.tint }
  }
}

/** Where each outcome of a step leads: forward, back (with its trips) or to the end. */
function Arrows(props: { view: TaskView; step: WorkflowStep }) {
  const { view, step } = props
  const { c } = useTokens()
  if (step.outcomes.length === 0) return null
  return (
    <View style={styles.arrows}>
      {step.outcomes.map((outcome) => {
        const back = isBackArrow(view.workflow, step.id, outcome)
        const taken = view.arrows.find((a) => a.from === step.id && a.outcome === outcome.name)
        const limit = outcome.limit ?? view.workflow.sendBackLimit
        const targets = outcome.end
          ? outcome.end === 'done'
            ? '完成'
            : '不值得做'
          : outcome.to.map((id) => stepTitle(view.workflow, id)).join('、')
        const trips = back
          ? taken && taken.taken > 0
            ? `已用 ${taken.taken}/${taken.limit ?? limit} 次`
            : `最多 ${limit} 次`
          : null
        const color = taken && taken.taken > 0 ? (back ? c.warning : c.text) : c.textTertiary
        return (
          <View key={outcome.name} style={styles.arrow}>
            <Text style={[typeScale.caption, { color }]} numberOfLines={2}>
              {outcome.name}
              {back ? ' ↩ ' : ' → '}
              {back ? `退回 ${targets}` : outcome.end ? `结束：${targets}` : targets}
              {outcome.to.length > 1 && !back ? '（同时）' : ''}
              {trips ? ` · ${trips}` : ''}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function EndMark(props: { view: TaskView }) {
  const { c } = useTokens()
  const { view } = props
  if (view.status === 'running') return null
  const color = view.status === 'done' ? c.success : c.textTertiary
  const text = { done: '已完成', dropped: '不值得做', cancelled: '已取消', running: '' }[
    view.status
  ]
  return (
    <View style={styles.end}>
      <View style={[styles.endLine, { backgroundColor: c.border }]} />
      <Text style={[typeScale.footnote, { color, fontWeight: '600' }]}>{text}</Text>
      <View style={[styles.endLine, { backgroundColor: c.border }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  node: { flexDirection: 'row' },
  rail: { width: DOT + space.md, alignItems: 'center' },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    marginTop: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { flex: 1, width: 2, borderRadius: 1, marginTop: 3 },
  content: { gap: space.xs + 2, paddingLeft: space.xs },
  gap: { height: space.lg },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  whoLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  round: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: space.xs + 2,
  },
  roundHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
    flexShrink: 1,
  },
  open: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  arrows: { gap: 2 },
  arrow: { flexDirection: 'row' },
  parallel: { flexDirection: 'row' },
  fork: {
    width: DOT + 4,
    height: DOT + 4,
    borderRadius: (DOT + 4) / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  parallelLabel: { paddingLeft: space.xs, paddingTop: 2, paddingBottom: space.sm },
  bracket: {
    borderLeftWidth: 2,
    borderRadius: radius.sm,
    paddingLeft: space.xs,
    paddingTop: space.xs,
  },
  end: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.sm,
  },
  endLine: { flex: 1, height: StyleSheet.hairlineWidth },
})

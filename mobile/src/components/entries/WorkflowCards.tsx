// The calls of Kettu's workflow tools, once they ended, as the desktop's cards draw them: a
// suggestion to run the work as a task, which the phone can start or decline; a workflow an agent
// saved for approval, which opens its page to approve; and a step's report or pick with what Kettu
// checked, where a report that waits for the user's review can be approved or sent back.

import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import type {
  CheckLine,
  CheckNext,
  Pace,
  TaskView,
  WireWorkflowEntry,
  Workflow,
} from '@shared/workflow'
import { usableWorkflow, LEGACY_OFFICIAL } from '@shared/workflow'
import type { ToolEntry } from '@shared/thread'
import { call } from '../../git'
import { useAgents, useLink, useSession } from '../../host'
import { useSessionRows } from '../../ui/session/context'
import { haptic } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { useAgentName } from './AccessEntries'
import { AskCard, CardButton, E, kit, QuietLine, SendState, useSender } from './kit'
import {
  answerSuggestion,
  listedLines,
  pickOf,
  reportOf,
  savedOf,
  suggestionOf,
  useSuggestionAnswer,
  workflowCardOf,
  type PickCall,
  type ReportCall,
  type Suggestion,
} from './workflowTools'

export { workflowCardOf }

const LANG = 'zh-CN'
const PACES: { value: Pace; label: string }[] = [
  { value: 'quick', label: '快速' },
  { value: 'balanced', label: '均衡' },
  { value: 'thorough', label: '周全' },
]

function workflowName(entry: WireWorkflowEntry): string {
  return entry.workflow?.locales[LANG]?.name ?? entry.name
}

function stepName(workflow: Workflow, id: string): string {
  return workflow.locales[LANG]?.steps?.[id] ?? workflow.steps.find((s) => s.id === id)?.name ?? id
}

const listOf = (names: string[]) => names.join('、')

/** The computer's workflow library, read once a card that names one shows. */
function useWorkflows(): { entries: WireWorkflowEntry[]; loaded: boolean } {
  const link = useLink()
  const [entries, setEntries] = useState<WireWorkflowEntry[] | null>(null)
  useEffect(() => {
    let alive = true
    call(link, 'workflows.list', undefined).then(
      (list) => alive && setEntries(list),
      () => alive && setEntries([]),
    )
    return () => {
      alive = false
    }
  }, [link])
  return { entries: entries ?? [], loaded: entries !== null }
}

/** The task a step session belongs to, for its steps' names and what waits for the user. */
function useTask(taskId: string | null): { view: TaskView | null; reload(): void } {
  const link = useLink()
  const [view, setView] = useState<TaskView | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!taskId) return
    let alive = true
    call(link, 'tasks.get', { taskId }).then(
      (next) => alive && setView(next),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [link, taskId, tick])
  return { view, reload: () => setTick((n) => n + 1) }
}

export function WorkflowToolCard(props: { entry: ToolEntry }) {
  const { sessionId } = useSessionRows()
  const tool = workflowCardOf(props.entry)
  switch (tool) {
    case 'start':
      return <SuggestionCard entry={props.entry} sessionId={sessionId} />
    case 'create':
      return <SavedCard entry={props.entry} sessionId={sessionId} />
    case 'report':
      return <ReportCard call={reportOf(props.entry)} sessionId={sessionId} />
    case 'pick':
      return <PickCard call={pickOf(props.entry)} sessionId={sessionId} />
    default:
      return null
  }
}

// A suggestion.

function SuggestionCard(props: { entry: ToolEntry; sessionId: string }) {
  const answer = useSuggestionAnswer(props.sessionId, props.entry.id)
  const suggestion = suggestionOf(props.entry)!
  if (answer?.kind === 'started') {
    return (
      <QuietLine
        icon={G.done}
        tone="done"
        text="已作为需求开始"
        detail={suggestion.title ?? suggestion.workflowName ?? suggestion.workflowId}
      />
    )
  }
  if (answer?.kind === 'declined') {
    return (
      <QuietLine
        icon={G.close}
        text="不用工作流，直接做"
        detail={suggestion.title ?? suggestion.workflowName ?? suggestion.workflowId}
      />
    )
  }
  return <SuggestionPending {...props} suggestion={suggestion} />
}

function SuggestionPending(props: { entry: ToolEntry; sessionId: string; suggestion: Suggestion }) {
  const { entry, sessionId, suggestion } = props
  const { c, s } = useSessionTokens()
  const link = useLink()
  const { config } = useSessionRows()
  const agent = useAgentName(sessionId)
  const summary = useSession(sessionId)
  const { entries, loaded } = useWorkflows()
  const sender = useSender(entry.id)
  const [text, setText] = useState(suggestion.task)
  const [pace, setPace] = useState(suggestion.pace)
  const [empty, setEmpty] = useState(false)
  const chosen = entries.find((e) => e.id === suggestion.workflowId)
  const workflow = chosen && usableWorkflow(chosen) ? chosen.workflow : null
  const shownName = chosen
    ? workflowName(chosen)
    : (suggestion.workflowName ?? suggestion.workflowId)
  const waits = workflow
    ? workflow.steps.filter((step) => step.youReview || step.by === 'you').map((step) => step.id)
    : []

  const start = async () => {
    if (!summary || !workflow) return false
    const task = text.trim()
    if (!task) {
      setEmpty(true)
      return false
    }
    setEmpty(false)
    const options = Object.fromEntries(
      (config ?? []).filter((o) => o.category !== 'mode').map((o) => [o.id, o.value]),
    )
    const view = await call(link, 'tasks.start', {
      projectPath: summary.projectPath,
      workflowId: suggestion.workflowId,
      text: task,
      ...(suggestion.title ? { title: suggestion.title } : {}),
      pace,
      ...(pace === suggestion.pace && suggestion.paceReason
        ? { paceReason: suggestion.paceReason }
        : {}),
      agentId: summary.agentId,
      options,
      from: { sessionId },
    })
    answerSuggestion(sessionId, entry.id, { kind: 'started', taskId: view.id })
    return true
  }

  const decline = async () => {
    await call(link, 'sessions.queue', {
      sessionId,
      content: [{ type: 'text', text: '这个不用工作流，你直接做吧。' }],
    })
    answerSuggestion(sessionId, entry.id, { kind: 'declined' })
  }

  return (
    <AskCard
      icon={E.workflow}
      title="作为工作流来做？"
      body={`${agent} 的建议 · ${
        workflow && waits.length > 0
          ? `每一步一个会话；${listOf(waits.map((id) => stepName(workflow, id)))}等你审。`
          : '每一步一个会话。'
      }`}
      sender={sender}
      actions={[
        { key: 'decline', label: '不用，直接做', run: decline },
        {
          key: 'start',
          label: '开始',
          tone: 'primary',
          disabled: !workflow || !summary,
          run: start,
        },
      ]}
    >
      <View style={kit.section}>
        <Text style={[kit.label, { color: c.textSecondary }]}>工作流</Text>
        <Text style={[styles.value, { color: c.text }]}>
          {shownName}
          {chosen?.workflow ? (
            <Text style={{ color: c.textTertiary }}> · {chosen.workflow.steps.length} 步</Text>
          ) : null}
        </Text>
        {workflow ? (
          <Text style={[kit.hint, { color: c.textTertiary }]}>
            {workflow.steps.map((step) => stepName(workflow, step.id)).join(' → ')}
          </Text>
        ) : loaded ? (
          <Text style={[kit.hint, { color: c.warning }]}>
            {chosen
              ? `${shownName} 现在不能开始需求。换一个工作流，或者不用工作流直接做。`
              : '这个工作流已经不在库里了。换一个，或者不用工作流直接做。'}
          </Text>
        ) : null}
      </View>
      <View style={kit.section}>
        <Text style={[kit.label, { color: c.textSecondary }]}>需求 · {agent} 写的，可以修改</Text>
        <TextInput
          value={text}
          onChangeText={(next) => {
            setText(next)
            setEmpty(false)
          }}
          multiline
          selectionColor={c.accent}
          style={[
            kit.field,
            {
              color: c.text,
              borderColor: empty ? c.danger : c.border,
              backgroundColor: c.fill,
              minHeight: 72,
              maxHeight: 180,
            },
          ]}
        />
        {empty ? <Text style={[kit.hint, { color: c.danger }]}>先写好需求。</Text> : null}
      </View>
      <View style={kit.section}>
        <Text style={[kit.label, { color: c.textSecondary }]}>Pace</Text>
        <View style={kit.chips}>
          {PACES.map((p) => {
            const on = pace === p.value
            return (
              <Pressable
                key={p.value}
                onPress={() => {
                  haptic.pick()
                  setPace(p.value)
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                style={[
                  kit.chip,
                  {
                    borderColor: on ? c.accent : c.border,
                    backgroundColor: on ? s.accentSoft : c.fill,
                  },
                ]}
              >
                <Text style={[kit.chipText, { color: on ? c.accent : c.text }]}>{p.label}</Text>
              </Pressable>
            )
          })}
        </View>
        {suggestion.paceReason ? (
          <Text style={[kit.hint, { color: c.textSecondary }]}>{suggestion.paceReason}</Text>
        ) : null}
      </View>
    </AskCard>
  )
}

// A workflow an agent wrote.

function SavedCard(props: { entry: ToolEntry; sessionId: string }) {
  const { c } = useSessionTokens()
  const agent = useAgentName(props.sessionId)
  const { entries, loaded } = useWorkflows()
  const saved = savedOf(props.entry)
  if (!saved) return null
  if (!saved.saved) {
    return (
      <Shell tone="bad">
        <Head title="工作流没有保存" badge={null} />
        <Checks lines={saved.problems.map((text) => ({ ok: false, text }))} />
        <Text style={[styles.meta, { color: c.text }]}>{agent} 可以改好这些问题后重新保存。</Text>
      </Shell>
    )
  }
  const library = entries.find((e) => e.id === saved.workflowId)
  const name = library ? workflowName(library) : saved.name
  const state = !loaded
    ? 'pending'
    : !library
      ? 'removed'
      : library.approval === 'approved' || library.approval === LEGACY_OFFICIAL
        ? 'approved'
        : library.approval === 'changed'
          ? 'changed'
          : 'pending'
  const title = {
    pending: `已保存“${name}”，等你批准`,
    approved: `“${name}”已批准`,
    changed: `“${name}”在你批准后改动过`,
    removed: `“${name}”已经不在库里了`,
  }[state]
  return (
    <Shell tone={state === 'approved' ? 'good' : 'quiet'}>
      <Head title={title} badge={null} />
      {library?.workflow ? (
        <Text style={[styles.meta, { color: c.textSecondary }]}>
          {library.workflow.steps.map((step) => stepName(library.workflow!, step.id)).join(' → ')}
        </Text>
      ) : null}
      <Text style={[styles.meta, { color: c.textTertiary }]}>
        {state === 'pending' || state === 'changed'
          ? '你批准之前，什么都不能用它。'
          : `${agent} 写的`}
      </Text>
      {library ? (
        <Pressable
          onPress={() => router.push(`/workflow/${encodeURIComponent(library.id)}`)}
          hitSlop={6}
          accessibilityRole="link"
          style={styles.details}
        >
          <Text style={[styles.meta, { color: c.accent, fontWeight: '600' }]}>
            {state === 'pending' || state === 'changed' ? '查看并批准' : '查看工作流'}
          </Text>
          <Icon icon={G.right} size={11} color={c.accent} />
        </Pressable>
      ) : null}
    </Shell>
  )
}

// A step's report and pick.

const REPORT_LINE: Record<string, string> = {
  step_open: '这一步可以报告',
  note: '要交的说明已经写好',
  document: '要交的文档是在这一步里写的',
  committed: '改动都已提交',
  merged: '合并已提交',
  picks: '选择都成立',
}

function nextText(
  next: CheckNext | null,
  accepted: boolean,
  agent: string,
  step: string | null,
  nameOf: (id: string) => string,
  retry: string,
): string {
  if (!next) return accepted ? '' : retry
  const list = (ids: string[]) => listOf(ids.map(nameOf))
  switch (next.kind) {
    case 'review':
      return `${step ?? ''}现在等你审。`
    case 'pick':
      return `接下来由 ${agent} 选择谁做${list(next.steps)}。`
    case 'start':
      return `接下来开始${list(next.steps)}。`
    case 'wait':
      return `${list(next.steps)}在等其他分支。`
    case 'person':
      return `${list(next.steps)}在等你。`
    case 'end':
      return next.end === 'done' ? '需求完成了。' : '需求以放弃结束。'
    case 'retry':
      return retry
    case 'stuck':
      return '被拒绝的次数太多：需求在等你。'
  }
}

function ReportCard(props: { call: ReportCall; sessionId: string }) {
  const { call: report, sessionId } = props
  const { c } = useSessionTokens()
  const agent = useAgentName(sessionId)
  const ref = useSession(sessionId)?.task ?? null
  const task = useTask(ref?.taskId ?? null)
  const nameOf = (id: string) => task.view?.steps.find((s) => s.id === id)?.name ?? id
  const label = (line: CheckLine<string>): string => {
    if (!line.ok && line.detail) return line.detail
    if (line.check === 'outcome') {
      return report.outcome ? `“${report.outcome}”是这一步的结果之一` : '报告的是这一步的结果之一'
    }
    return REPORT_LINE[line.check] ?? line.check
  }
  const reviewing =
    !!ref &&
    !!task.view?.needs.some((need) => need.kind === 'review' && need.roundId === ref.roundId)
  const next = nextText(
    report.next,
    report.accepted,
    agent,
    ref ? nameOf(ref.stepId) : null,
    nameOf,
    `${agent} 改好后会重新报告。`,
  )
  return (
    <Shell tone={report.accepted ? 'good' : 'bad'}>
      <Head title={report.outcome ? `报告 · ${report.outcome}` : '报告'} badge={report.accepted} />
      <Checks
        lines={
          report.checks
            ?.filter((line) => !(line.ok && line.check === 'step_open'))
            .map((line) => ({ ok: line.ok, text: label(line) })) ??
          listedLines(report.answer).map((text) => ({ ok: false, text }))
        }
      />
      {next ? <Text style={[styles.meta, { color: c.text }]}>{next}</Text> : null}
      <Details answer={report.answer} />
      {reviewing && ref ? (
        <Review
          taskId={ref.taskId}
          roundId={ref.roundId}
          step={nameOf(ref.stepId)}
          agent={agent}
          onDone={task.reload}
        />
      ) : null}
    </Shell>
  )
}

/** A step's hand-in waiting for the user's review: approve it, or send it back with a note. */
function Review(props: {
  taskId: string
  roundId: string
  step: string
  agent: string
  onDone(): void
}) {
  const { c } = useSessionTokens()
  const link = useLink()
  const sender = useSender()
  const [note, setNote] = useState('')
  const review = (approve: boolean) => async () => {
    await call(link, 'tasks.review', {
      taskId: props.taskId,
      roundId: props.roundId,
      approve,
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    props.onDone()
  }
  return (
    <View style={[styles.review, { borderTopColor: c.border }]}>
      <Text style={[styles.reviewTitle, { color: c.text }]}>{props.step} 在等你审阅</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        multiline
        placeholder={`给 ${props.agent} 的说明（可选）`}
        placeholderTextColor={c.textTertiary}
        selectionColor={c.accent}
        style={[kit.field, { color: c.text, borderColor: c.border, backgroundColor: c.fill }]}
      />
      <View style={styles.actions}>
        <CardButton
          label="退回"
          busy={sender.busy === 'back'}
          disabled={sender.busy !== null}
          onPress={() => void sender.send('back', review(false))}
        />
        <CardButton
          label="批准"
          tone="primary"
          busy={sender.busy === 'approve'}
          disabled={sender.busy !== null}
          onPress={() => void sender.send('approve', review(true))}
        />
      </View>
      <SendState sender={sender} />
    </View>
  )
}

function pickLine(check: string, pick: PickCall['picks'][number], who: string): string {
  switch (check) {
    case 'agent':
      return `${who} 存在且已开启`
    case 'allowed':
      return `Auto 可以选 ${who}`
    case 'model':
      return pick.model ? `${who} 有 ${pick.model}` : `${who} 有这个模型`
    case 'effort':
      return pick.effort ? `${pick.effort} 是它支持的 effort` : '它支持这个 effort'
    case 'tools':
      return '这一步的工具可以交给它'
    case 'limit':
      return '它的套餐用量没有用完'
    case 'review':
      return '它不审查自己做的事'
    default:
      return check
  }
}

function PickCard(props: { call: PickCall; sessionId: string }) {
  const { call: pick, sessionId } = props
  const { c } = useSessionTokens()
  const agents = useAgents()
  const agent = useAgentName(sessionId)
  const ref = useSession(sessionId)?.task ?? null
  const task = useTask(ref?.taskId ?? null)
  const nameOf = (id: string) => task.view?.steps.find((s) => s.id === id)?.name ?? id
  const steps = [...new Set(pick.picks.map((p) => p.step))]
  const next = nextText(
    pick.next,
    pick.accepted,
    agent,
    ref ? nameOf(ref.stepId) : null,
    nameOf,
    `${agent} 会重新选择。`,
  )
  return (
    <Shell tone={pick.accepted ? 'good' : 'bad'}>
      <Head title={`选择 · ${listOf(steps.map(nameOf))}`} badge={pick.accepted} />
      {pick.picks.map((p, i) => {
        const who = agents.get(p.agent)?.name ?? p.agent
        const lines = pick.checks?.find((check) => check.step === p.step)?.lines
        return (
          <View key={i} style={{ gap: 3 }}>
            <Text style={[styles.meta, { color: c.text, fontWeight: '600' }]}>
              {who}
              <Text style={{ color: c.textSecondary, fontWeight: '400' }}>
                {[p.model, p.effort].filter(Boolean).length > 0
                  ? ` ${[p.model, p.effort].filter(Boolean).join(' · ')}`
                  : ''}
                {steps.length > 1 ? ` · ${nameOf(p.step)}` : ''}
              </Text>
            </Text>
            {p.reason ? (
              <Text style={[styles.meta, { color: c.textSecondary }]}>“{p.reason}”</Text>
            ) : null}
            {lines ? (
              <Checks
                lines={lines
                  .filter((line) => !(line.ok && line.check === 'step'))
                  .map((line) => ({
                    ok: line.ok,
                    text: !line.ok && line.detail ? line.detail : pickLine(line.check, p, who),
                  }))}
              />
            ) : null}
          </View>
        )
      })}
      {!pick.checks ? (
        <Checks lines={listedLines(pick.answer).map((text) => ({ ok: false, text }))} />
      ) : null}
      {next ? <Text style={[styles.meta, { color: c.text }]}>{next}</Text> : null}
      <Details answer={pick.answer} />
    </Shell>
  )
}

function Shell(props: { tone: 'good' | 'bad' | 'quiet'; children: ReactNode }) {
  const { c } = useSessionTokens()
  return (
    <View
      style={[
        styles.shell,
        {
          backgroundColor: c.fill,
          borderLeftColor:
            props.tone === 'good' ? c.success : props.tone === 'bad' ? c.danger : c.border,
        },
      ]}
    >
      {props.children}
    </View>
  )
}

function Head(props: { title: string; badge: boolean | null }) {
  const { c, s } = useSessionTokens()
  return (
    <View style={styles.head}>
      <Icon icon={E.workflow} size={14} color={c.textSecondary} />
      <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
        {props.title}
      </Text>
      {props.badge !== null ? (
        <Text
          style={[
            styles.badge,
            {
              color: props.badge ? c.success : c.danger,
              backgroundColor: props.badge ? s.successSoft : s.dangerSoft,
            },
          ]}
        >
          {props.badge ? '已接受' : '已拒绝'}
        </Text>
      ) : null}
    </View>
  )
}

function Checks(props: { lines: { ok: boolean; text: string }[] }) {
  const { c } = useSessionTokens()
  if (props.lines.length === 0) return null
  return (
    <View style={{ gap: 3 }}>
      {props.lines.map((line, i) => (
        <View key={i} style={styles.check}>
          <View style={{ height: 18, justifyContent: 'center' }}>
            <Icon
              icon={line.ok ? G.check : G.close}
              size={12}
              color={line.ok ? c.success : c.danger}
            />
          </View>
          <Text style={[styles.meta, { color: c.textSecondary, flex: 1 }]}>{line.text}</Text>
        </View>
      ))}
    </View>
  )
}

function Details(props: { answer: string }) {
  const { c, s } = useSessionTokens()
  const [open, setOpen] = useState(false)
  if (!props.answer) return null
  return (
    <>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6} style={styles.details}>
        <Text style={[styles.meta, { color: c.textTertiary }]}>
          {open ? '收起' : 'Kettu 的回复'}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon icon={G.down} size={11} color={c.textTertiary} />
        </View>
      </Pressable>
      {open ? (
        <View style={[kit.block, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
          <Text selectable style={[styles.mono, { color: c.textSecondary }]}>
            {props.answer}
          </Text>
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  value: { fontSize: 15, lineHeight: 21, fontWeight: '500' },
  shell: { borderRadius: 14, borderLeftWidth: 3, padding: 12, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  check: { flexDirection: 'row', gap: 6 },
  meta: { fontSize: 13, lineHeight: 18 },
  details: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  review: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginTop: 4, gap: 8 },
  reviewTitle: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
})

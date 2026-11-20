// A workflow's page, read-only: what it is, its steps with who does them, their outcomes and where
// each leads, and a way to start a task with it. One waiting for approval shows its file as the
// computer read it, and Approve names that very file, as the desktop's Marketplace page does.

import { useCallback, useEffect, useState } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import { isBackArrow, type WireWorkflowEntry, type Workflow } from '@shared/workflow'
import { Markdown } from '../../components/Markdown'
import { ActionButton, Actions, NeedCard, Tag, useRequest } from '../../components/tasks/parts'
import { call } from '../../git'
import { useHost } from '../../host'
import { errorText } from '../../sessions'
import {
  entryDescription,
  entryName,
  entryProblem,
  ENTRY_STATE_TEXT,
  ENTRY_STATE_TITLE,
  sourceText,
  stepTitle,
} from '../../tasks'
import { EmptyState } from '../../ui/EmptyState'
import { LargeTitle } from '../../ui/LargeTitle'
import { NavBar } from '../../ui/NavBar'
import { Pill } from '../../ui/Pill'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { usePullRefresh } from '../../ui/PullRefresh'
import { SectionHeader } from '../../ui/SectionHeader'
import { Clamp } from '../../ui/session/Clamp'
import { MONO } from '../../ui/session/palette'
import { SkeletonRows } from '../../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

interface Read {
  entry: WireWorkflowEntry
  text: string | null
}

export default function WorkflowPage() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const pull = usePullRefresh(() => load(), header)
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [read, setRead] = useState<Read | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const connected = host.state.kind === 'connected'
  const link = host.link

  const load = useCallback(async () => {
    if (!link) return
    try {
      setRead(await call(link, 'workflows.read', { workflowId: id }))
      setError(null)
      setGone(false)
    } catch (failure) {
      if ((failure as { code?: unknown } | null)?.code === 'not_found') setGone(true)
      else setError(errorText(failure))
    }
  }, [link, id])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw) => {
      if ((raw as HostEvent).type === 'workflows.changed') void load()
    })
  }, [link, load])

  const entry = read?.entry ?? null
  const workflow = entry?.workflow ?? null
  const problem = entry ? entryProblem(entry) : null

  let body
  if (gone) {
    body = (
      <EmptyState
        icon="flow"
        title="找不到这个工作流"
        message="它可能已被删除。"
        action={{ label: '返回', onPress: () => router.back() }}
      />
    )
  } else if (error && !read) {
    body = (
      <EmptyState
        tone="error"
        icon="warning"
        title="无法读取工作流"
        message={error}
        action={{ label: '重试', onPress: () => void load() }}
      />
    )
  } else if (!entry && !connected) {
    body = (
      <EmptyState
        icon="wifi"
        title="打不开这个工作流"
        message="它所在的电脑没有连上，连上后会再显示。"
        action={{ label: '立即重连', onPress: () => host.retry() }}
      />
    )
  } else if (!entry) {
    body = <SkeletonRows count={4} avatar={false} />
  } else {
    const waits = workflow?.steps.filter((s) => s.by === 'you' || s.youReview).length ?? 0
    body = (
      <>
        <View style={styles.title}>
          <LargeTitle title={entryName(entry)} subtitle={sourceText(entry)} />
          {problem ? (
            <View style={styles.badges}>
              <Tag
                label={ENTRY_STATE_TEXT[problem]}
                color={problem === 'pending' || problem === 'changed' ? c.warning : c.danger}
                background={c.fill}
              />
            </View>
          ) : null}
        </View>
        {problem === 'pending' || problem === 'changed' ? (
          <Approval entry={entry} text={read?.text ?? null} onChanged={load} />
        ) : problem ? (
          <NeedCard
            icon="warning"
            tone="danger"
            title={ENTRY_STATE_TITLE[problem]}
            body={
              entry.problems.length > 0 ? (
                <View style={styles.problems}>
                  {entry.problems.map((p, i) => (
                    <Text
                      key={i}
                      selectable
                      style={[typeScale.footnote, { color: c.textSecondary }]}
                    >
                      {p.at ? `${p.at}：` : ''}
                      {p.message}
                    </Text>
                  ))}
                </View>
              ) : undefined
            }
          />
        ) : (
          <Pill
            tone="accent"
            size="lg"
            label="用它开始一个需求"
            disabled={!connected}
            onPress={() => router.push({ pathname: '/start-task', params: { workflow: entry.id } })}
            style={styles.start}
          />
        )}
        {workflow ? (
          <>
            {entryDescription(entry) ? (
              <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Markdown markdown={entryDescription(entry)} size="compact" />
              </View>
            ) : null}
            <Text style={[typeScale.footnote, styles.facts, { color: c.textSecondary }]}>
              {workflow.steps.length} 步{waits > 0 ? ` · ${waits} 步等你` : ''} · 退回每条最多{' '}
              {workflow.sendBackLimit} 次
            </Text>
            <View>
              <SectionHeader title="步骤" count={workflow.steps.length} />
              <View style={styles.steps}>
                {workflow.steps.map((step, i) => (
                  <StepCard key={step.id} workflow={workflow} index={i} />
                ))}
              </View>
            </View>
          </>
        ) : null}
      </>
    )
  }

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.lg,
        }}
        refreshControl={pull}
      >
        {body}
      </Animated.ScrollView>
      <NavBar header={header} title={entry ? entryName(entry) : '工作流'} />
    </Screen>
  )
}

/**
 * Approval of a workflow the user has not approved, or that changed since: what it is, its file as
 * read, and Approve for that very file. A file that changed while shown is read again first.
 */
function Approval(props: {
  entry: WireWorkflowEntry
  text: string | null
  onChanged(): Promise<void>
}) {
  const { entry } = props
  const { c } = useTokens()
  const host = useHost()
  const request = useRequest()
  const [notice, setNotice] = useState<string | null>(null)
  const origin = entry.origin
  const title =
    entry.approval === 'changed'
      ? '批准之后，这个工作流又被改过'
      : entry.source === 'agent'
        ? '这个工作流由 Agent 创建，你批准之后才能使用。'
        : '你批准之后才能使用这个工作流'
  const check =
    '看看每一步做什么、要用的工具、在哪里等你，然后决定。你批准的是这个版本；以后的任何改动都要再批准。'
  const from =
    entry.approval === 'changed'
      ? '批准这个版本之前，它不能开始需求。再看一遍每一步和它的文件，然后决定。'
      : origin?.kind === 'agent'
        ? `${host.agents.get(origin.agentId)?.name ?? origin.agentId} 在一个会话里用 create_workflow 写了它。 ${check}`
        : origin?.kind === 'community'
          ? `从 Marketplace 添加，发布者 ${origin.handle}，版本 ${origin.version}。 ${check}`
          : origin?.kind === 'github'
            ? `从 GitHub 上的 ${/github\.com\/([^/]+\/[^/]+)/i.exec(origin.url)?.[1] ?? 'GitHub'} 添加。 ${check}`
            : origin?.kind === 'file'
              ? `从 ${origin.name} 添加。 ${check}`
              : `放进这台电脑工作流文件夹的一个文件。 ${check}`

  const approve = () => {
    if (!host.link) return
    const link = host.link
    setNotice(null)
    void request.run('approve', async () => {
      try {
        await call(link, 'workflows.approve', { workflowId: entry.id, hash: entry.hash })
      } catch (failure) {
        if ((failure as { code?: unknown } | null)?.code === 'conflict') {
          setNotice('你查看时文件被改动了。这是新版本，请再看一遍再批准。')
          await props.onChanged()
        }
        throw failure
      }
      await props.onChanged()
    })
  }

  return (
    <NeedCard
      icon="shield"
      tone="warning"
      title={title}
      body={from}
      error={notice ?? (request.error ? `无法批准：${request.error}` : null)}
    >
      <View style={[styles.file, { backgroundColor: c.fill }]}>
        <Text style={[typeScale.caption, { color: c.textSecondary }]}>文件 · 你要批准的版本</Text>
        {props.text === null ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>文件已不在。</Text>
        ) : (
          <Clamp maxHeight={220} more="显示">
            <Text selectable style={[styles.mono, { color: c.text }]}>
              {props.text}
            </Text>
          </Clamp>
        )}
      </View>
      <Actions>
        <ActionButton
          label="批准"
          tone="primary"
          busy={request.busy === 'approve'}
          disabled={host.state.kind !== 'connected' || props.text === null}
          onPress={approve}
        />
      </Actions>
    </NeedCard>
  )
}

/** One step as the page lists it: who does it, what it asks, its outcomes and where they lead. */
function StepCard(props: { workflow: Workflow; index: number }) {
  const { workflow, index } = props
  const step = workflow.steps[index]!
  const { c } = useTokens()
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.stepHead}>
        <Text style={[typeScale.caption, styles.number, { color: c.textTertiary }]}>
          {index + 1}
        </Text>
        <Text style={[typeScale.headline, styles.flex, { color: c.text }]}>
          {stepTitle(workflow, step.id)}
        </Text>
        <Tag
          label={step.by === 'you' ? '你' : 'Auto'}
          color={step.by === 'you' ? c.warning : c.textSecondary}
          background={c.fill}
        />
        {step.youReview ? <Tag label="你审阅" color={c.warning} background={c.fill} /> : null}
      </View>
      <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
        {[
          index === 0 && step.by === 'agent' ? '第一步：你开始时选的 Agent' : null,
          step.by === 'you' ? '你的步骤：纸鸢会问你，等你回答' : null,
          step.reviewOf.length > 0
            ? `审查 ${step.reviewOf.map((id) => stepTitle(workflow, id)).join('、')}；不能是同一个 Agent 加同一个模型`
            : null,
          step.handIn === 'document' ? '交一份文档' : step.handIn === 'note' ? '交一段说明' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {step.prompt.trim() ? (
        <Clamp maxHeight={96} more="更多">
          <Markdown markdown={step.prompt} size="compact" color={c.textSecondary} />
        </Clamp>
      ) : null}
      {step.hint ? (
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
          给选人的提示：“{step.hint}”
        </Text>
      ) : null}
      {step.tools.mcp.length + step.tools.skills.length > 0 ? (
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          使用 {[...step.tools.mcp, ...step.tools.skills].join('、')}
        </Text>
      ) : null}
      {step.outcomes.length > 0 ? (
        <View style={styles.outcomes}>
          {step.outcomes.map((outcome) => {
            const back = isBackArrow(workflow, step.id, outcome)
            const to = outcome.to.map((id) => stepTitle(workflow, id)).join('、')
            return (
              <Text
                key={outcome.name}
                style={[typeScale.footnote, { color: back ? c.warning : c.textSecondary }]}
              >
                {outcome.name}
                {outcome.end
                  ? ` → 结束：${outcome.end === 'done' ? '完成' : '放弃'}`
                  : back
                    ? ` ↩ 退回到 ${to}，最多 ${outcome.limit ?? workflow.sendBackLimit} 次`
                    : ` → ${to}${outcome.to.length > 1 ? '（同时）' : ''}`}
              </Text>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { paddingHorizontal: space.xs, gap: space.xs },
  badges: { flexDirection: 'row', gap: space.xs },
  problems: { gap: 2 },
  start: { alignSelf: 'flex-start' },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
  },
  facts: { marginHorizontal: space.xs },
  steps: { gap: space.md },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  number: { width: 18, fontVariant: ['tabular-nums'] },
  outcomes: { gap: 2, marginTop: space.xs },
  file: { borderRadius: radius.md, padding: space.md, gap: space.xs },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
})

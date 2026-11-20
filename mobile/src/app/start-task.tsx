// Starting a task: a workflow from the library that may start tasks, the requirement, the pace,
// the project and the agent of the first step, as the desktop's New session does with a workflow
// chosen. In a Git repository the task gets a worktree and a branch cut from the current one.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { AgentId } from '@shared/agents'
import type { Pace, WireWorkflowEntry, Workflow } from '@shared/workflow'
import { call } from '../git'
import { useHost } from '../host'
import { errorText, folder } from '../sessions'
import {
  canDoSteps,
  entryName,
  entryProblem,
  PACE_TEXT,
  PACES,
  stepTitle,
  taskRequest,
  usableWorkflow,
  useWorkflowLibrary,
} from '../tasks'
import { AgentGlyph } from '../ui/AgentAvatar'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { LargeTitle } from '../ui/LargeTitle'
import { NavBar } from '../ui/NavBar'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SkeletonRows } from '../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

type Usable = WireWorkflowEntry & { workflow: Workflow }

export default function StartTask() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ project?: string; workflow?: string }>()
  const library = useWorkflowLibrary()
  const usable = useMemo(
    () => library.entries.filter((e): e is Usable => usableWorkflow(e)),
    [library.entries],
  )
  const waiting = library.entries.filter((e) => {
    const problem = entryProblem(e)
    return problem === 'pending' || problem === 'changed'
  }).length
  const projects = useMemo(
    () => host.projects.filter((p) => !p.missing).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [host.projects],
  )
  const agents = useMemo(
    () =>
      [...host.agents.values()].filter(
        (a) =>
          canDoSteps(a.harnessId) &&
          !a.disabled &&
          !a.uninstalled &&
          !a.hidden &&
          a.registered !== false,
      ),
    [host.agents],
  )

  const [workflowId, setWorkflowId] = useState<string | null>(params.workflow ?? null)
  const [text, setText] = useState('')
  const [pace, setPace] = useState<Pace>('balanced')
  const [projectPath, setProjectPath] = useState<string | null>(params.project ?? null)
  const [agentId, setAgentId] = useState<AgentId | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connected = host.state.kind === 'connected'

  // Defaults once the lists are read: the first usable workflow, the latest project, the default
  // agent that can do steps.
  useEffect(() => {
    if (!workflowId && usable[0]) setWorkflowId(usable[0].id)
  }, [workflowId, usable])
  useEffect(() => {
    if (!projectPath && projects[0]) setProjectPath(projects[0].path)
  }, [projectPath, projects])
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId((agents.find((a) => a.isDefault) ?? agents[0]).id)
  }, [agentId, agents])

  const chosen = usable.find((e) => e.id === workflowId) ?? null
  const firstByAgent = chosen?.workflow.steps[0]?.by === 'agent'

  const problem = !chosen
    ? '先选一个工作流。'
    : !text.trim()
      ? '先写好需求。'
      : !projectPath
        ? '先选一个项目。'
        : !agentId
          ? '工作流的步骤只能由 Claude Code 和 Codex 的 Agent 来做：请选其中一个。'
          : null

  const start = async () => {
    if (problem || !chosen || !projectPath || !agentId || !host.link) return
    const link = host.link
    haptic.tap()
    setStarting(true)
    setError(null)
    try {
      // A task in a Git repository works in its own worktree, cut from the branch checked out.
      const status = await call(link, 'git.status', { projectPath }).catch(() => null)
      const base = status?.repo ? (status.head.branch ?? status.head.oid) : null
      const view = await taskRequest(link, 'tasks.start', {
        projectPath,
        workflowId: chosen.id,
        text: text.trim(),
        pace,
        agentId,
        options: {},
        ...(base ? { worktree: { base } } : {}),
      })
      haptic.success()
      router.replace(`/task/${view.id}`)
    } catch (failure) {
      haptic.warning()
      setError(errorText(failure))
      setStarting(false)
    }
  }

  const label = (title: string, right?: string) => (
    <View style={styles.labelLine}>
      <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>{title}</Text>
      {right ? <Text style={[typeScale.footnote, { color: c.textTertiary }]}>{right}</Text> : null}
    </View>
  )

  const chip = (key: string, text: string, on: boolean, onPress: () => void, lead?: ReactNode) => (
    <Press
      key={key}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      style={[
        styles.chip,
        { backgroundColor: on ? c.tintSoft : c.fill, borderColor: on ? c.tint : 'transparent' },
      ]}
    >
      {lead}
      <Text style={[typeScale.subhead, { color: on ? c.tint : c.textSecondary }]} numberOfLines={1}>
        {text}
      </Text>
    </Press>
  )

  const workflows = () => {
    if (library.error && !library.loaded) {
      return (
        <EmptyState
          tone="error"
          icon="warning"
          title="没能读到工作流"
          message={library.error}
          action={{ label: '重试', onPress: () => void library.reload() }}
        />
      )
    }
    if (!library.loaded) return <SkeletonRows count={3} avatar={false} />
    if (usable.length === 0) {
      return (
        <EmptyState
          icon="flow"
          title="还没有能用的工作流"
          message={
            waiting > 0
              ? `${waiting} 个工作流在等你批准。批准之后，它才能开始需求。`
              : '在任意会话里让 Agent 帮你写一个，或在电脑上的插件市场里添加。'
          }
          action={{ label: '查看工作流', onPress: () => router.push('/workflows') }}
        />
      )
    }
    return (
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        {usable.map((entry, i) => {
          const on = entry.id === workflowId
          const waits = entry.workflow.steps.filter((s) => s.by === 'you' || s.youReview).length
          return (
            <View key={entry.id}>
              {i > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
              <Press
                onPress={() => {
                  haptic.select()
                  setWorkflowId(entry.id)
                }}
                scale={false}
                highlight={c.fill}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                style={styles.workflow}
              >
                <View style={styles.flexGap}>
                  <Text style={[typeScale.body, { color: c.text, fontWeight: on ? '600' : '400' }]}>
                    {entryName(entry)}
                  </Text>
                  <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={2}>
                    {entry.workflow.steps.map((s) => stepTitle(entry.workflow, s.id)).join(' → ')}
                  </Text>
                  <Text style={[typeScale.caption, { color: c.textTertiary }]}>
                    {entry.workflow.steps.length} 步{waits > 0 ? ` · ${waits} 步等你` : ''}
                  </Text>
                </View>
                <Icon
                  name={on ? 'succeeded' : 'skipped'}
                  size={22}
                  color={on ? c.tint : c.borderStrong}
                />
              </Press>
            </View>
          )
        })}
      </View>
    )
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.ScrollView
          {...header.scrollProps}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            paddingTop: header.contentTop,
            paddingHorizontal: space.lg,
            paddingBottom: insets.bottom + space.xxxl,
            gap: space.sm,
          }}
        >
          <View style={styles.title}>
            <LargeTitle
              title="开始一个需求"
              subtitle="选一个工作流，写下要做的事。每一步一个会话，要你拍板时会停下来等你。"
            />
          </View>

          {label('工作流', waiting > 0 ? `${waiting} 个等你批准` : undefined)}
          {workflows()}
          <Press
            onPress={() => router.push('/workflows')}
            scale={false}
            accessibilityRole="button"
            style={styles.library}
          >
            <Text style={[typeScale.footnote, { color: c.tint }]}>查看全部工作流</Text>
            <Icon name="chevronRight" size={11} color={c.tint} weight="semibold" />
          </Press>

          {label('需求')}
          <TextInput
            value={text}
            onChangeText={(next) => {
              setText(next)
              setError(null)
            }}
            placeholder="要做什么？写清楚目标和要求，第一步会从这里开始。"
            placeholderTextColor={c.textTertiary}
            multiline
            textAlignVertical="top"
            accessibilityLabel="需求"
            style={[typeScale.body, styles.input, { color: c.text, backgroundColor: c.fill }]}
          />

          {label('Pace')}
          <SegmentedControl<Pace> segments={PACES} value={pace} onChange={setPace} />

          {label('项目')}
          {projects.length === 0 ? (
            <Text style={[typeScale.footnote, styles.note, { color: c.textTertiary }]}>
              电脑上还没有项目。需求要在一个项目里进行。
            </Text>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.row}
            >
              {projects.map((p) =>
                chip(p.path, p.name || folder(p.path), p.path === projectPath, () =>
                  setProjectPath(p.path),
                ),
              )}
            </ScrollView>
          )}

          {label(firstByAgent || !chosen ? '第一步的 Agent' : '第一步')}
          {chosen && !firstByAgent ? (
            <Text style={[typeScale.footnote, styles.note, { color: c.textTertiary }]}>
              第一步由你来做；之后的步骤由交棒的 Agent 选人。
            </Text>
          ) : agents.length === 0 ? (
            <Text style={[typeScale.footnote, styles.note, { color: c.warning }]}>
              工作流的步骤只能由 Claude Code 和 Codex 的 Agent 来做：电脑上还没有可用的。
            </Text>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.row}
            >
              {agents.map((a) =>
                chip(
                  a.id,
                  a.name,
                  a.id === agentId,
                  () => setAgentId(a.id),
                  <AgentGlyph agentId={a.id} name={a.name} size={15} />,
                ),
              )}
            </ScrollView>
          )}

          {error ? (
            <Text
              accessibilityRole="alert"
              style={[typeScale.footnote, styles.note, { color: c.danger }]}
            >
              {error}
            </Text>
          ) : null}
          <Press
            onPress={() => void start()}
            disabled={starting || problem !== null || !connected}
            accessibilityRole="button"
            accessibilityState={{ busy: starting, disabled: problem !== null || !connected }}
            style={[
              styles.button,
              { backgroundColor: c.accent, opacity: problem || !connected ? 0.45 : 1 },
            ]}
          >
            {starting ? (
              <ActivityIndicator color={c.onAccent} />
            ) : (
              <Text style={[typeScale.headline, { color: c.onAccent }]}>开始</Text>
            )}
          </Press>
          <Text style={[typeScale.footnote, styles.center, { color: c.textTertiary }]}>
            {!connected
              ? '连上电脑后才能开始。'
              : (problem ??
                `Pace：${PACE_TEXT[pace]} · Auto 的步骤开始时才选人。在 Git 仓库里，需求在自己的工作树和分支上进行。`)}
          </Text>
        </Animated.ScrollView>
      </KeyboardAvoidingView>
      <NavBar header={header} title="开始一个需求" />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexGap: { flex: 1, gap: 2 },
  title: { paddingHorizontal: space.xs, paddingBottom: space.sm },
  labelLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
    marginHorizontal: space.xs,
  },
  label: { fontWeight: '600' },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  workflow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  library: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-end',
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
  },
  input: {
    borderRadius: radius.md,
    paddingHorizontal: space.md + 2,
    paddingTop: space.md,
    paddingBottom: space.md,
    minHeight: 120,
    maxHeight: 260,
  },
  row: { gap: space.sm, paddingRight: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 36,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: { marginHorizontal: space.xs },
  button: {
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.lg,
  },
  center: { textAlign: 'center', marginTop: space.xs },
})

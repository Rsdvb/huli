// The sheet that makes a routine, or changes one: its name and prompt, the agent and project its
// runs use, when it runs, and what a run may do without asking. An example opens it filled in, and
// nothing runs until the user creates it.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import type {
  PermissionScope,
  RoutineChanges,
  RoutineDraft,
  RoutineView,
  Schedule,
} from '@shared/routines'
import type { AgentId } from '@shared/agents'
import {
  DEFAULT_KEPT_RUN_SESSIONS,
  DEFAULT_ON_LIMIT,
  DEFAULT_TIME_LIMIT,
  type OnLimit,
} from '@shared/routines'
import { useAgents, useConnected, useMaybeLink, useProjects } from '../host'
import { LEVEL_TEXT, scheduleText, scopeText } from '../routines'
import { errorText } from '../sessions'
import { AgentGlyph } from '../ui/AgentAvatar'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../ui/haptics'
import { Press } from '../ui/Press'
import { SegmentedControl } from '../ui/SegmentedControl'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

export interface EditorSeed {
  name: string
  prompt: string
  schedule: Schedule
  scope: PermissionScope
  agentId?: AgentId
  projectPath?: string | null
  onLimit?: OnLimit
}

type Pattern = 'daily' | 'weekdays' | 'weekly' | 'every' | 'kept'

const PATTERN_TEXT: Record<Pattern, string> = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  every: '每隔',
  kept: '原计划',
}

const DAYS = ['日', '一', '二', '三', '四', '五', '六']
const HOURS = [1, 2, 3, 4, 6, 8, 12]
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function patternOf(schedule: Schedule): Pattern {
  if (schedule.kind === 'every') return schedule.minutes % 60 === 0 ? 'every' : 'kept'
  if (schedule.kind !== 'weekly') return 'kept'
  const key = [...schedule.days].sort().join('')
  return key === '0123456' ? 'daily' : key === '12345' ? 'weekdays' : 'weekly'
}

function midnight(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Accepts 9:00, 0900 and 9 as well as 09:00. */
function normalTime(text: string): string | null {
  const t = text.trim().replace('：', ':')
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(t)
  if (!m) return null
  const value = `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}`
  return TIME.test(value) ? value : null
}

export function RoutineEditor(props: {
  /** What it starts from; null keeps it closed. */
  seed: EditorSeed | null
  /** The routine it changes; a new one is made without it. */
  routine?: RoutineView
  onClose(): void
  onSaved?(routine: RoutineView): void
}) {
  const { c } = useTokens()
  const allAgents = useAgents()
  const allProjects = useProjects()
  const link = useMaybeLink()
  const connected = useConnected()
  const agents = useMemo(
    () =>
      [...allAgents.values()].filter(
        (a) => !a.hidden && !a.disabled && !a.uninstalled && a.registered !== false,
      ),
    [allAgents],
  )
  const projects = useMemo(
    () => allProjects.filter((p) => !p.missing).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [allProjects],
  )

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState<AgentId | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [original, setOriginal] = useState<Schedule | null>(null)
  const [pattern, setPattern] = useState<Pattern>('weekdays')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [time, setTime] = useState('09:00')
  const [hours, setHours] = useState(6)
  const [scope, setScope] = useState<PermissionScope>({ level: 'read', web: false })
  const [onLimit, setOnLimit] = useState<OnLimit>(DEFAULT_ON_LIMIT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seed = props.seed
  useEffect(() => {
    if (!seed) return
    setName(seed.name)
    setPrompt(seed.prompt)
    setAgentId(seed.agentId ?? agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? null)
    setProjectPath(seed.projectPath !== undefined ? seed.projectPath : (projects[0]?.path ?? null))
    setOriginal(seed.schedule)
    setPattern(patternOf(seed.schedule))
    if (seed.schedule.kind === 'weekly') {
      setDays(seed.schedule.days)
      setTime(seed.schedule.time)
    }
    if (seed.schedule.kind === 'every')
      setHours(Math.max(1, Math.round(seed.schedule.minutes / 60)))
    setScope(seed.scope)
    setOnLimit(seed.onLimit ?? DEFAULT_ON_LIMIT)
    setSaving(false)
    setError(null)
    // The seed alone decides what the form starts from; the lists only fill in defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const schedule: Schedule | null = (() => {
    switch (pattern) {
      case 'kept':
        return original
      case 'every':
        return {
          kind: 'every',
          minutes: hours * 60,
          from: original?.kind === 'every' ? original.from : midnight(),
        }
      default: {
        const at = normalTime(time)
        const chosen =
          pattern === 'daily'
            ? [0, 1, 2, 3, 4, 5, 6]
            : pattern === 'weekdays'
              ? [1, 2, 3, 4, 5]
              : days
        if (!at || chosen.length === 0) return null
        return { kind: 'weekly', days: [...chosen].sort(), time: at }
      }
    }
  })()

  const problem = !prompt.trim()
    ? '先写提示词。'
    : !agentId
      ? '先选一个 Agent。'
      : !schedule
        ? pattern === 'weekly' && days.length === 0
          ? '至少选一天。'
          : '时间写成 09:00 这样。'
        : null

  const save = async () => {
    if (problem || !schedule || !agentId || !link) return
    setSaving(true)
    setError(null)
    try {
      let saved: RoutineView
      if (props.routine) {
        const changes: RoutineChanges = {
          name: name.trim(),
          prompt: prompt.trim(),
          projectPath,
          // Huli: one that runs on a GitHub event keeps it; the phone edits only its schedule.
          trigger:
            props.routine.trigger.kind === 'github'
              ? { ...props.routine.trigger, schedule }
              : { kind: 'schedule', schedule },
          scope,
          onLimit,
          ...(agentId !== props.routine.agentId ? { agentId, options: [] } : {}),
        }
        saved = (await link.request('routines.update', {
          routineId: props.routine.id,
          changes,
        })) as RoutineView
      } else {
        const draft: RoutineDraft = {
          name: name.trim(),
          prompt: prompt.trim(),
          agentId,
          projectPath,
          options: [],
          trigger: { kind: 'schedule', schedule },
          scope,
          timeLimitMinutes: DEFAULT_TIME_LIMIT,
          keptRunSessions: DEFAULT_KEPT_RUN_SESSIONS,
          onLimit,
        }
        saved = (await link.request('routines.create', draft)) as RoutineView
      }
      haptic.success()
      props.onClose()
      props.onSaved?.(saved)
    } catch (failure) {
      haptic.warning()
      setError(errorText(failure))
      setSaving(false)
    }
  }

  const chip = (label: string, on: boolean, onPress: () => void, key: string, lead?: ReactNode) => (
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
        {
          backgroundColor: on ? c.tintSoft : c.fill,
          borderColor: on ? c.tint : 'transparent',
        },
      ]}
    >
      {lead}
      <Text style={[typeScale.subhead, { color: on ? c.tint : c.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  )

  const label = (text: string) => (
    <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>{text}</Text>
  )

  return (
    <BottomSheet
      solid
      visible={seed !== null}
      onClose={props.onClose}
      title={props.routine ? '编辑定时任务' : '新建定时任务'}
      message={
        props.routine ? undefined : '看一眼再创建；创建之前什么都不会运行。之后可以随时改或关掉。'
      }
      maxHeight={680}
    >
      {label('名称')}
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="不写就用提示词的第一行"
        placeholderTextColor={c.textTertiary}
        maxLength={60}
        returnKeyType="next"
        style={[typeScale.body, styles.input, { color: c.text, backgroundColor: c.fill }]}
      />
      {label('提示词')}
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder="每次运行时，Agent 要做什么？"
        placeholderTextColor={c.textTertiary}
        multiline
        textAlignVertical="top"
        style={[
          typeScale.body,
          styles.input,
          styles.prompt,
          { color: c.text, backgroundColor: c.fill },
        ]}
      />

      {label('Agent')}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {agents.length === 0 ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
            电脑上没有可用的 Agent。
          </Text>
        ) : (
          agents.map((a) =>
            chip(
              a.name,
              a.id === agentId,
              () => setAgentId(a.id),
              a.id,
              <AgentGlyph agentId={a.id} name={a.name} size={15} />,
            ),
          )
        )}
      </ScrollView>

      {label('项目')}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {projects.map((p) =>
          chip(p.name, p.path === projectPath, () => setProjectPath(p.path), p.path),
        )}
        {chip('无项目', projectPath === null, () => setProjectPath(null), '__none')}
      </ScrollView>

      {label('计划')}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {(['daily', 'weekdays', 'weekly', 'every'] as Pattern[]).map((p) =>
          chip(PATTERN_TEXT[p], pattern === p, () => setPattern(p), p),
        )}
        {original && patternOf(original) === 'kept'
          ? chip(scheduleText(original), pattern === 'kept', () => setPattern('kept'), 'kept')
          : null}
      </ScrollView>
      {pattern === 'weekly' ? (
        <View style={styles.days}>
          {DAYS.map((d, i) => {
            const on = days.includes(i)
            return (
              <Press
                key={d}
                onPress={() => {
                  haptic.select()
                  setDays((list) => (on ? list.filter((x) => x !== i) : [...list, i]))
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`周${d}`}
                style={[styles.day, { backgroundColor: on ? c.tint : c.fill }]}
              >
                <Text style={[typeScale.subhead, { color: on ? c.onAccent : c.textSecondary }]}>
                  {d}
                </Text>
              </Press>
            )
          })}
        </View>
      ) : null}
      {pattern === 'daily' || pattern === 'weekdays' || pattern === 'weekly' ? (
        <View style={styles.timeLine}>
          <Text style={[typeScale.callout, { color: c.text }]}>时间</Text>
          <TextInput
            value={time}
            onChangeText={setTime}
            onBlur={() => {
              const t = normalTime(time)
              if (t) setTime(t)
            }}
            placeholder="09:00"
            placeholderTextColor={c.textTertiary}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            accessibilityLabel="运行时间"
            style={[typeScale.body, styles.time, { color: c.text, backgroundColor: c.fill }]}
          />
          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>按电脑的本地时间</Text>
        </View>
      ) : null}
      {pattern === 'every' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {HOURS.map((h) => chip(`${h} 小时`, hours === h, () => setHours(h), String(h)))}
        </ScrollView>
      ) : null}

      {label('权限')}
      <SegmentedControl
        segments={(['read', 'edit', 'commands'] as const).map((key) => ({
          key,
          label: LEVEL_TEXT[key],
        }))}
        value={scope.level}
        onChange={(level) => setScope((s) => ({ ...s, level }))}
      />
      <View style={styles.webLine}>
        <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>可联网</Text>
        <Switch
          value={scope.web}
          onValueChange={(web) => {
            haptic.select()
            setScope((s) => ({ ...s, web }))
          }}
          trackColor={{ true: c.success }}
          accessibilityLabel="可联网"
        />
      </View>
      <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
        {scope.level === 'read'
          ? '只读：只能读取和搜索项目。'
          : scope.level === 'edit'
            ? '可编辑：还能在项目文件夹里新建、修改和删除文件。'
            : '可编辑和运行：还能运行命令，这些命令能做你能做的任何事。'}
        超出权限的操作会停下来等你批准。
      </Text>

      {label('额度用完时')}
      <SegmentedControl<OnLimit>
        segments={[
          { key: 'wait', label: '等待恢复' },
          { key: 'switch', label: '换用有额度的 Agent' },
        ]}
        value={onLimit}
        onChange={(next) => setOnLimit(next)}
      />
      <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
        {onLimit === 'wait'
          ? 'Agent 的套餐额度用完时，等它恢复后再运行，并通知你等到什么时候。'
          : 'Agent 的套餐额度用完时，换用另一个还有额度的 Agent；没有可换的就等待。运行记录会写明换成了谁。'}
      </Text>

      {error ? <Text style={[typeScale.footnote, { color: c.danger }]}>{error}</Text> : null}
      <Press
        onPress={() => void save()}
        disabled={saving || problem !== null || !connected}
        accessibilityRole="button"
        style={[styles.button, { backgroundColor: c.accent }]}
      >
        {saving ? (
          <ActivityIndicator color={c.onAccent} />
        ) : (
          <Text style={[typeScale.headline, { color: c.onAccent }]}>
            {props.routine ? '保存' : '创建'}
          </Text>
        )}
      </Press>
      <Text style={[typeScale.footnote, styles.center, { color: c.textTertiary }]}>
        {problem ??
          (connected
            ? `${schedule ? scheduleText(schedule) : ''} · ${scopeText(scope)}`
            : '连上电脑后才能保存。')}
      </Text>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  label: { marginTop: space.xs, marginLeft: space.xs },
  input: {
    borderRadius: radius.md,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    minHeight: 46,
  },
  prompt: { minHeight: 96, maxHeight: 180 },
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
  days: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  timeLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  time: {
    width: 88,
    height: 40,
    borderRadius: radius.sm,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  webLine: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xs },
  button: {
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  center: { textAlign: 'center' },
})

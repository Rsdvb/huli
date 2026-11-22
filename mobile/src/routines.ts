// Routines as the phone words and loads them: schedules and scopes in Chinese, the ready-made
// examples (the desktop's, from src/renderer/src/features/routines/examples.ts), and the list,
// kept current by the computer's events.

import { useCallback, useEffect, useState } from 'react'
import { Alert } from 'react-native'
import type { HostEvent, RoutineList } from '@shared/agent-host'
import type { GithubEvent } from '@shared/github-flow'
import type {
  PermissionScope,
  RoutineTrigger,
  RoutineView,
  RunStatus,
  Schedule,
} from '@shared/routines'
import { useHostState, useMaybeLink, withinRefreshLimit } from './host'
import { clockOf, errorText } from './sessions'
import { haptic } from './ui/haptics'
import type { IconName } from './ui/Icon'
import type { Palette } from './ui/tokens'

const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

/** 'HH:mm' as the phone's clock says it: 上午9:00. */
export function clockText(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const date = new Date(2000, 0, 1, h ?? 0, m ?? 0)
  return clockOf(date.getTime())
}

/** Huli: when a routine runs: its schedule, or the GitHub event it runs on. */
export function triggerText(trigger: RoutineTrigger): string {
  return trigger.kind === 'github' ? eventText(trigger.event) : scheduleText(trigger.schedule)
}

function eventText(event: GithubEvent): string {
  switch (event.kind) {
    case 'issue_opened':
      return event.label ? `有带 ${event.label} 标签的新议题时` : '有新议题时'
    case 'pr_opened':
      return '有新拉取请求时'
    case 'checks_failed':
      return '检查失败时'
    case 'pushed':
      return `推送到 ${event.branch} 时`
    case 'behind':
      return `${event.branch} 落后时`
  }
}

export function scheduleText(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once': {
      const [date, time] = schedule.at.split('T')
      const [, month, day] = (date ?? '').split('-')
      return `${Number(month)}月${Number(day)}日 ${clockText(time ?? '00:00')}，仅一次`
    }
    case 'every':
      return schedule.minutes % 60 === 0
        ? schedule.minutes === 60
          ? '每小时'
          : `每 ${schedule.minutes / 60} 小时`
        : `每 ${schedule.minutes} 分钟`
    case 'weekly': {
      const days = [...schedule.days].sort()
      const key = days.join('')
      const when =
        days.length === 7
          ? '每天'
          : key === '12345'
            ? '工作日'
            : key === '06'
              ? '周末'
              : `每周${days.map((d) => DAY_NAMES[d]).join('、')}`
      return `${when} ${clockText(schedule.time)}`
    }
    case 'cron':
      return `Cron ${schedule.expression}`
  }
}

export const LEVEL_TEXT: Record<PermissionScope['level'], string> = {
  read: '只读',
  edit: '可编辑',
  commands: '可编辑和运行',
}

export function scopeText(scope: PermissionScope): string {
  return scope.web ? `${LEVEL_TEXT[scope.level]}，可联网` : LEVEL_TEXT[scope.level]
}

export const RUN_TEXT: Record<RunStatus, string> = {
  queued: '排队中',
  starting: '正在开始',
  running: '运行中',
  waiting: '等你批准',
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已取消',
  interrupted: '已中断',
  skipped: '已跳过',
}

export function runLook(c: Palette, status: RunStatus): { icon: IconName; color: string } {
  switch (status) {
    case 'succeeded':
      return { icon: 'succeeded', color: c.success }
    case 'failed':
    case 'timed_out':
      return { icon: 'failed', color: c.danger }
    case 'waiting':
      return { icon: 'warning', color: c.warning }
    case 'queued':
    case 'starting':
    case 'running':
      return { icon: 'timer', color: c.tint }
    default:
      return { icon: 'skipped', color: c.textTertiary }
  }
}

export const STATE_TEXT: Record<RoutineView['state'], string> = {
  on: '已开启',
  off: '已关闭',
  done: '已完成',
  paused: '已暂停',
}

export interface RoutineExample {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  scope: PermissionScope
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

function midnight(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** The desktop's examples, in the same order and words. */
export function routineExamples(): RoutineExample[] {
  return [
    {
      id: 'triage',
      name: '早间梳理',
      prompt: '总结上次运行以来新开或更新的 issue 和 Pull Request，标出紧急的。',
      schedule: { kind: 'weekly', days: WEEKDAYS, time: '09:00' },
      scope: { level: 'read', web: false },
    },
    {
      id: 'tests',
      name: '夜间测试',
      prompt: '跑完整的测试，逐个说明失败和可能的原因。',
      schedule: { kind: 'weekly', days: EVERY_DAY, time: '02:00' },
      scope: { level: 'commands', web: false },
    },
    {
      id: 'dependencies',
      name: '依赖检查',
      prompt: '查依赖的更新和已知漏洞，说明哪些要紧。',
      schedule: { kind: 'weekly', days: [1], time: '08:30' },
      scope: { level: 'read', web: true },
    },
    {
      id: 'changelog',
      name: '更新日志草稿',
      prompt: '按区域整理本周合并的 Pull Request，写出发布说明的草稿。',
      schedule: { kind: 'weekly', days: [5], time: '17:00' },
      scope: { level: 'read', web: false },
    },
    {
      id: 'links',
      name: '文档链接检查',
      prompt: '找出文档里失效的链接和它们所在的页面。',
      schedule: { kind: 'every', minutes: 360, from: midnight() },
      scope: { level: 'read', web: true },
    },
    {
      id: 'review',
      name: '每周回顾',
      prompt: '总结这周项目里改了什么、还有什么没做完。',
      schedule: { kind: 'weekly', days: [0], time: '20:00' },
      scope: { level: 'read', web: false },
    },
  ]
}

/** Asks, then deletes the routine and its run sessions. */
export function confirmDeleteRoutine(
  request: (method: string, params: unknown) => Promise<unknown>,
  routine: RoutineView,
  done?: () => void,
): void {
  haptic.warning()
  Alert.alert(
    `删除「${routine.name}」？`,
    routine.sessions > 0 ? `它的 ${routine.sessions} 个运行会话会一并删除。` : '它还没有运行会话。',
    [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          request('routines.delete', { routineId: routine.id }).then(
            () => {
              haptic.success()
              done?.()
            },
            (failure: unknown) => Alert.alert('没能删除', errorText(failure)),
          )
        },
      },
    ],
  )
}

export interface RoutinesData {
  data: RoutineList | null
  error: string | null
  /** When the list was last read from the computer; null before. */
  syncedAt: number | null
  load(): Promise<void>
}

/** The computer's routines, read once connected and kept current by its events. */
export function useRoutineList(): RoutinesData {
  const link = useMaybeLink()
  const state = useHostState()
  const [data, setData] = useState<RoutineList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const connected = state.kind === 'connected'

  const load = useCallback(async () => {
    if (!link) return
    try {
      const list = await withinRefreshLimit(
        (signal) => link.request('routines.list', undefined, signal) as Promise<RoutineList>,
      )
      setData(list)
      setError(null)
      setSyncedAt(Date.now())
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [link])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw: unknown) => {
      const event = raw as HostEvent
      if (event.type === 'routine.changed') {
        setData((current) => {
          if (!current) return current
          const known = current.routines.some((r) => r.id === event.routine.id)
          return {
            ...current,
            routines: known
              ? current.routines.map((r) => (r.id === event.routine.id ? event.routine : r))
              : [...current.routines, event.routine],
          }
        })
      }
      if (event.type === 'routine.removed') {
        setData((current) =>
          current
            ? { ...current, routines: current.routines.filter((r) => r.id !== event.routineId) }
            : current,
        )
      }
    })
  }, [link])

  return { data, error, syncedAt, load }
}

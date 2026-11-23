// The host's own requests that wait for the user, as the desktop's access cards ask them: a new
// site, a first use of an app or a device, a folder's MCP servers and hooks, a step only a person
// can do, a write to global memory, a problem report and computer use's setup. Each waits above
// the composer as its card ('dock'); in the conversation ('thread') it is a line that says it waits,
// then the quiet line of its answer.

import { Pressable, StyleSheet, Text } from 'react-native'
import type { ControlStep } from '@shared/control'
import type { HostLink } from '@shared/remote/link'
import {
  REPORT_SUBMIT_FAILURES,
  reportSubmitResult,
  type ReportSubmitFailure,
} from '@shared/report'
import type { ThreadEntry } from '@shared/thread'
import { originLabel } from '@shared/browser'
import { admin } from '../../admin'
import { call } from '../../git'
import { getHost, useAgent, useLink } from '../../host'
import { useComputer } from '../../ui/session/computer'
import { G } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { agentIdOf, useSessionField } from '../../ui/session/sessionField'
import {
  answeredDetail,
  AskCard,
  E,
  messageOf,
  QuietLine,
  useAnsweredAt,
  useSender,
  WaitingLine,
  type CardAction,
} from './kit'

type Of<K extends ThreadEntry['kind']> = Extract<ThreadEntry, { kind: K }>

export type Place = 'dock' | 'thread'

export function useAgentName(sessionId: string): string {
  const agent = useAgent(useSessionField(sessionId, agentIdOf))
  return agent?.name || 'Agent'
}

/** "Claude 想要打开网站", as the desktop's card title words it. */
const wants = (agent: string, action: string) => `${agent} 想要${action}`

/**
 * What a request card shares: its line while it waits, the card above the composer, and its answer
 * folded to a line once answered.
 */
function Request(props: {
  place: Place
  entryId: string
  waiting: boolean
  icon: Parameters<typeof AskCard>[0]['icon']
  title: string
  target?: string | null
  mono?: boolean
  body?: string | null
  list?: { title?: string; items: string[] } | null
  actions: CardAction[]
  footnote?: string | null
  answer: { text: string; allowed: boolean; device?: { id: string; name: string } | undefined }
  /** What the answered line names after its headline. */
  about?: string | null
}) {
  const sender = useSender(props.entryId)
  const at = useAnsweredAt(props.entryId, props.waiting)
  if (props.waiting) {
    if (props.place === 'thread') {
      return (
        <WaitingLine
          icon={props.icon}
          text={props.target ? `${props.title} · ${props.target}` : props.title}
        />
      )
    }
    return (
      <AskCard
        icon={props.icon}
        title={props.title}
        target={props.target ?? null}
        mono={!!props.mono}
        body={props.body ?? null}
        list={props.list ?? null}
        actions={props.actions}
        sender={sender}
        footnote={props.footnote ?? null}
      />
    )
  }
  if (props.place === 'dock') return null
  const detail = [props.about, answeredDetail(at, props.answer.device)].filter(Boolean).join(' · ')
  return (
    <QuietLine
      icon={props.answer.allowed ? G.done : G.failed}
      tone={props.answer.allowed ? 'done' : 'other'}
      text={props.answer.text}
      detail={detail || null}
    />
  )
}

// A new site.

const ORIGIN_ANSWER = {
  session: '本次会话已允许',
  project: '此项目已始终允许',
  deny: '已拒绝',
  timeout: '未在限定时间内得到答复',
} as const

export function BrowserOriginEntry(props: {
  entry: Of<'browser_origin'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const answer = (decision: 'session' | 'project' | 'deny') => () =>
    call(link, 'browser.answerOrigin', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={entry.decision === null}
      icon={E.site}
      title={wants(agent, '打开网站')}
      target={entry.origin}
      body="在本会话的浏览器里打开 · 带着你的登录状态"
      actions={[
        { key: 'deny', label: '不允许', tone: 'danger', run: answer('deny') },
        { key: 'session', label: '本会话内允许', tone: 'primary', run: answer('session') },
        {
          key: 'project',
          label: `在本项目中始终允许 ${originLabel(entry.origin)}`,
          run: answer('project'),
        },
      ]}
      answer={{
        text: ORIGIN_ANSWER[entry.decision ?? 'deny'],
        allowed: entry.decision === 'session' || entry.decision === 'project',
        device: entry.device,
      }}
      about={entry.origin}
    />
  )
}

// A first use of an app.

const APP_ANSWER = {
  session: '本次会话已允许',
  always: '已始终允许',
  deny: '已拒绝',
  timeout: '未在限定时间内得到答复',
} as const

export function ComputerAppEntry(props: {
  entry: Of<'computer_app'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const answer = (decision: 'session' | 'always' | 'deny') => () =>
    call(link, 'computer.answerApp', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={entry.decision === null}
      icon={E.app}
      title={wants(agent, '使用应用')}
      target={entry.appName}
      body="读取它的窗口，在后台点击和输入"
      actions={[
        { key: 'deny', label: '不允许', tone: 'danger', run: answer('deny') },
        { key: 'session', label: '本会话内允许', tone: 'primary', run: answer('session') },
        { key: 'always', label: `始终允许 ${entry.appName}`, run: answer('always') },
      ]}
      answer={{
        text: APP_ANSWER[entry.decision ?? 'deny'],
        allowed: entry.decision === 'session' || entry.decision === 'always',
        device: entry.device,
      }}
      about={entry.appName}
    />
  )
}

// A first use of a mobile device.

const DEVICE_ANSWER = {
  session: '本次会话已允许',
  always: '已始终允许',
  deny: '已拒绝',
  timeout: '没有及时回答',
} as const

/** Whether a device's request still waits: unanswered, and not past the time it counts as denied. */
export function deviceWaits(entry: Of<'device_access'>, now = Date.now()): boolean {
  return entry.decision === null && (entry.expiresAt === undefined || now < entry.expiresAt)
}

export function DeviceAccessEntry(props: {
  entry: Of<'device_access'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const waiting = deviceWaits(entry)
  const answer = (decision: 'session' | 'always' | 'deny') => () =>
    call(link, 'devices.answerAccess', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={waiting}
      icon={E.device}
      title={wants(agent, '使用设备')}
      target={entry.deviceName}
      body="点按、输入和截图，截图会交给这个 Agent 的模型服务商"
      actions={[
        { key: 'deny', label: '拒绝', tone: 'danger', run: answer('deny') },
        { key: 'session', label: '本次会话允许', tone: 'primary', run: answer('session') },
        { key: 'always', label: '始终允许这台设备', run: answer('always') },
      ]}
      answer={{
        text: entry.revoked
          ? '本次会话已允许，后来撤回'
          : DEVICE_ANSWER[entry.decision ?? 'timeout'],
        allowed: !entry.revoked && (entry.decision === 'session' || entry.decision === 'always'),
        device: entry.device,
      }}
      about={entry.deviceName}
    />
  )
}

// A folder's own MCP servers and hooks.

const MCP_ANSWER = {
  use: '已使用',
  all: '已使用这个项目的全部',
  skip: '未使用',
  timeout: '未回答',
} as const

export function ProjectMcpEntry(props: {
  entry: Of<'project_mcp'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const names = entry.servers.map((server) => server.name).join(', ')
  const answer = (decision: 'use' | 'all' | 'skip') => () =>
    call(link, 'sessions.answerProjectMcp', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={entry.decision === null}
      icon={E.mcp}
      title={wants(agent, '启动 MCP 服务器')}
      target={names}
      body="来自项目的 .mcp.json；使用后它们在这台电脑上以你的权限运行。"
      list={{
        title: '服务器',
        items: entry.servers.map((s) => (s.target ? `${s.name} · ${s.target}` : s.name)),
      }}
      actions={[
        { key: 'skip', label: '不使用', tone: 'danger', run: answer('skip') },
        { key: 'use', label: '使用', tone: 'primary', run: answer('use') },
        { key: 'all', label: '全部使用', run: answer('all') },
      ]}
      answer={{
        text: MCP_ANSWER[entry.decision ?? 'skip'],
        allowed: entry.decision === 'use' || entry.decision === 'all',
        device: entry.device,
      }}
      about={names}
    />
  )
}

const HOOKS_ANSWER = {
  use: '已允许',
  all: '已允许这个项目的全部',
  skip: '未运行',
  timeout: '未回答',
} as const

export function ProjectHooksEntry(props: {
  entry: Of<'project_hooks'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const events = [...new Set(entry.hooks.map((hook) => hook.event))].join(', ')
  const answer = (decision: 'use' | 'all' | 'skip') => () =>
    call(link, 'sessions.answerProjectHooks', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={entry.decision === null}
      icon={E.hooks}
      title={wants(agent, '运行这个项目设为自动执行的命令')}
      target={events}
      body="这个项目的 .claude 设置会在特定时刻自动执行这些命令，比如会话开始时，以你的权限在这台电脑上运行。允许之前，这个会话不会自动执行任何命令，包括你自己设置的。"
      list={{
        title: '命令',
        items: entry.hooks.map((h) => (h.target ? `${h.event} · ${h.target}` : h.event)),
      }}
      actions={[
        { key: 'skip', label: '不运行', tone: 'danger', run: answer('skip') },
        { key: 'use', label: '运行', tone: 'primary', run: answer('use') },
        { key: 'all', label: '总是运行', run: answer('all') },
      ]}
      answer={{
        text: HOOKS_ANSWER[entry.decision ?? 'skip'],
        allowed: entry.decision === 'use' || entry.decision === 'all',
        device: entry.device,
      }}
      about={events}
    />
  )
}

// A step only a person can do.

const STEP_WHAT: Record<ControlStep, string> = {
  sign_in: '登录',
  code: '输入验证码',
  check: '通过验证',
  other: '做一步',
}

const STEP_DONE: Record<ControlStep, string> = {
  sign_in: '已登录',
  code: '已输入验证码',
  check: '已通过验证',
  other: '已做完这一步',
}

export function ControlAskEntry(props: {
  entry: Of<'control_ask'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const computer = useComputer()
  const what = STEP_WHAT[entry.step]
  const answer = (outcome: 'done' | 'skipped') => () =>
    call(link, 'control.answerAsk', { sessionId, entryId: entry.id, outcome })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={entry.outcome === null}
      icon={E.key}
      title={`${agent} 请你${what}`}
      target={entry.target ?? '在会话旁边的浏览器里'}
      body={entry.reason}
      actions={[
        { key: 'skip', label: '跳过', run: answer('skipped') },
        { key: 'done', label: '完成', tone: 'primary', run: answer('done') },
      ]}
      footnote={`这一步要在「${computer.name}」上${what}，做完再按完成。`}
      answer={{
        text:
          entry.outcome === 'done'
            ? STEP_DONE[entry.step]
            : entry.outcome === 'skipped'
              ? '已跳过'
              : '这一轮先结束了',
        allowed: entry.outcome === 'done',
        device: entry.device,
      }}
      about={entry.target}
    />
  )
}

// A write to Kettu's memory.

const PROPOSAL = {
  remember: {
    action: '记住一件关于你的事',
    allow: '记住',
    deny: '不记',
    accepted: '已记进全局记忆',
    declined: '没有记',
  },
  update: {
    action: '改一条关于你的记忆',
    allow: '改',
    deny: '不改',
    accepted: '已改好全局记忆',
    declined: '没有改',
  },
  forget: {
    action: '忘掉一条关于你的记忆',
    allow: '忘掉',
    deny: '留着',
    accepted: '已从全局记忆里忘掉',
    declined: '留着了',
  },
} as const

const WRITTEN = { remember: '记住了', update: '改了记忆', forget: '忘掉了' } as const

/** Whether a memory entry waits: a proposed write to global memory, never a project's. */
export function memoryWaits(entry: Of<'memory'>): boolean {
  return entry.layer === 'global' && entry.status === 'proposed'
}

export function MemoryEntry(props: { entry: Of<'memory'>; sessionId: string; place: Place }) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  if (entry.layer === 'project') {
    if (props.place === 'dock') return null
    return <MemoryStep entry={entry} sessionId={sessionId} link={link} />
  }
  const words = PROPOSAL[entry.action]
  const answer = (decision: 'remember' | 'skip') => () =>
    call(link, 'sessions.answerMemory', { sessionId, entryId: entry.id, decision })
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={memoryWaits(entry)}
      icon={E.memory}
      title={wants(agent, words.action)}
      target={entry.draft?.title ?? entry.title}
      body={entry.draft?.body ?? null}
      actions={[
        { key: 'skip', label: words.deny, run: answer('skip') },
        { key: 'remember', label: words.allow, tone: 'primary', run: answer('remember') },
      ]}
      answer={{
        text: entry.status === 'declined' ? words.declined : words.accepted,
        allowed: entry.status !== 'declined',
        device: entry.device,
      }}
      about={entry.draft?.title ?? entry.title}
    />
  )
}

/** A project memory write: what it did and the entry's title, and Undo while the write stands. */
function MemoryStep(props: { entry: Of<'memory'>; sessionId: string; link: HostLink }) {
  const { entry } = props
  const { c } = useSessionTokens()
  const sender = useSender()
  const undone = entry.status === 'undone'
  return (
    <>
      <QuietLine
        icon={E.memory}
        text={WRITTEN[entry.action]}
        detail={undone ? `${entry.title} · 已撤销` : entry.title}
        trail={
          entry.status === 'written' && entry.undo !== null ? (
            <Pressable
              onPress={() =>
                void sender.send('undo', () =>
                  call(props.link, 'sessions.undoMemory', {
                    sessionId: props.sessionId,
                    entryId: entry.id,
                  }),
                )
              }
              disabled={sender.busy !== null}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`撤销“${entry.title}”`}
              style={({ pressed }) => ({ opacity: pressed || sender.busy ? 0.5 : 1 })}
            >
              <Text style={[styles.trail, { color: c.tint }]}>撤销</Text>
            </Pressable>
          ) : null
        }
      />
      {sender.error ? (
        <Text style={[styles.lineError, { color: c.danger }]}>{sender.error}</Text>
      ) : null}
    </>
  )
}

// A problem report the agent drafted.

const NOT_SUBMITTED: Record<ReportSubmitFailure, string> = {
  too_large: '报告太大了，提交不了。换个短一点的时间范围或少带几项，或者存到本地附进 issue。',
  rate_limited: '今天提交的报告太多了。先存到本地附进 issue，或者明天再提交。',
  unauthorized: '登录已失效，重新登录后再提交。',
  signed_out: '这台电脑没有登录 Kite Cloud 账号。先为它登录，或者存到本地。',
  network: '连不上 Kite Cloud。检查一下网络，再提交一次。',
  failed: '报告没能提交。存到本地附进 issue 吧。',
}

export function ProblemReportEntry(props: {
  entry: Of<'problem_report'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const outcome = entry.outcome
  const answer = (o: NonNullable<Of<'problem_report'>['outcome']>) =>
    call(link, 'sessions.answerReport', { sessionId, entryId: entry.id, outcome: o })

  // The computer builds the bundle with its own logs and submits it with its own sign-in, as the
  // desktop's card does for another host.
  const send = async () => {
    const built = await admin(link, 'host.report', {
      request: {
        description: `${entry.title}\n\n${entry.details}`,
        range: { kind: 'hour' },
        extras: [],
        context: {
          sessionId,
          agentId: getHost().sessions.get(sessionId)?.agentId ?? null,
          error: entry.error,
        },
      },
    })
    if (!built.ok) {
      throw new Error(
        built.reason === 'too_large'
          ? '报告太大了，换个短一点的时间范围或少带几项。'
          : '报告没能打包好。',
      )
    }
    const sent = reportSubmitResult(await admin(link, 'host.submitReport', { ref: built.ref }))
    if (!sent.ok) {
      const reason = REPORT_SUBMIT_FAILURES.includes(sent.reason) ? sent.reason : 'failed'
      throw new Error(NOT_SUBMITTED[reason])
    }
    await answer({ kind: 'sent', reportId: sent.id })
  }

  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={outcome === null}
      icon={E.report}
      title={wants(agent, '把问题报告发给纸鸢')}
      target={entry.title}
      body={entry.error ? `${entry.details}\n\n${entry.error}` : entry.details}
      list={{
        title: '一起带上',
        items: ['纸鸢的版本和你的系统', '最近 1 小时的日志和操作记录', '这个会话和 Agent'],
      }}
      actions={[
        { key: 'skip', label: '不提交', run: () => answer({ kind: 'skipped' }) },
        {
          key: 'send',
          label: '提交给纸鸢',
          tone: 'primary',
          run: () =>
            send().catch((error: unknown) => {
              throw new Error(messageOf(error, '报告没能提交。'))
            }),
        },
      ]}
      footnote="要修改报告或存到本地，请在电脑上处理。"
      answer={{
        text:
          outcome?.kind === 'sent'
            ? `已提交 · 报告 ${outcome.reportId}`
            : outcome?.kind === 'saved'
              ? '已存到本地'
              : '未提交',
        allowed: outcome?.kind === 'sent' || outcome?.kind === 'saved',
        device: entry.device,
      }}
      about={entry.title}
    />
  )
}

// Computer use's setup.

const SETUP_STEP = {
  enable: '打开电脑操控',
  accessibility: '允许辅助功能',
  'screen-recording': '允许屏幕录制',
} as const

const SETUP_OUTCOME = {
  ready: '已设置好电脑操控',
  declined: '没有设置电脑操控',
  timeout: '没有在限定时间内设置好电脑操控',
} as const

/**
 * The switch and the system's permissions are only the computer's to set, so the phone says so and
 * offers Not now, which any device may give.
 */
export function ComputerSetupEntry(props: {
  entry: Of<'computer_setup'>
  sessionId: string
  place: Place
}) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const computer = useComputer()
  const step = entry.steps.find((s) => !entry.done.includes(s)) ?? null
  const waiting = entry.outcome === null && step !== null
  const index = step ? entry.steps.indexOf(step) : 0
  return (
    <Request
      place={props.place}
      entryId={entry.id}
      waiting={waiting}
      icon={E.computer}
      title={`要在「${computer.name}」上完成设置`}
      body={`开关和系统权限只能在那台电脑的纸鸢里打开。设置好后，${agent} 会自动继续。`}
      list={{
        title: `第 ${index + 1} 步，共 ${entry.steps.length} 步`,
        items: entry.steps.map((s) => `${entry.done.includes(s) ? '✓ ' : ''}${SETUP_STEP[s]}`),
      }}
      actions={[
        {
          key: 'decline',
          label: '不用了',
          run: () => call(link, 'computer.declineSetup', { sessionId, entryId: entry.id }),
        },
      ]}
      answer={{
        text: SETUP_OUTCOME[entry.outcome ?? 'timeout'],
        allowed: entry.outcome === 'ready',
        device: entry.device,
      }}
      about={entry.outcome === 'declined' ? '不用了' : null}
    />
  )
}

const styles = StyleSheet.create({
  trail: { fontSize: 14, fontWeight: '600' },
  lineError: { fontSize: 12, lineHeight: 16, marginLeft: 21 },
})

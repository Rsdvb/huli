// One row of a session's conversation: the user's bubble, the agent's reply in full width with what
// it carried, its work folded into runs of quiet lines that open, an answered request as one line,
// a plan's answer, the turn's changes and footer, and the host's own records as small notes.

import { memo, useMemo, useRef } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { openArtifact } from '../artifacts'
import { countRender } from '../ui/renders'
import { useSessionRows } from '../ui/session/context'
import { useDisclosure } from '../ui/session/disclosure'
import { ContextMenu } from '../ui/ContextMenu'
import { joinGroups, type MenuNode } from '../ui/menu'
import { copyText, plainText } from '../ui/session/feedback'
import { G, Icon, type IconSpec } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { RunRow } from '../ui/session/RunRow'
import { selectText } from '../ui/session/SelectText'
import { answerWords, ThoughtRow, ToolRow } from '../ui/session/ToolRow'
import { TurnChanges } from '../ui/session/TurnChanges'
import { TurnFooter } from '../ui/session/TurnFooter'
import type { ReplyPart } from '../ui/session/markdown'
import { sameRow, type Row } from '../ui/session/turns'
import { CarriedRefs } from './CarriedRefs'
import {
  useAgentName,
  BrowserOriginEntry,
  ComputerAppEntry,
  ComputerSetupEntry,
  ControlAskEntry,
  DeviceAccessEntry,
  MemoryEntry,
  ProblemReportEntry,
  ProjectHooksEntry,
  ProjectMcpEntry,
} from './entries/AccessEntries'
import { ElicitationSettled } from './entries/ElicitationCard'
import { QuietLine, WaitingLine } from './entries/kit'
import { PlanSettled, PlanWaitingLine } from './entries/PlanCards'
import { MarketPublishEntry } from './entries/MarketPublishEntry'
import {
  ChildEntry,
  ControlNoteEntry,
  SessionMessageEntry,
  TakeoverEntry,
  TurnEndEntry,
} from './entries/NoteEntries'
import { NoticeEntry } from './entries/TurnEnd'
import { workflowCardOf, WorkflowToolCard } from './entries/WorkflowCards'
import { Markdown, partGap } from './Markdown'
import { UserMessage } from './UserMessage'

type Of<K extends ThreadEntry['kind']> = Extract<ThreadEntry, { kind: K }>

const NO_MENU: MenuNode[] = []

/**
 * A reply, or one part of a long one, which the conversation draws as rows of their own. Each part
 * opens the reply's menu; the last carries what the reply carried, and while the reply is written,
 * its caret.
 */
function Reply(props: { entry: Of<'agent'>; writing: boolean; part?: ReplyPart }) {
  const { entry, writing } = props
  const part = props.part
  const text = part ? part.text : entry.markdown
  const last = part ? part.last : true
  const { fork, forkAtMessage } = useSessionRows((r) => ({
    fork: r.fork,
    forkAtMessage: r.forkAtMessage,
  }))
  // A reply still being written has no menu yet; its text is not done. Built once per text, so
  // a redraw of the row hands the system's menu the same items.
  const markdown = entry.markdown
  const entryId = entry.id
  const menu = useMemo<MenuNode[]>(
    () =>
      markdown && !writing
        ? joinGroups([
            [
              {
                key: 'copy',
                label: '复制',
                icon: 'doc.on.doc',
                onPress: () => void copyText(plainText(markdown)),
              },
              {
                key: 'select',
                label: '选择文本',
                icon: 'character.cursor.ibeam',
                onPress: () => selectText({ text: plainText(markdown) }),
              },
              {
                key: 'markdown',
                label: '复制为 Markdown',
                icon: 'doc.plaintext',
                onPress: () => void copyText(markdown),
              },
            ],
            fork
              ? [
                  {
                    key: 'fork',
                    label: '从这里分叉',
                    icon: 'arrow.triangle.branch',
                    onPress: () => fork(forkAtMessage ? entryId : null),
                  },
                ]
              : [],
          ])
        : NO_MENU,
    [markdown, writing, fork, forkAtMessage, entryId],
  )
  if (!entry.markdown && !writing && entry.attachments.length === 0) return null
  return (
    <View style={{ gap: 8 }}>
      {text || (writing && last) ? (
        <ContextMenu items={menu}>
          {(longPress) => (
            <Pressable onLongPress={longPress} delayLongPress={400}>
              <Markdown
                markdown={text}
                streaming={writing && last}
                {...(part && part.index > 0 ? { continues: true } : {})}
              />
            </Pressable>
          )}
        </ContextMenu>
      ) : null}
      {last && entry.attachments.length > 0 && <CarriedRefs refs={entry.attachments} />}
    </View>
  )
}

/**
 * A tool call that asked for permission, once answered: one line of what was chosen and what
 * follows from it, then an allowed call's own line, as the desktop's folded card.
 */
function AnsweredTool(props: { entry: ToolEntry }) {
  const { entry } = props
  const { sessionId } = useSessionRows((r) => ({ sessionId: r.sessionId }))
  const agent = useAgentName(sessionId)
  const words = answerWords(entry, agent)
  if (!words) return <ToolRow entry={entry} />
  const questions =
    typeof entry.permissionResult === 'object' ? (entry.permissionResult?.questions ?? []) : []
  return (
    <View style={{ gap: 2 }}>
      <QuietLine
        icon={words.allowed ? G.shieldCheck : questions.length > 0 ? G.hand : G.shield}
        tone={words.allowed ? 'done' : 'other'}
        text={
          questions.length > 0 && entry.question
            ? `${entry.question} · ${words.headline}`
            : words.headline
        }
        detail={words.note || null}
      />
      {questions.map((q, i) => (
        <QuietLine
          key={i}
          icon={G.right}
          text={q.question}
          detail={q.answered ? (q.answer ?? '已回答') : '已跳过'}
        />
      ))}
      {words.allowed && questions.length === 0 && entry.question === undefined && (
        <ToolRow entry={entry} />
      )}
    </View>
  )
}

/** A question of the agent's that waits, by its words or the agent's name. */
function AskingLine(props: { question: string | undefined }) {
  const { sessionId } = useSessionRows((r) => ({ sessionId: r.sessionId }))
  const agent = useAgentName(sessionId)
  return <WaitingLine icon={G.hand} text={props.question ?? `${agent} 在问你`} />
}

/** A small line of the host's own record, with an icon and, when it leads somewhere, a chevron. */
function Note(props: {
  icon: IconSpec
  text: string
  detail?: string
  onPress?: () => void
  busy?: boolean
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={props.onPress}
      disabled={!props.onPress}
      style={({ pressed }) => [styles.quiet, { opacity: pressed ? 0.55 : 1 }]}
    >
      <Icon icon={props.icon} size={14} color={c.textTertiary} />
      <Text style={[styles.quietText, { color: c.textSecondary, flexShrink: 1 }]} numberOfLines={1}>
        {props.text}
        {props.detail ? <Text style={{ color: c.textTertiary }}> {props.detail}</Text> : null}
        {props.busy ? '…' : ''}
      </Text>
      {props.onPress && <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />}
    </Pressable>
  )
}

/** A compaction divides the thread: rules on both sides of its words, which open the summary. */
function Compaction(props: { entry: Of<'compaction'> }) {
  const { c } = useSessionTokens()
  const [open, setOpen] = useDisclosure(`compaction:${props.entry.id}`)
  const busy = props.entry.status === 'in_progress'
  const text =
    props.entry.status === 'failed'
      ? '无法压缩上下文'
      : props.entry.status === 'cancelled'
        ? '已取消压缩'
        : busy
          ? '正在压缩上下文…'
          : '上下文已压缩'
  const expandable = !busy && !!props.entry.summary
  return (
    <View>
      <Pressable
        onPress={() => {
          setOpen((v) => !v)
        }}
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        style={({ pressed }) => [styles.divider, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={[styles.rule, { backgroundColor: c.border }]} />
        <Icon icon={G.compact} size={13} color={c.textTertiary} />
        <Text style={[styles.dividerText, { color: c.textTertiary }]}>{text}</Text>
        {expandable && (
          <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
            <Icon icon={G.right} size={9} color={c.textTertiary} weight="semibold" />
          </View>
        )}
        <View style={[styles.rule, { backgroundColor: c.border }]} />
      </Pressable>
      {open && expandable && (
        <View style={[styles.summary, { backgroundColor: c.fill }]}>
          <Text style={[styles.summaryLabel, { color: c.textTertiary }]}>摘要</Text>
          <Markdown markdown={props.entry.summary} size="compact" color={c.textSecondary} />
        </View>
      )}
    </View>
  )
}

export const EntryView = memo(function EntryView(props: {
  entry: ThreadEntry
  /** The reply the agent is still writing, which alone ends in a caret. */
  writing?: boolean
}) {
  const { entry } = props
  const { sessionId } = useSessionRows((r) => ({ sessionId: r.sessionId }))
  // The host's own requests: a line while their card waits above the composer, then the answer.
  const request = { sessionId, place: 'thread' as const }
  switch (entry.kind) {
    case 'user':
      if (entry.approval) return null
      return (
        <UserMessage
          id={entry.id}
          content={entry.content}
          {...(entry.at !== undefined ? { at: entry.at } : {})}
          {...(entry.steered ? { steered: true } : {})}
          {...(entry.device ? { device: entry.device } : {})}
          {...(entry.from ? { from: entry.from } : {})}
        />
      )
    case 'agent':
      return <Reply entry={entry} writing={!!props.writing} />
    case 'thought':
      return <ThoughtRow entry={entry} />
    case 'tool': {
      const waiting = !!entry.permission && !entry.permissionResult
      if (waiting && entry.permission?.plan) return <PlanWaitingLine entry={entry} />
      if (waiting && (entry.permission?.questions?.length || entry.question !== undefined)) {
        return <AskingLine question={entry.question} />
      }
      if (waiting) return <ToolRow entry={entry} />
      if (workflowCardOf(entry)) return <WorkflowToolCard entry={entry} />
      if (entry.elicitation) return <ElicitationSettled entry={entry} />
      if (entry.planVersion !== undefined) return <PlanSettled entry={entry} />
      if (entry.permissionResult) return <AnsweredTool entry={entry} />
      return <ToolRow entry={entry} />
    }
    case 'plan':
      return null
    case 'notice':
      return <NoticeEntry entry={entry} />
    case 'compaction':
      return <Compaction entry={entry} />
    case 'subagent':
    case 'session_started':
      return <ChildEntry entry={entry} />
    case 'session_message':
      return <SessionMessageEntry entry={entry} />
    case 'turn_end':
      return <TurnEndEntry entry={entry} />
    case 'takeover':
      return <TakeoverEntry entry={entry} />
    case 'control_note':
      return <ControlNoteEntry entry={entry} sessionId={sessionId} />
    case 'browser_origin':
      return <BrowserOriginEntry entry={entry} {...request} />
    case 'computer_app':
      return <ComputerAppEntry entry={entry} {...request} />
    case 'computer_setup':
      return <ComputerSetupEntry entry={entry} {...request} />
    case 'control_ask':
      return <ControlAskEntry entry={entry} {...request} />
    case 'device_access':
      return <DeviceAccessEntry entry={entry} {...request} />
    case 'project_mcp':
      return <ProjectMcpEntry entry={entry} {...request} />
    case 'project_hooks':
      return <ProjectHooksEntry entry={entry} {...request} />
    case 'problem_report':
      return <ProblemReportEntry entry={entry} {...request} />
    case 'memory':
      return <MemoryEntry entry={entry} {...request} />
    case 'market_publish':
      return <MarketPublishEntry entry={entry} {...request} />
    case 'git':
      if (entry.event === 'commit') {
        const count = entry.commits.length + entry.more
        return (
          <Note
            icon={G.commit}
            text={`提交了 ${count} 个 commit`}
            {...(entry.commits[0] ? { detail: entry.commits[0].subject } : {})}
          />
        )
      }
      if (entry.event === 'push') {
        return (
          <Note icon={G.push} text={`推送了 ${entry.count} 个 commit`} detail={entry.upstream} />
        )
      }
      if (entry.event === 'branch') {
        return <Note icon={G.branch} text="切换到分支" detail={entry.branch} />
      }
      return (
        <Note
          icon={G.pr}
          text="开了 Pull Request"
          onPress={() => void Linking.openURL(entry.url).catch(() => {})}
        />
      )
    case 'artifact':
      return (
        <Note
          icon={G.artifact}
          text="产物"
          detail={entry.title}
          onPress={entry.action === 'delete' ? undefined : () => openArtifact(entry.artifactId)}
        />
      )
    default:
      return null
  }
})

const CARD: [number, number] = [6, 6]

// Room above and below each kind of entry: replies breathe, tool lines sit close together.
const SPACING: Partial<Record<ThreadEntry['kind'], [number, number]>> = {
  user: [10, 10],
  agent: [8, 8],
  notice: [6, 6],
  compaction: [8, 8],
  session_message: CARD,
  subagent: CARD,
  session_started: CARD,
}

/** A row of the conversation list, which redraws only when its own data changed. */
export const ThreadRow = memo(
  function ThreadRow(props: { row: Row }) {
    const { row } = props
    // A mount as the row scrolls into view, or a redraw of one already shown: only its own
    // change, such as the reply being written, should redraw it.
    const shown = useRef<string | null>(null)
    countRender(shown.current === row.key ? 'ThreadRow redraw' : 'ThreadRow mount')
    shown.current = row.key
    if (row.type === 'changes') {
      return (
        <View style={{ paddingTop: 8, paddingBottom: 4 }}>
          <TurnChanges tools={row.tools} />
        </View>
      )
    }
    if (row.type === 'footer') {
      return (
        <View style={{ paddingBottom: 22 }}>
          <TurnFooter end={row.end} endedAt={row.endedAt} replies={row.replies} />
        </View>
      )
    }
    if (row.type === 'run') {
      return (
        <View style={{ paddingVertical: 3 }}>
          <RunRow entries={row.entries} latest={row.latest} />
        </View>
      )
    }
    if (row.type === 'reply') {
      const { entry, part } = row
      if (!entry.markdown && !row.writing && entry.attachments.length === 0) return null
      const [top, bottom] = SPACING.agent!
      // A later part stands as far below the one before as the whole reply's blocks stood apart.
      return (
        <View
          style={{
            paddingTop: part.index === 0 ? top : partGap(part.joint),
            paddingBottom: part.last ? bottom : 0,
          }}
        >
          <Reply entry={entry} writing={!!row.writing} part={part} />
        </View>
      )
    }
    const { entry } = row
    if (
      (entry.kind === 'user' && entry.approval) ||
      entry.kind === 'plan' ||
      (entry.kind === 'agent' && !entry.markdown && !row.writing && entry.attachments.length === 0)
    ) {
      return null
    }
    const [top, bottom] = SPACING[entry.kind] ?? [3, 3]
    return (
      <View style={{ paddingTop: top, paddingBottom: bottom }}>
        <EntryView entry={entry} writing={!!row.writing} />
      </View>
    )
  },
  (a, b) => sameRow(a.row, b.row),
)

const styles = StyleSheet.create({
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 28,
    alignSelf: 'flex-start',
  },
  quietText: { fontSize: 14, lineHeight: 19 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12 },
  summary: { borderRadius: 12, padding: 12, marginTop: 6, gap: 4 },
  summaryLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 0.5 },
})

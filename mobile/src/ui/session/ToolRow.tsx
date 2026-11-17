// A step of the conversation's work as one quiet line, as the desktop's tool call card draws it:
// an icon for its kind, its verb (in the past tense once done) and target, an edit's counts, and
// how it went: a spinner and its time while it runs, its time once done, 失败, 已取消, or 需要授权
// while it waits. Tapped, it opens to its command and output, its result or the file it read, and
// its edits, each opening to its diff.

import { memo, useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { ShellBlock } from '../../components/entries/ShellBlock'
import { Markdown } from '../../components/Markdown'
import { handDiff } from '../../diff'
import { Clamp } from './Clamp'
import { useSessionRows } from './context'
import { copyText } from './feedback'
import { relativePath } from './format'
import { FileMark, G, Icon, TOOL_ICONS, type IconSpec } from './icons'
import { MONO, useSessionTokens } from './palette'
import { gentle } from './Press'
import { Counts } from './TurnChanges'
import { toolEdits, type FileEdit } from './turns'
import {
  commandOutput,
  diffStats,
  fenceBody,
  formatMs,
  numberedRead,
  thoughtTitle,
  toolLabel,
  toolTime,
  type ToolLabel,
} from './work'

export const VERBS: Record<ToolEntry['toolKind'], string> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  search: '搜索',
  execute: '运行',
  think: '思考',
  fetch: '获取',
  switch_mode: '切换模式',
  other: '工具',
}

const ANSWERS = {
  allow_once: { headline: '已允许一次', note: '仅此一次，不会延续到下次' },
  allow_always: { headline: '已始终允许', note: '{agent} 不会再为此询问' },
  reject_once: { headline: '已拒绝', note: '已告知 {agent}，它不会执行' },
  reject_always: { headline: '已始终拒绝', note: '{agent} 不会再为此询问' },
} as const

/** How an answered request reads, as the desktop's folded card words it: what, and what follows. */
export function answerWords(
  entry: ToolEntry,
  agent: string,
): { headline: string; note: string; allowed: boolean } | null {
  const result = entry.permissionResult
  if (!result) return null
  if (result === 'cancelled') {
    return { headline: '已取消', note: '回合在回答前已结束', allowed: false }
  }
  if (result === 'withdrawn') {
    return { headline: '已不再需要', note: `${agent} 已不再需要`, allowed: false }
  }
  const allowed = result.kind === 'allow_once' || result.kind === 'allow_always'
  if (result.by === 'routine') return { headline: '由例程允许', note: '', allowed }
  if (result.questions?.length) {
    return {
      headline: '已回答',
      note: result.device ? `在 ${result.device.name} 上` : '',
      allowed,
    }
  }
  const words = ANSWERS[result.kind]
  const note = words.note.replace('{agent}', agent)
  return {
    headline: words.headline,
    note: result.device ? `${note} · ${result.device.name}` : note,
    allowed,
  }
}

/** The answer's headline alone, for a line that names it. */
export function answerText(entry: ToolEntry): string | null {
  return answerWords(entry, 'Agent')?.headline ?? null
}

/** What the line names: the command for a shell call, else the path or the agent's title. */
export function target(entry: ToolEntry, root: string | null): string {
  const label = toolLabel(entry, root)
  return (label.target ?? entry.title).split('\n')[0]!
}

export function EditLine(props: { edit: FileEdit; root: string | null }) {
  const { c } = useSessionTokens()
  const { edit } = props
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/diff',
          params: {
            key: handDiff({
              path: edit.path,
              oldText: edit.oldText,
              newText: edit.newText,
              diff: edit.diff,
            }),
          },
        })
      }
      accessibilityRole="button"
      style={({ pressed }) => [styles.edit, { backgroundColor: pressed ? c.fillStrong : c.fill }]}
    >
      <FileMark path={edit.path} size={13} />
      <Text style={[styles.editPath, { color: c.text }]} numberOfLines={1} ellipsizeMode="head">
        {edit.oldText === null ? '新建 ' : ''}
        {relativePath(edit.path, props.root)}
      </Text>
      <Counts insertions={edit.diff.insertions} deletions={edit.diff.deletions} size={12} />
      <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
    </Pressable>
  )
}

export type StepStatus = 'running' | 'success' | 'error' | 'cancelled' | 'waiting'

export function stepStatus(entry: ToolEntry): StepStatus {
  if (entry.permission && !entry.permissionResult) return 'waiting'
  return entry.status === 'completed'
    ? 'success'
    : entry.status === 'failed'
      ? 'error'
      : entry.status === 'cancelled'
        ? 'cancelled'
        : 'running'
}

/** How long since `since`, ticking while shown, with tenths below a minute. */
export function LiveTime(props: { since: number; color: string; prefix?: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  return (
    <Text style={[styles.time, { color: props.color }]}>
      {props.prefix ?? ''}
      {formatMs(Math.max(0, now - props.since), true)}
    </Text>
  )
}

/** The end of a step's line: how it went, and its time when this phone saw it. */
export function StepMark(props: {
  status: StepStatus
  startedAt?: number | undefined
  duration?: number | undefined
}) {
  const { c, s } = useSessionTokens()
  switch (props.status) {
    case 'waiting':
      return (
        <Text style={[styles.pill, { color: c.warning, backgroundColor: s.warningSoft }]}>
          需要授权
        </Text>
      )
    case 'running':
      return (
        <View style={styles.mark}>
          <ActivityIndicator size="small" color={c.textTertiary} style={styles.spinner} />
          {props.startedAt !== undefined && (
            <LiveTime since={props.startedAt} color={c.textTertiary} />
          )}
        </View>
      )
    case 'error':
      return (
        <View style={styles.mark}>
          <Icon icon={G.failed} size={13} color={c.danger} />
          <Text style={[styles.time, { color: c.danger }]}>失败</Text>
        </View>
      )
    case 'cancelled':
      return <Text style={[styles.time, { color: c.textTertiary }]}>已取消</Text>
    case 'success':
      return (
        <View style={styles.mark}>
          <Icon icon={G.check} size={12} color={c.tint} weight="semibold" />
          {props.duration !== undefined && (
            <Text style={[styles.time, { color: c.textTertiary }]}>
              {formatMs(props.duration, false)}
            </Text>
          )}
        </View>
      )
  }
}

/** A step's line: its icon, name and summary, what follows them, and its chevron when it opens. */
export function StepLine(props: {
  icon: IconSpec
  name: string
  summary?: string | null
  mono?: boolean
  extra?: ReactNode
  mark: ReactNode
  open: boolean
  onToggle: (() => void) | null
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={props.onToggle ?? undefined}
      disabled={!props.onToggle}
      accessibilityRole={props.onToggle ? 'button' : undefined}
      accessibilityState={props.onToggle ? { expanded: props.open } : undefined}
      style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={[styles.badge, { backgroundColor: c.fill }]}>
        <Icon icon={props.icon} size={13} color={c.textSecondary} />
      </View>
      <Text style={[styles.name, { color: c.textSecondary }]} numberOfLines={1}>
        {props.name}
      </Text>
      <Text
        style={[styles.summary, { color: c.text }, props.mono && styles.monoSummary]}
        numberOfLines={1}
        ellipsizeMode={props.mono ? 'tail' : 'head'}
      >
        {props.summary ?? ''}
      </Text>
      {props.extra}
      {props.mark}
      {props.onToggle ? (
        <View style={{ transform: [{ rotate: props.open ? '90deg' : '0deg' }] }}>
          <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
        </View>
      ) : (
        <View style={styles.noChevron} />
      )}
    </Pressable>
  )
}

/** Whether a call has details to open: content, or a command too long for its line. */
function hasBody(entry: ToolEntry, label: ToolLabel): boolean {
  const command = label.kind === 'command' ? label.target : null
  return (
    entry.content.length > 0 ||
    !!entry.description ||
    (!!command && (command.length > 60 || command.includes('\n')))
  )
}

export const ToolRow = memo(function ToolRow(props: { entry: ToolEntry; note?: string }) {
  const { root, sessionId } = useSessionRows()
  const { c } = useSessionTokens()
  const { entry } = props
  const status = stepStatus(entry)
  const [open, setOpen] = useState(false)
  // A call that fails while shown opens, as the desktop's card does.
  const [was, setWas] = useState(status)
  if (was !== status) {
    setWas(status)
    if (status === 'error' && !open) setOpen(true)
  }
  const label = toolLabel(entry, root, entry.status === 'completed')
  const time = toolTime(sessionId, entry.id)
  const diffs = entry.content.filter((part) => part.type === 'diff')
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const result = entry.permissionResult
  const note =
    props.note ??
    (typeof result === 'object' && result?.by === 'routine' ? '由例程允许' : undefined)
  const body = hasBody(entry, label)
  const toggle = () => {
    gentle()
    setOpen((v) => !v)
  }
  return (
    <View>
      <StepLine
        icon={TOOL_ICONS[entry.toolKind]}
        name={label.verb ?? entry.title}
        summary={label.verb && label.target ? label.target.split('\n')[0] : (note ?? null)}
        mono={label.kind === 'command'}
        extra={
          <>
            {stats && (stats.insertions > 0 || stats.deletions > 0) ? (
              <Counts insertions={stats.insertions} deletions={stats.deletions} size={12} />
            ) : null}
            {note && label.verb ? (
              <Text style={[styles.time, { color: c.textTertiary }]} numberOfLines={1}>
                · {note}
              </Text>
            ) : null}
          </>
        }
        mark={<StepMark status={status} startedAt={time.startedAt} duration={time.durationMs} />}
        open={open}
        onToggle={body ? toggle : null}
      />
      {open && body && <ToolBody entry={entry} label={label} />}
    </View>
  )
})

/** A section of a step's details: a small label, Copy when it has text to copy, and its content. */
function Section(props: { label: string; copy?: string; children: ReactNode }) {
  const { c } = useSessionTokens()
  const [copied, setCopied] = useState(false)
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionLabel, { color: c.textTertiary }]}>{props.label}</Text>
        {props.copy !== undefined && (
          <Pressable
            onPress={() =>
              void copyText(props.copy!).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              })
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={copied ? '已复制' : `复制${props.label}`}
          >
            <Icon
              icon={copied ? G.copied : G.copy}
              size={13}
              color={copied ? c.success : c.textTertiary}
            />
          </Pressable>
        )}
      </View>
      {props.children}
    </View>
  )
}

/**
 * A call's details: its command and what it printed, its text result or the file it read with
 * its line numbers, its changes, and its pictures; then the full view.
 */
function ToolBody(props: { entry: ToolEntry; label: ToolLabel }) {
  const { c, s } = useSessionTokens()
  const { root, sessionId } = useSessionRows()
  const { entry, label } = props
  const command = label.kind === 'command' ? label.target : null
  const output = command ? commandOutput(entry.content) : null
  const content = output === null ? entry.content : entry.content.slice(1)
  const path = entry.locations[0]?.path
  const edits = toolEdits(entry)
  let edit = 0
  return (
    <View style={styles.body}>
      {entry.description && entry.description !== command ? (
        <Text style={[styles.description, { color: c.textSecondary }]}>{entry.description}</Text>
      ) : null}
      {command ? (
        <ShellBlock sessionId={sessionId} command={command} output={output} status={entry.status} />
      ) : null}
      {content.map((part, i) => {
        if (part.type === 'markdown') {
          if (!part.markdown.trim()) return null
          const read = entry.toolKind === 'read' ? numberedRead(part.markdown, path) : null
          const markdown = read ?? part.markdown
          return (
            <Section
              key={i}
              label={entry.toolKind === 'read' ? '内容' : '结果'}
              copy={fenceBody(markdown)}
            >
              <Clamp maxHeight={320} more="显示全部">
                <Markdown markdown={markdown} size="compact" />
              </Clamp>
            </Section>
          )
        }
        if (part.type === 'diff') {
          const made = edits[edit++]
          return made ? (
            <Section key={i} label="更改">
              <EditLine edit={made} root={root} />
            </Section>
          ) : null
        }
        const ref = part.ref
        if (ref.kind === 'image' && 'data' in ref) {
          return (
            <Image
              key={i}
              source={{ uri: `data:${ref.mimeType};base64,${ref.data}` }}
              style={[styles.picture, { borderColor: s.codeBorder }]}
              contentFit="contain"
              cachePolicy="memory"
              accessibilityIgnoresInvertColors
            />
          )
        }
        return (
          <Text key={i} style={[styles.description, { color: c.textTertiary }]} numberOfLines={1}>
            {ref.kind === 'link'
              ? ref.name || ref.uri
              : ref.kind === 'unsupported'
                ? ref.label
                : ref.kind === 'attachment'
                  ? ref.attachment.name
                  : ref.kind === 'image'
                    ? '图片'
                    : ref.kind === 'audio'
                      ? '音频'
                      : '视频'}
          </Text>
        )
      })}
      <Pressable
        onPress={() => router.push({ pathname: '/tool', params: { sessionId, entryId: entry.id } })}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="全屏查看这次调用"
        style={({ pressed }) => [styles.full, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Text style={[styles.fullText, { color: c.tint }]}>全屏查看</Text>
        <Icon icon={G.right} size={10} color={c.tint} weight="semibold" />
      </Pressable>
    </View>
  )
}

/** A thought as a step: 思考, its heading, and its text a few lines tall until shown whole. */
export const ThoughtRow = memo(function ThoughtRow(props: {
  entry: Extract<ThreadEntry, { kind: 'thought' }>
}) {
  const { c } = useSessionTokens()
  const { entry } = props
  const [open, setOpen] = useState(false)
  const has = entry.markdown.trim() !== ''
  return (
    <View>
      <StepLine
        icon={G.thought}
        name="思考"
        summary={thoughtTitle(entry.markdown)}
        mark={
          <StepMark status={entry.streaming ? 'running' : 'success'} duration={entry.durationMs} />
        }
        open={open}
        onToggle={
          has
            ? () => {
                gentle()
                setOpen((v) => !v)
              }
            : null
        }
      />
      {open && has && (
        <View style={[styles.thought, { borderLeftColor: c.borderStrong }]}>
          <Clamp maxHeight={180}>
            <Markdown
              markdown={entry.markdown}
              streaming={entry.streaming}
              size="compact"
              color={c.textSecondary}
            />
          </Clamp>
        </View>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 32 },
  badge: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, lineHeight: 19, fontWeight: '500', flexShrink: 1 },
  summary: { flex: 1, fontSize: 14, lineHeight: 19 },
  monoSummary: { fontFamily: MONO, fontSize: 12.5 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  spinner: { transform: [{ scale: 0.7 }], width: 16, height: 16 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  noChevron: { width: 0 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  body: { marginLeft: 31, marginTop: 4, marginBottom: 6, gap: 10 },
  description: { fontSize: 13, lineHeight: 18 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.4 },
  picture: { height: 160, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  edit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 36,
  },
  editPath: { flex: 1, fontSize: 13 },
  full: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  fullText: { fontSize: 13, fontWeight: '500' },
  thought: { borderLeftWidth: 2, paddingLeft: 12, marginLeft: 11, marginTop: 4, marginBottom: 4 },
})

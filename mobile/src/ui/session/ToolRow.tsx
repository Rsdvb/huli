// A step of the conversation's work as one quiet line, as the desktop's tool call card draws it:
// an icon for its kind, its verb (in the past tense once done) and target, an edit's counts, and
// how it went: a spinner and its time while it runs, its time once done, 失败, 已取消, or 需要授权
// while it waits. Tapped, it opens to its command and output, its result or the file it read, and
// its edits, each opening to its diff.

import { memo, useState, type ReactNode } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import type { PermissionRisk } from '@shared/risk'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { ShellBlock, StepSection } from '../../components/entries/ShellBlock'
import { Markdown } from '../../components/Markdown'
import { handDiff } from '../../diff'
import { opensInViewer } from '../../preview/kinds'
import { Clamp, clampedText, useClampOpen } from './Clamp'
import { useSessionRows } from './context'
import { useDisclosure } from './disclosure'
import { plainText } from './feedback'
import { folderFile, openFile } from './fileRefs'
import { durationText, relativePath } from './format'
import { FileMark, G, Icon, TOOL_ICONS, type IconSpec } from './icons'
import { useSecond } from './now'
import { MONO, useSessionTokens } from './palette'
import { useOpenFade } from './Press'
import { Spinner } from '../StepMarks'
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

const RISK_WORDS = { low: '低风险', medium: '中风险', high: '高风险' } as const

/** Huli: the quiet note of a call the host allowed by itself, with the level it judged. */
function autoApproved(risk: PermissionRisk | undefined): string {
  return `已自动批准 · ${RISK_WORDS[risk?.level ?? 'low']}`
}

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
  if (result.by === 'routine') return { headline: '由定时任务允许', note: '', allowed }
  if (result.by === 'risk') return { headline: autoApproved(result.risk), note: '', allowed }
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
  // The diff screen takes comments on the edit's lines for this session.
  const { sessionId } = useSessionRows((rows) => ({ sessionId: rows.sessionId }))
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
            ...(sessionId ? { id: sessionId } : {}),
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

/**
 * How long since `since`, ticking each second while shown, on the screen's shared clock: a
 * tenth's tick redrew its line ten times a second for as long as a call ran.
 */
export function LiveTime(props: { since: number; color: string; prefix?: string }) {
  const elapsed = Math.max(0, useSecond() - props.since)
  return (
    <Text style={[styles.time, { color: props.color }]}>
      {props.prefix ?? ''}
      {durationText(elapsed - (elapsed % 1000))}
    </Text>
  )
}

/**
 * A call's result under its clamp: a file's content as Markdown, else its plain text. Closed, only
 * what the clamp can show is laid out, as a whole file read behind it held the screen up.
 */
function ClampedResult(props: { id: string; text: string; markdown?: boolean }) {
  const { c } = useSessionTokens()
  const text = clampedText(props.text, useClampOpen(props.id))
  return (
    <Clamp maxHeight={props.markdown ? 320 : 240} more="显示全部" id={props.id}>
      {props.markdown ? (
        <Markdown markdown={text} size="compact" />
      ) : (
        <Text style={[styles.raw, { color: c.text }]}>{text}</Text>
      )}
    </Clamp>
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
          <Spinner size={14} color={c.textTertiary} style={styles.spinner} />
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
      return props.duration !== undefined ? (
        <Text style={[styles.time, { color: c.textTertiary }]}>{formatMs(props.duration)}</Text>
      ) : null
  }
}

/**
 * A step's line, as the official app's timeline draws it: an icon tile, the verb in bold, the
 * dimmed detail cut in its middle for a path or a command, and its time at the end. Tapped, it
 * opens into a card it heads.
 */
export function StepLine(props: {
  icon: IconSpec
  name: string
  summary?: string | null
  mono?: boolean
  /** Cut the summary in its middle, as a path or a command wants. */
  middle?: boolean
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
      accessibilityLabel={[props.name, props.summary].filter(Boolean).join(' ')}
      style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={[styles.badge, { backgroundColor: c.fill, borderColor: c.border }]}>
        <Icon icon={props.icon} size={13} color={c.textSecondary} />
      </View>
      <Text
        style={[styles.name, { color: c.text }, !props.summary && styles.nameAlone]}
        numberOfLines={1}
      >
        {props.name}
      </Text>
      {props.summary ? (
        <Text
          style={[styles.summary, { color: c.textSecondary }, props.mono && styles.monoSummary]}
          numberOfLines={1}
          ellipsizeMode={props.middle ? 'middle' : 'tail'}
        >
          {props.summary}
        </Text>
      ) : null}
      {props.extra}
      {props.mark}
    </Pressable>
  )
}

/**
 * A step that opens into a rounded card its line heads, over its sections. Closed or open the line
 * keeps its view and its place: the card reaches out around it rather than pushing it in, and what
 * opens fades in under it, so only the rows below move.
 */
export function StepCard(props: { open: boolean; line: ReactNode; children?: ReactNode }) {
  const { c } = useSessionTokens()
  const shown = useOpenFade(props.open)
  return (
    <View
      style={[
        styles.card,
        props.open
          ? { backgroundColor: c.surface, borderColor: c.border, marginBottom: 4 }
          : styles.cardClosed,
      ]}
    >
      {props.line}
      {props.open ? (
        <Animated.View style={{ opacity: shown }}>{props.children}</Animated.View>
      ) : null}
    </View>
  )
}

/** Whether a call has details to open: content, a file to open, or a command too long for its line. */
function hasBody(entry: ToolEntry, label: ToolLabel, root: string | null): boolean {
  return (
    entry.content.length > 0 ||
    !!entry.description ||
    label.kind === 'command' ||
    toolFiles(entry, root).length > 0
  )
}

/**
 * The files of the session's folder a finished call read or wrote, each once, which its card
 * opens: a document in the system's viewer, any other file on the file screen. A text file whose
 * edit the card shows already opens from its diff.
 */
export function toolFiles(entry: ToolEntry, root: string | null): string[] {
  if (entry.status !== 'completed' || entry.toolKind === 'delete') return []
  const edited = new Set(toolEdits(entry).map((edit) => folderFile(edit.path, root)))
  const paths = new Set<string>()
  for (const location of entry.locations) {
    const path = folderFile(location.path, root)
    if (path && (opensInViewer(path) || !edited.has(path))) paths.add(path)
  }
  return [...paths]
}

/** A file the call names, which opens it. */
export function FileLine(props: { path: string; sessionId: string }) {
  const { c } = useSessionTokens()
  const viewer = opensInViewer(props.path)
  return (
    <Pressable
      onPress={() => openFile(props.sessionId, props.path)}
      accessibilityRole="button"
      accessibilityLabel={`打开 ${props.path}`}
      style={({ pressed }) => [styles.edit, { backgroundColor: pressed ? c.fillStrong : c.fill }]}
    >
      <FileMark path={props.path} size={13} />
      <Text style={[styles.editPath, { color: c.text }]} numberOfLines={1} ellipsizeMode="head">
        {props.path}
      </Text>
      <Text style={[styles.fullText, { color: c.tint }]}>{viewer ? '预览' : '打开'}</Text>
      <Icon icon={G.right} size={11} color={c.tint} weight="semibold" />
    </Pressable>
  )
}

export const ToolRow = memo(function ToolRow(props: { entry: ToolEntry; note?: string }) {
  const { root, sessionId } = useSessionRows((r) => ({ root: r.root, sessionId: r.sessionId }))
  const { c } = useSessionTokens()
  const { entry } = props
  const status = stepStatus(entry)
  const [open, setOpen] = useDisclosure(`tool:${entry.id}`)
  // A call that fails while shown opens, as the desktop's card does; a row the list hands another
  // call starts over.
  const [was, setWas] = useState({ id: entry.id, status })
  if (was.id !== entry.id || was.status !== status) {
    setWas({ id: entry.id, status })
    if (was.id === entry.id && status === 'error' && !open) setOpen(true)
  }
  const label = toolLabel(entry, root, entry.status === 'completed')
  const time = toolTime(sessionId, entry.id)
  const diffs = entry.content.filter((part) => part.type === 'diff')
  const stats = diffs.length > 0 ? diffStats(diffs) : null
  const result = entry.permissionResult
  const note =
    props.note ??
    (typeof result === 'object' && result?.by === 'routine'
      ? '由定时任务允许'
      : typeof result === 'object' && result?.by === 'risk'
        ? autoApproved(result.risk)
        : undefined)
  const body = hasBody(entry, label, root)
  const toggle = () => {
    setOpen((v) => !v)
  }
  const line = (
    <StepLine
      icon={TOOL_ICONS[entry.toolKind]}
      name={label.verb ?? label.target ?? entry.title}
      summary={label.verb && label.target ? label.target.split('\n')[0] : (note ?? null)}
      mono={label.kind === 'command'}
      middle={label.kind !== 'title'}
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
      open={open && body}
      onToggle={body ? toggle : null}
    />
  )
  return (
    <StepCard open={open && body} line={line}>
      <ToolBody entry={entry} label={label} />
    </StepCard>
  )
})

// How much of an edit's diff the card shows before the diff screen.
const DIFF_ROWS = 14

/** The first rows of an edit's diff, tinted, under the file it changed, which opens it whole. */
function DiffPreview(props: { edit: FileEdit; root: string | null }) {
  const { c } = useSessionTokens()
  const rows = props.edit.diff.rows.slice(0, DIFF_ROWS)
  const more = props.edit.diff.rows.length - rows.length
  return (
    <View style={{ gap: 8 }}>
      <EditLine edit={props.edit} root={props.root} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View>
          {rows.map((row, i) =>
            row.kind === 'hunk' ? (
              <Text key={i} style={[styles.diffRow, { color: c.textTertiary }]}>
                {row.text}
              </Text>
            ) : (
              <Text
                key={i}
                style={[
                  styles.diffRow,
                  {
                    color: row.kind === 'add' ? c.added : row.kind === 'del' ? c.removed : c.text,
                    backgroundColor:
                      row.kind === 'add' ? c.addedBg : row.kind === 'del' ? c.removedBg : undefined,
                  },
                ]}
              >
                {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
                {row.text}
              </Text>
            ),
          )}
        </View>
      </ScrollView>
      {more > 0 ? (
        <Text style={[styles.description, { color: c.textTertiary }]}>还有 {more} 行</Text>
      ) : null}
    </View>
  )
}

/**
 * A call's details as sections of its card: its command and what it printed, the file it read
 * with its line numbers or its raw result, its changes, and its pictures; then the full view.
 */
function ToolBody(props: { entry: ToolEntry; label: ToolLabel }) {
  const { c, s } = useSessionTokens()
  const { root, sessionId } = useSessionRows((r) => ({ root: r.root, sessionId: r.sessionId }))
  const { entry, label } = props
  const command = label.kind === 'command' ? label.target : null
  const output = command ? commandOutput(entry.content) : null
  const content = output === null ? entry.content : entry.content.slice(1)
  const path = entry.locations[0]?.path
  const edits = toolEdits(entry)
  const files = toolFiles(entry, root)
  let edit = 0
  return (
    <View>
      {entry.description && entry.description !== command ? (
        <Text style={[styles.description, styles.lead, { color: c.textSecondary }]}>
          {entry.description}
        </Text>
      ) : null}
      {command ? (
        <ShellBlock
          sessionId={sessionId}
          id={entry.id}
          command={command}
          output={output}
          status={entry.status}
        />
      ) : null}
      {content.map((part, i) => {
        if (part.type === 'markdown') {
          if (!part.markdown.trim()) return null
          const read = entry.toolKind === 'read' ? numberedRead(part.markdown, path) : null
          if (read) {
            return (
              <StepSection key={i} label="内容" copy={fenceBody(read)}>
                <ClampedResult id={`result:${entry.id}:${i}`} text={read} markdown />
              </StepSection>
            )
          }
          const raw = fenceBody(part.markdown)
          return (
            <StepSection key={i} label="结果" copy={raw}>
              <ClampedResult id={`result:${entry.id}:${i}`} text={raw} />
            </StepSection>
          )
        }
        if (part.type === 'diff') {
          const made = edits[edit++]
          return made ? (
            <StepSection key={i} label="更改" copy={made.newText}>
              <DiffPreview edit={made} root={root} />
            </StepSection>
          ) : null
        }
        const ref = part.ref
        if (ref.kind === 'image' && 'data' in ref) {
          return (
            <View key={i} style={[styles.pictureBox, { borderTopColor: c.border }]}>
              <Image
                source={{ uri: `data:${ref.mimeType};base64,${ref.data}` }}
                style={[styles.picture, { borderColor: s.codeBorder }]}
                contentFit="contain"
                cachePolicy="memory"
                accessibilityIgnoresInvertColors
              />
            </View>
          )
        }
        return (
          <Text
            key={i}
            style={[styles.description, styles.lead, { color: c.textTertiary }]}
            numberOfLines={1}
          >
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
      {files.length > 0 ? (
        <StepSection label={files.length > 1 ? `文件 · ${files.length}` : '文件'}>
          <View style={{ gap: 6 }}>
            {files.map((file) => (
              <FileLine key={file} path={file} sessionId={sessionId} />
            ))}
          </View>
        </StepSection>
      ) : null}
      <Pressable
        onPress={() => router.push({ pathname: '/tool', params: { sessionId, entryId: entry.id } })}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="全屏查看这次调用"
        style={({ pressed }) => [
          styles.full,
          { borderTopColor: c.border, opacity: pressed ? 0.55 : 1 },
        ]}
      >
        <Text style={[styles.fullText, { color: c.tint }]}>全屏查看</Text>
        <Icon icon={G.right} size={10} color={c.tint} weight="semibold" />
      </Pressable>
    </View>
  )
}

/** A thought as a step: 思考 and its heading; opened, a card with its text. */
export const ThoughtRow = memo(function ThoughtRow(props: {
  entry: Extract<ThreadEntry, { kind: 'thought' }>
}) {
  const { c } = useSessionTokens()
  const { entry } = props
  const [open, setOpen] = useDisclosure(`thought:${entry.id}`)
  const has = entry.markdown.trim() !== ''
  const line = (
    <StepLine
      icon={G.thought}
      name="思考"
      summary={thoughtTitle(entry.markdown)}
      mark={
        <StepMark status={entry.streaming ? 'running' : 'success'} duration={entry.durationMs} />
      }
      open={open && has}
      onToggle={
        has
          ? () => {
              setOpen((v) => !v)
            }
          : null
      }
    />
  )
  return (
    <StepCard open={open && has} line={line}>
      <StepSection label="思考" copy={plainText(entry.markdown)} mono={false}>
        <Clamp maxHeight={240} more="显示全部" id={`thought-text:${entry.id}`}>
          <Markdown
            markdown={entry.markdown}
            streaming={entry.streaming}
            size="compact"
            color={c.textSecondary}
          />
        </Clamp>
      </StepSection>
    </StepCard>
  )
})

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 34,
    paddingHorizontal: 10,
  },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '600', flexShrink: 0, maxWidth: '70%' },
  nameAlone: { flex: 1, flexShrink: 1, maxWidth: undefined },
  summary: { flex: 1, fontSize: 15, lineHeight: 20 },
  monoSummary: { fontFamily: MONO, fontSize: 13.5 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  spinner: { margin: 1 },
  time: { fontSize: 13, fontVariant: ['tabular-nums'] },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  // Reaching out by the line's padding, so the line sits where it does closed.
  card: {
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginHorizontal: -10,
    paddingHorizontal: 0,
  },
  cardClosed: { borderColor: 'transparent' },
  lead: { paddingHorizontal: 12, paddingBottom: 10 },
  description: { fontSize: 13, lineHeight: 18 },
  raw: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  diffRow: { fontFamily: MONO, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  pictureBox: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12 },
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
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  fullText: { fontSize: 13, fontWeight: '500' },
})

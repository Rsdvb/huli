// What waits for the user's answer: a tool to allow, as the desktop's permission card asks it (who
// wants to do what, why, what it touches, then 拒绝, 允许一次 and 始终允许), an ask's questions, a
// plan to approve, which PlanApprovalCard asks, and an MCP server's form or page, which
// ElicitationCard asks.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import type { HostLink } from '@shared/remote/link'
import { previewsCommand, type PermissionOption, type ToolEntry } from '@shared/thread'
import { handDiff } from '../diff'
import { sessionFolder } from '../git'
import { useConnected, useSession } from '../host'
import { useAgentName } from './entries/AccessEntries'
import { ElicitationCard } from './entries/ElicitationCard'
import { CardButton, SendState, useSender } from './entries/kit'
import { PlanApprovalCard } from './entries/PlanCards'
import { QuestionCard } from './entries/QuestionCard'
import { baseName, relativePath } from '../ui/session/format'
import { AgentGlyph, FileMark, G, Icon, TOOL_ICONS } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { Counts } from '../ui/session/TurnChanges'
import { toolEdits } from '../ui/session/turns'
import { toolLabel } from '../ui/session/work'
import { Markdown } from './Markdown'

function plain(name: string): string {
  return name.replace(/`/g, '')
}

export function PermissionCard(props: { entry: ToolEntry; sessionId: string; link: HostLink }) {
  if (props.entry.permission?.elicitation) {
    return <ElicitationCard entry={props.entry} sessionId={props.sessionId} />
  }
  if (props.entry.permission?.plan) {
    return <PlanApprovalCard entry={props.entry} sessionId={props.sessionId} />
  }
  if (!props.entry.permission?.questions?.length) return <ToolPermission {...props} />
  return <QuestionCard {...props} />
}

const ACTION: Record<ToolEntry['toolKind'], string> = {
  read: '读取文件',
  edit: '编辑文件',
  delete: '删除文件',
  move: '移动文件',
  search: '搜索项目',
  execute: '运行命令',
  think: '使用工具',
  fetch: '获取网页',
  switch_mode: '切换模式',
  other: '使用工具',
}

type Scope = 'once' | 'timed' | 'always'

/**
 * The agent's options on the card: its first denial as 拒绝, its allows as buttons after it, the
 * one-time allow first, and any other option as a button of its own before 拒绝.
 */
function answersOf(options: readonly PermissionOption[]) {
  const allows: Partial<Record<Scope, PermissionOption>> = {}
  const scopes: Scope[] = []
  const deny =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    null
  const others: PermissionOption[] = []
  for (const option of options) {
    if (option === deny) continue
    const order: Scope[] | null =
      option.kind === 'allow_once'
        ? ['once', 'timed', 'always']
        : option.kind === 'allow_always'
          ? ['always', 'timed', 'once']
          : null
    const scope = order?.find((s) => !allows[s])
    if (!scope) {
      others.push(option)
      continue
    }
    allows[scope] = option
    scopes.push(scope)
  }
  return { scopes, allows, deny, others }
}

/**
 * A tool call that asks for permission: 「<agent> 想要运行命令」 with what it names, 有风险 for a
 * command or a deletion, the agent's reason, the files it would touch with their counts, each
 * opening to its diff, and a command whole with the folder it runs in.
 */
function ToolPermission(props: { entry: ToolEntry; sessionId: string; link: HostLink }) {
  const { entry, link, sessionId } = props
  const { c, s } = useSessionTokens()
  const connected = useConnected()
  const agent = useAgentName(sessionId)
  const summary = useSession(sessionId)
  const root = summary && !summary.scratch ? sessionFolder(summary) : null
  const sender = useSender(entry.id)
  const [noteFor, setNoteFor] = useState<PermissionOption | null>(null)
  const [note, setNote] = useState('')
  const [allShown, setAllShown] = useState(false)
  const permission = entry.permission!
  const answers = answersOf(permission.options)
  const label = toolLabel(entry, root)
  const command = label.kind === 'command' ? label.target : null
  const target = command ? command.split('\n')[0]! : label.target
  const risky = entry.toolKind === 'execute' || entry.toolKind === 'delete'
  const away = !connected
  const busy = sender.busy !== null || away

  // What it would touch: each file it edits with its counts, or reads.
  const edits = toolEdits(entry)
  const seen = new Set<string>()
  const preview: { key: string; path: string; edit?: (typeof edits)[number] }[] = []
  edits.forEach((edit, i) => {
    seen.add(edit.path)
    preview.push({ key: `diff:${i}`, path: edit.path, edit })
  })
  if (entry.toolKind !== 'execute') {
    entry.locations.forEach((location, i) => {
      if (seen.has(location.path)) return
      seen.add(location.path)
      preview.push({ key: `path:${i}`, path: location.path })
    })
  }
  const shown = allShown ? preview : preview.slice(0, 4)

  const respond = (option: PermissionOption | null | undefined, text?: string) => {
    if (!option || busy) return
    if (option.note && text === undefined) {
      setNoteFor(option)
      return
    }
    void sender.send(option.id, () =>
      link.request('permissions.respond', {
        sessionId,
        requestId: permission.requestId,
        optionId: option.id,
        ...(text ? { note: text } : {}),
      }),
    )
  }

  const first =
    answers.scopes.find((s) => answers.allows[s]?.kind === 'allow_once') ?? answers.scopes[0]
  const rest = answers.scopes.filter((s) => s !== first)
  const allowWords = (scope: Scope): string => {
    const option = answers.allows[scope]
    if (!option) return ''
    const alike = answers.scopes.filter((x) => answers.allows[x]?.kind === option.kind).length
    if (alike === 1 && option.kind === 'allow_once') return '允许一次'
    if (alike === 1 && option.kind === 'allow_always') return '始终允许'
    return plain(option.name)
  }
  // An agent may spell out everything an allow covers, which the desktop shows on hover.
  const allowNote = (scope: Scope): string | undefined => {
    const option = answers.allows[scope]
    if (!option) return undefined
    const name = plain(option.name)
    return name === allowWords(scope) ? option.description : name
  }
  const notes = [first, ...rest].flatMap((scope) => {
    if (!scope) return []
    const words = allowNote(scope)
    return words ? [`${allowWords(scope)}：${words}`] : []
  })

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: s.dockCard, borderColor: c.borderStrong, shadowColor: c.shadow },
      ]}
    >
      <View style={styles.permHead}>
        <View style={[styles.avatar, { backgroundColor: c.fill }]}>
          {summary ? <AgentGlyph agentId={summary.agentId} size={15} /> : null}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.permTitle, { color: c.text }]}>
            <Text style={{ fontWeight: '700' }}>{agent}</Text> 想要
            <Text style={{ fontWeight: '700' }}>{ACTION[entry.toolKind]}</Text>
          </Text>
          {target ? (
            <View style={styles.sub}>
              <Icon icon={TOOL_ICONS[entry.toolKind]} size={12} color={c.textTertiary} />
              <Text
                style={[
                  styles.subText,
                  { color: c.textSecondary },
                  label.kind !== 'title' && { fontFamily: MONO, fontSize: 12.5 },
                ]}
                numberOfLines={1}
                ellipsizeMode={label.kind === 'path' ? 'head' : 'tail'}
              >
                {target}
              </Text>
            </View>
          ) : null}
        </View>
        {risky && (
          <View style={[styles.risk, { backgroundColor: s.warningSoft }]}>
            <Icon icon={G.warning} size={11} color={c.warning} />
            <Text style={[styles.riskText, { color: c.warning }]}>有风险</Text>
          </View>
        )}
      </View>
      {entry.description ? (
        <Text style={[styles.description, { color: c.textSecondary }]}>{entry.description}</Text>
      ) : null}
      {preview.length > 0 && (
        <View style={[styles.preview, { backgroundColor: c.fill }]}>
          <Text style={[styles.previewTitle, { color: c.textTertiary }]}>
            涉及的内容 <Text style={{ fontVariant: ['tabular-nums'] }}>{preview.length}</Text>
          </Text>
          {shown.map((item) => {
            const edit = item.edit
            const row = (
              <>
                <FileMark path={item.path} size={13} />
                <Text
                  style={[styles.previewPath, { color: c.text }]}
                  numberOfLines={1}
                  ellipsizeMode="head"
                >
                  {relativePath(item.path, root)}
                </Text>
                {edit ? (
                  <Counts
                    insertions={edit.diff.insertions}
                    deletions={edit.diff.deletions}
                    size={12}
                  />
                ) : null}
                {edit ? (
                  <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />
                ) : null}
              </>
            )
            return edit ? (
              <Pressable
                key={item.key}
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
                style={({ pressed }) => [styles.previewItem, { opacity: pressed ? 0.6 : 1 }]}
              >
                {row}
              </Pressable>
            ) : (
              <View key={item.key} style={styles.previewItem}>
                {row}
              </View>
            )
          })}
          {preview.length > 4 && (
            <Pressable onPress={() => setAllShown((v) => !v)} hitSlop={6}>
              <Text style={[styles.more, { color: c.tint }]}>
                {allShown ? '收起' : `还有 ${preview.length - 4} 项`}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {command ? (
        <View style={[styles.command, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
          <Text selectable style={[styles.mono, { color: c.text }]} numberOfLines={12}>
            <Text style={{ color: c.textTertiary }}>$ </Text>
            {command}
          </Text>
          {root && (previewsCommand(command) || entry.toolKind === 'execute') ? (
            <Text style={[styles.cwd, { color: c.textTertiary }]} numberOfLines={1}>
              {baseName(root)}
            </Text>
          ) : null}
        </View>
      ) : null}
      {entry.content.map((part, i) =>
        part.type === 'markdown' && part.markdown.trim() ? (
          <View key={i} style={{ marginTop: 10 }}>
            <Markdown markdown={part.markdown} size="compact" />
          </View>
        ) : null,
      )}
      {noteFor ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          <Text style={[styles.description, { color: c.text }]}>
            {plain(noteFor.name)}：写下要改什么
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            autoFocus
            selectionColor={c.accent}
            style={[
              styles.text,
              { color: c.text, borderColor: c.border, backgroundColor: c.fill, minHeight: 80 },
            ]}
          />
          <View style={styles.row}>
            <CardButton label="取消" disabled={busy} onPress={() => setNoteFor(null)} />
            <CardButton
              label="发送"
              tone="primary"
              busy={sender.busy === noteFor.id}
              disabled={busy}
              onPress={() => respond(noteFor, note.trim())}
            />
          </View>
        </View>
      ) : (
        <View style={[styles.row, { justifyContent: 'flex-end' }]}>
          {answers.others.map((option) => (
            <CardButton
              key={option.id}
              label={plain(option.name)}
              busy={sender.busy === option.id}
              disabled={busy}
              onPress={() => respond(option)}
            />
          ))}
          {answers.deny && (
            <CardButton
              label="拒绝"
              tone="danger"
              busy={sender.busy === answers.deny.id}
              disabled={busy}
              onPress={() => respond(answers.deny)}
            />
          )}
          {first && (
            <CardButton
              label={allowWords(first)}
              tone="primary"
              busy={sender.busy === answers.allows[first]?.id}
              disabled={busy}
              onPress={() => respond(answers.allows[first])}
            />
          )}
          {rest.map((scope) => (
            <CardButton
              key={scope}
              label={allowWords(scope)}
              busy={sender.busy === answers.allows[scope]?.id}
              disabled={busy}
              onPress={() => respond(answers.allows[scope])}
            />
          ))}
        </View>
      )}
      {notes.map((line) => (
        <Text key={line} style={[styles.optionNote, { color: c.textTertiary }]}>
          {line}
        </Text>
      ))}
      {away && (
        <Text style={[styles.optionNote, { color: c.textTertiary }]}>连上电脑后才能回答</Text>
      )}
      <SendState sender={sender} />
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    padding: 16,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  permHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permTitle: { fontSize: 16, lineHeight: 22 },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  subText: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  risk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 5,
    paddingHorizontal: 6,
    height: 20,
    marginTop: 1,
  },
  riskText: { fontSize: 11, fontWeight: '600' },
  preview: { borderRadius: 12, padding: 10, marginTop: 12, gap: 6 },
  previewTitle: { fontSize: 12, fontWeight: '600' },
  previewItem: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 },
  previewPath: { flex: 1, fontSize: 13 },
  more: { fontSize: 13, fontWeight: '500' },
  command: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginTop: 12,
    gap: 6,
  },
  cwd: { fontSize: 11.5, alignSelf: 'flex-end' },
  optionNote: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  row: { flexDirection: 'row', gap: 8, marginTop: 14 },
  text: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    fontSize: 15,
  },
})

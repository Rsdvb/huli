// An agent's publish to the Kettu Marketplace, or its unlisting, as the desktop's card asks it: the
// listing, who sees it, what it adds, runs and uploads, a new version's notes and a first publish's
// publisher name. Publish uploads; Not now keeps a draft and uploads nothing.

import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { HANDLE, LISTING_NOTES_CHARS, type PublishVisibility } from '@shared/market-publish'
import type { ThreadEntry } from '@shared/thread'
import { call } from '../../git'
import { useLink } from '../../host'
import { haptic } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { useAgentName, type Place } from './AccessEntries'
import {
  answeredDetail,
  AskCard,
  E,
  kit,
  QuietLine,
  useAnsweredAt,
  useSender,
  WaitingLine,
} from './kit'

type Entry = Extract<ThreadEntry, { kind: 'market_publish' }>

const KIND = { skill: 'Skill', plugin: '插件', 'mcp-server': 'MCP 服务器', workflow: '工作流' }
const VISIBILITY = { public: '所有人', private: '只有我', unlisted: '已下架' }
const VISIBILITY_HINT = {
  public: '列进插件市场，登录 Kite Cloud 的人都能看到。',
  private: '不列出，只有登录你账号的电脑能装。',
}
const ADDS_GROUP: Record<string, string> = {
  skills: 'Skill',
  commands: '命令',
  agents: 'Agent',
  hooks: 'Hook',
  servers: 'MCP 服务器',
}
const WORKFLOW_GROUP: Record<string, string> = {
  steps: '步骤',
  waits: '等你的步骤',
  servers: '点名的 MCP 服务器',
  skills: '点名的 Skill',
}
const HARNESS = { 'claude-code': 'Claude Code', codex: 'Codex' }

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Whether the card still waits: unanswered and not past the time it counts as put off. */
export function publishWaits(entry: Entry, now = Date.now()): boolean {
  return entry.outcome === null && now < entry.expiresAt
}

function outcomeText(entry: Entry): { text: string; done: boolean; busy: boolean } {
  const name = entry.item.name
  const outcome = entry.outcome
  switch (outcome?.kind) {
    case 'published':
      return { text: `已发布 ${name} ${outcome.version}`, done: true, busy: false }
    case 'unlisted':
      return { text: `已下架 ${name}`, done: true, busy: false }
    case 'publishing':
      return { text: `正在发布 ${name}…`, done: false, busy: true }
    case 'unlisting':
      return { text: `正在下架 ${name}…`, done: false, busy: true }
    case 'failed':
      return {
        text: entry.action === 'unlist' ? `没能下架 ${name}` : `没能发布 ${name}`,
        done: false,
        busy: false,
      }
    case 'later':
      return { text: '没有发布', done: false, busy: false }
    case 'ended':
      return { text: '这一轮先结束了', done: false, busy: false }
    case 'interrupted':
      return { text: '插件市场回复之前纸鸢停止了', done: false, busy: false }
    default:
      return { text: '没有及时回答', done: false, busy: false }
  }
}

export function MarketPublishEntry(props: { entry: Entry; sessionId: string; place: Place }) {
  const { entry } = props
  const waiting = publishWaits(entry)
  const at = useAnsweredAt(entry.id, waiting)
  const [open, setOpen] = useState(false)
  const { c } = useSessionTokens()
  if (waiting) {
    if (props.place === 'thread') {
      return <WaitingLine icon={E.store} text={`发布到插件市场 · ${entry.item.name}`} />
    }
    return <PublishCard entry={entry} sessionId={props.sessionId} />
  }
  if (props.place === 'dock') return null
  const shown = outcomeText(entry)
  const outcome = entry.outcome
  const failed = outcome?.kind === 'failed' ? outcome : null
  const meta =
    outcome?.kind === 'published'
      ? `@${outcome.handle}/${entry.item.slug} · ${VISIBILITY[entry.visibility]}`
      : !shown.busy && !shown.done && !failed && entry.action !== 'unlist'
        ? '已留成草稿'
        : null
  return (
    <View>
      <QuietLine
        icon={
          shown.done ? G.done : failed ? G.warning : outcome?.kind === 'later' ? E.clock : G.failed
        }
        tone={shown.busy ? 'busy' : shown.done ? 'done' : failed ? 'failed' : 'other'}
        text={shown.text}
        detail={[meta, answeredDetail(at, entry.device)].filter(Boolean).join(' · ') || null}
        {...(failed && failed.problems.length > 0
          ? {
              onPress: () => {
                haptic.pick()
                setOpen((v) => !v)
              },
            }
          : {})}
      />
      {failed ? (
        <View style={styles.problems}>
          <Text selectable style={[styles.problem, { color: c.textSecondary }]}>
            {failed.message}
          </Text>
          {open &&
            failed.problems.map((p, i) => (
              <Text key={i} selectable style={[styles.problem, { color: c.textSecondary }]}>
                {p.path ? <Text style={{ fontFamily: MONO }}>{p.path} </Text> : null}
                {p.message}
              </Text>
            ))}
        </View>
      ) : null}
    </View>
  )
}

function PublishCard(props: { entry: Entry; sessionId: string }) {
  const { entry, sessionId } = props
  const { c, s } = useSessionTokens()
  const link = useLink()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const unlist = entry.action === 'unlist'
  const fresh = !unlist && entry.listingId === null
  const newVersion = !unlist && entry.listingId !== null
  const [visibility, setVisibility] = useState<PublishVisibility>(
    entry.visibility === 'private' ? 'private' : 'public',
  )
  const [notes, setNotes] = useState(entry.notes ?? '')
  const [handle, setHandle] = useState(entry.publisher?.suggested ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)

  const answer = (decision: 'confirm' | 'later') =>
    call(link, 'market.answerPublish', {
      sessionId,
      entryId: entry.id,
      decision,
      ...(decision === 'confirm' && fresh ? { visibility } : {}),
      ...(decision === 'confirm' && newVersion ? { notes } : {}),
      ...(decision === 'confirm' && entry.publisher ? { handle: handle.trim() } : {}),
    })

  const publish = async () => {
    if (entry.publisher && !HANDLE.test(handle.trim())) {
      setProblem('发布者名是 1 到 32 个小写字母、数字和连字符，开头和结尾是字母或数字。')
      return false
    }
    setProblem(null)
    return answer('confirm')
  }

  const title = unlist
    ? `把 ${entry.item.name} 从插件市场下架？`
    : newVersion
      ? `发布 ${entry.item.name} 的 ${entry.version ?? ''}？`
      : '发布到插件市场？'
  const body = unlist
    ? '它会从插件市场里去掉。已经装了的人照常能用，也照常收到新版本。'
    : newVersion && entry.installs > 0
      ? `${entry.installs} 人装着它，他们下次更新时拿到 ${entry.version ?? ''}。`
      : '点发布之前什么都不上传。以后的新版本还会再问你。'

  const row = (label: string, value: ReactNode) => (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: c.textTertiary }]}>{label}</Text>
      <View style={{ flex: 1 }}>{value}</View>
    </View>
  )
  const plain = (text: string, mono = false) => (
    <Text selectable style={[styles.factText, { color: c.text }, mono && { fontFamily: MONO }]}>
      {text}
    </Text>
  )

  return (
    <AskCard
      icon={E.store}
      title={title}
      body={body}
      sender={sender}
      actions={[
        { key: 'later', label: '以后再说', run: () => answer('later') },
        {
          key: 'confirm',
          label: unlist ? '下架' : newVersion && entry.version ? `发布 ${entry.version}` : '发布',
          tone: 'primary',
          run: publish,
        },
      ]}
    >
      <View style={[styles.listing, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
        <Text style={[styles.name, { color: c.text }]}>
          {entry.item.name}
          <Text style={{ color: c.textSecondary, fontWeight: '400' }}>
            {'  '}
            {KIND[entry.item.kind]}
            {entry.version
              ? ` · ${entry.previous ? `${entry.previous} → ` : ''}${entry.version}`
              : ''}
          </Text>
        </Text>
        {entry.item.description ? (
          <Text style={[styles.factText, { color: c.textSecondary }]}>
            {entry.item.description}
          </Text>
        ) : null}
      </View>

      {fresh && (
        <View style={kit.section}>
          <Text style={[kit.label, { color: c.textSecondary }]}>谁能看到</Text>
          <View style={kit.chips}>
            {(['public', 'private'] as const).map((value) => {
              const on = visibility === value
              return (
                <Pressable
                  key={value}
                  onPress={() => {
                    haptic.pick()
                    setVisibility(value)
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
                  <Text style={[kit.chipText, { color: on ? c.accent : c.text }]}>
                    {VISIBILITY[value]}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <Text style={[kit.hint, { color: c.textTertiary }]}>{VISIBILITY_HINT[visibility]}</Text>
        </View>
      )}

      {newVersion && (
        <View style={kit.section}>
          <Text style={[kit.label, { color: c.textSecondary }]}>更新说明 · {agent} 写的，能改</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            multiline
            maxLength={LISTING_NOTES_CHARS}
            placeholder="这个版本改了什么"
            placeholderTextColor={c.textTertiary}
            selectionColor={c.accent}
            style={[
              kit.field,
              { color: c.text, borderColor: c.border, backgroundColor: c.fill, minHeight: 72 },
            ]}
          />
        </View>
      )}

      <View style={[kit.section, { gap: 8 }]}>
        {!fresh &&
          row('谁能看到', plain(`${VISIBILITY[entry.visibility]}${unlist ? '' : ' · 和之前一样'}`))}
        {entry.adds.length > 0 &&
          row(
            '会加',
            <View style={{ gap: 2 }}>
              {entry.adds.map((group) => (
                <Text key={group.label} selectable style={[styles.factText, { color: c.text }]}>
                  {(entry.item.kind === 'workflow' ? WORKFLOW_GROUP : ADDS_GROUP)[group.label] ??
                    group.label}{' '}
                  <Text style={{ fontFamily: MONO, color: c.textSecondary }}>
                    {group.items.join(group.label === 'steps' ? ' → ' : ', ')}
                  </Text>
                </Text>
              ))}
            </View>,
          )}
        {!unlist &&
          row(
            entry.item.kind === 'workflow' ? '步骤由谁做' : '适用于',
            plain(
              entry.item.kind === 'workflow'
                ? 'Claude Code 和 Codex'
                : entry.item.kind === 'plugin' && entry.item.harness
                  ? HARNESS[entry.item.harness]
                  : '所有 Agent',
            ),
          )}
        {entry.runs.length > 0 &&
          row(
            '会运行',
            <View style={{ gap: 2 }}>
              {entry.runs.map((line) => (
                <Text key={line} selectable style={[kit.mono, { color: c.text }]}>
                  {line}
                </Text>
              ))}
            </View>,
          )}
        {!unlist &&
          entry.changes &&
          entry.changes.length > 0 &&
          row(
            '改动',
            <View style={{ gap: 2 }}>
              {entry.changes.map((change) => (
                <Text key={change.path} style={[kit.mono, { color: c.text }]}>
                  {change.path}
                  {(change.added ?? 0) > 0 ? (
                    <Text style={{ color: c.added }}> +{change.added}</Text>
                  ) : null}
                  {(change.removed ?? 0) > 0 ? (
                    <Text style={{ color: c.removed }}> −{change.removed}</Text>
                  ) : null}
                  {change.status !== 'changed' ? (
                    <Text style={{ color: c.textTertiary }}>
                      {' '}
                      {change.status === 'added' ? '新文件' : '已删除'}
                    </Text>
                  ) : null}
                </Text>
              ))}
            </View>,
          )}
        {!unlist &&
          entry.files.length > 0 &&
          row(
            '上传',
            <View style={{ gap: 2 }}>
              {plain(`${entry.files.length} 个文件，${bytes(entry.bytes)}`)}
              <Text style={[kit.mono, { color: c.textTertiary }]}>来自 {entry.folder}</Text>
              <Pressable onPress={() => setFilesOpen((v) => !v)} hitSlop={6}>
                <Text style={[styles.link, { color: c.tint }]}>
                  {filesOpen ? '收起文件' : '看文件'}
                </Text>
              </Pressable>
              {filesOpen &&
                entry.files.map((file) => (
                  <Text key={file.path} style={[kit.mono, { color: c.textSecondary }]}>
                    {file.path}
                    <Text style={{ color: c.textTertiary }}> {bytes(file.size)}</Text>
                  </Text>
                ))}
            </View>,
          )}
        {!unlist &&
          row(
            '检查',
            <View style={{ gap: 2 }}>
              {[
                entry.manifest,
                '没有密钥',
                entry.runs.length === 0 ? '安装时不运行任何东西' : '没有超出上限',
              ]
                .filter((x): x is string => !!x)
                .map((line) => (
                  <View key={line} style={styles.check}>
                    <Icon icon={G.check} size={12} color={c.success} />
                    <Text style={[styles.factText, { color: c.text }]}>{line}</Text>
                  </View>
                ))}
            </View>,
          )}
      </View>

      {entry.publisher && (
        <View style={kit.section}>
          <Text style={[kit.label, { color: c.textSecondary }]}>发布者名</Text>
          <View
            style={[
              styles.handle,
              { borderColor: problem ? c.danger : c.border, backgroundColor: c.fill },
            ]}
          >
            <Text style={{ color: c.textTertiary, fontSize: 15 }}>@</Text>
            <TextInput
              value={handle}
              onChangeText={(text) => {
                setHandle(text.toLowerCase())
                setProblem(null)
              }}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={32}
              selectionColor={c.accent}
              style={[styles.handleInput, { color: c.text }]}
            />
          </View>
          <Text style={[kit.hint, { color: problem ? c.danger : c.textTertiary }]}>
            {problem ?? '这是你第一次发布：你发布的每一项都会写着这个名字。以后能在“已发布”里改。'}
          </Text>
        </View>
      )}
    </AskCard>
  )
}

const styles = StyleSheet.create({
  problems: { marginLeft: 21, gap: 4, marginBottom: 4 },
  problem: { fontSize: 13, lineHeight: 18 },
  listing: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, marginTop: 12 },
  name: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  fact: { flexDirection: 'row', gap: 10 },
  factLabel: { width: 64, fontSize: 13, lineHeight: 18 },
  factText: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 13, fontWeight: '500' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  handle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  handleInput: { flex: 1, fontSize: 15, paddingVertical: 10 },
})

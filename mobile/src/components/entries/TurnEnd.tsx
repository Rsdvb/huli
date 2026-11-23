// How a turn ended badly, as the desktop shows it: a failed turn's notice with Retry, which sends
// its message again; a turn the agent's exit cut short with Resume; a turn the model provider
// refused for want of credit, with its details, and the strip above the composer that offers Retry
// and another model.

import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import {
  outOfCreditTurn,
  retryableTurn,
  type ConfigOption,
  type SessionStatus,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { GITHUB_URL } from '../../about'
import { call } from '../../git'
import { Clamp } from '../../ui/session/Clamp'
import { useEntryOn, useLink } from '../../host'
import { copyText } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { useSessionRows } from '../../ui/session/context'
import { useDisclosure } from '../../ui/session/disclosure'
import { CardButton, E, SendState, useSender } from './kit'
import { openUrl } from '../../system/openUrl'

type Notice = Extract<ThreadEntry, { kind: 'notice' }>

const free = (status: SessionStatus | undefined) => status === 'ready' || status === 'closed'

/** The failed latest turn's notice that Retry sends again, while the session is free. */
export function retryNoticeOf(thread: ThreadState | null): string | null {
  if (!thread || !free(thread.session.status) || thread.session.origin === 'subagent') return null
  return retryableTurn(thread)?.notice.id ?? null
}

/** Whether the failed latest turn, which Retry sends again, stopped at the agent's plan limit. */
export function planLimitStopOf(thread: ThreadState | null): boolean {
  const id = retryNoticeOf(thread)
  const entry = id ? thread?.byId[id] : undefined
  return entry?.kind === 'notice' && entry.planLimit === true
}

/** The latest turn's notice of the agent's exit, which Resume continues, for a user's session. */
export function cutNoticeOf(thread: ThreadState | null): string | null {
  if (!thread || !free(thread.session.status) || thread.session.origin !== 'user') return null
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (!entry) continue
    if (entry.kind === 'user' && !entry.steered) return null
    if (entry.kind === 'notice' && entry.cause === 'agent_stopped') return entry.id
  }
  return null
}

/** The latest turn's out-of-credit notice, while the session is free to send it again. */
export function outOfCreditOf(thread: ThreadState | null): Notice | null {
  if (!thread || !free(thread.session.status)) return null
  return outOfCreditTurn(thread)?.notice ?? null
}

export function NoticeEntry(props: { entry: Notice }) {
  const { entry } = props
  const { c, s } = useSessionTokens()
  const { sessionId, retryNotice, cutNotice, carryOn } = useSessionRows((r) => ({
    sessionId: r.sessionId,
    retryNotice: r.retryNotice,
    cutNotice: r.cutNotice,
    carryOn: r.carryOn,
  }))
  const link = useLink()
  const sender = useSender()
  const [open, setOpen] = useDisclosure(`notice:${entry.id}`)
  // Held after it went: the button goes once the turn that starts reaches the phone.
  const [sent, setSent] = useState(false)
  const credit = entry.cause === 'out_of_credit'
  const cut = entry.cause === 'agent_stopped'
  const tone = credit
    ? { icon: E.wallet, color: c.warning, bg: s.warningSoft }
    : entry.severity === 'error' || cut
      ? { icon: G.error, color: c.danger, bg: s.dangerSoft }
      : entry.severity === 'warning'
        ? { icon: G.warning, color: c.warning, bg: s.warningSoft }
        : { icon: G.info, color: c.textSecondary, bg: c.fill }
  const retry = entry.cause === 'turn_failed' && retryNotice === entry.id
  const carry = retry && entry.planLimit === true ? (carryOn ?? null) : null
  const resume = cut && cutNotice === entry.id

  return (
    <View style={[styles.notice, { backgroundColor: tone.bg }]}>
      <View style={{ height: 20, justifyContent: 'center' }}>
        <Icon icon={tone.icon} size={15} color={tone.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.title, { color: entry.severity === 'info' ? c.text : tone.color }]}>
          {entry.title}
        </Text>
        {entry.description && credit ? (
          <>
            <Pressable
              onPress={() => setOpen((v) => !v)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              style={styles.details}
            >
              <Text style={[styles.detailsText, { color: c.textTertiary }]}>详情</Text>
              <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
                <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />
              </View>
            </Pressable>
            {open && (
              <View style={[styles.raw, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
                <Text selectable style={[styles.mono, { color: c.textSecondary }]}>
                  {entry.description}
                </Text>
                <Pressable
                  onPress={() => void copyText(entry.description!)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="复制原始信息"
                  style={styles.copy}
                >
                  <Icon icon={G.copy} size={14} color={c.textTertiary} />
                </Pressable>
              </View>
            )}
          </>
        ) : entry.description ? (
          // An agent's error can run to pages, as a stack trace does: it is cut short until opened.
          <Clamp maxHeight={120} id={`notice:${entry.id}`}>
            <Text selectable style={[styles.text, { color: c.textSecondary }]}>
              <Linked text={entry.description} color={c.tint} />
            </Text>
          </Clamp>
        ) : null}
        {(retry || resume || entry.cause === 'turn_failed') && (
          <View style={styles.actions}>
            {carry && (
              <CardButton
                label={`换成 ${carry.name} 继续`}
                busy={sender.busy === 'carry'}
                disabled={sender.busy !== null || sent}
                onPress={() => void sender.send('carry', carry.go).then(setSent)}
              />
            )}
            {retry || resume ? (
              <CardButton
                label={retry ? '重试' : '继续'}
                busy={sender.busy !== null || sent}
                disabled={sender.busy !== null || sent}
                onPress={() =>
                  void sender
                    .send('go', () =>
                      retry
                        ? call(link, 'sessions.retry', { sessionId })
                        : call(link, 'sessions.queue', {
                            sessionId,
                            content: [{ type: 'text', text: '继续' }],
                          }),
                    )
                    .then(setSent)
                }
              />
            ) : null}
            {entry.cause === 'turn_failed' ? (
              <CardButton
                label="报告问题"
                onPress={() => reportFailure(entry.title, entry.description ?? null)}
              />
            ) : null}
          </View>
        )}
        {entry.mcpServers?.[0] !== undefined ? (
          <McpNoticeActions sessionId={sessionId} entryId={entry.id} server={entry.mcpServers[0]} />
        ) : null}
        <SendState sender={sender} />
      </View>
    </View>
  )
}

/**
 * Huli: a notice of an MCP server that failed or needs a sign-in opens the session's MCP page, and
 * goes once dismissed; the server is told of again only once its state changes.
 */
function McpNoticeActions(props: { sessionId: string; entryId: string; server: string }) {
  const on = useEntryOn('phone.mcpNotice')
  const link = useLink()
  const sender = useSender()
  return (
    <>
      <View style={styles.actions}>
        {on ? (
          <CardButton
            label="查看 MCP 服务器"
            onPress={() =>
              router.push({
                pathname: '/mcp/[id]',
                params: { id: props.sessionId, server: props.server },
              })
            }
          />
        ) : null}
        <CardButton
          label="关闭提示"
          busy={sender.busy === 'dismiss'}
          disabled={sender.busy !== null}
          onPress={() =>
            void sender.send('dismiss', () =>
              call(link, 'sessions.dismissNotice', {
                sessionId: props.sessionId,
                entryId: props.entryId,
              }),
            )
          }
        />
      </View>
      <SendState sender={sender} />
    </>
  )
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)】]+/g

/** Text with its web addresses tappable, as the desktop's notice links them. */
function Linked(props: { text: string; color: string }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  for (const match of props.text.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?。，；：！？]+$/, '')
    const from = match.index
    if (from > at) parts.push(props.text.slice(at, from))
    parts.push(
      <Text
        key={from}
        style={{ color: props.color }}
        accessibilityRole="link"
        onPress={() => openUrl(url)}
      >
        {url}
      </Text>,
    )
    at = from + url.length
  }
  if (at < props.text.length) parts.push(props.text.slice(at))
  return parts
}

/**
 * Opens a new issue for a failed turn, as the desktop's 报告问题 opens its report: the error goes in
 * the issue's text for the user to read and send, nothing else.
 */
function reportFailure(title: string, description: string | null): void {
  const error = [title, description].filter(Boolean).join('\n').slice(0, 2000)
  const body = `这一轮出错了：\n\n\`\`\`\n${error}\n\`\`\`\n\n（发生了什么，想做什么：）\n`
  const url = `${GITHUB_URL}/issues/new?title=${encodeURIComponent(`会话出错：${title}`)}&body=${encodeURIComponent(body)}`
  openUrl(url)
}

/** Above the composer after a turn the provider refused for want of credit. */
export function OutOfCreditStrip(props: {
  sessionId: string
  notice: Notice
  config: readonly ConfigOption[]
  onSwitchModel: (() => void) | null
}) {
  const { c, s } = useSessionTokens()
  const link = useLink()
  const sender = useSender()
  const [sent, setSent] = useState(false)
  const option = props.config.find((o) => o.category === 'model')
  const name = props.notice.model
    ? (option?.choices?.find((choice) => choice.value === props.notice.model)?.name ??
      props.notice.model)
    : null
  return (
    <View style={[styles.strip, { backgroundColor: s.dockCard, borderColor: c.borderStrong }]}>
      <View style={styles.stripHead}>
        <Icon icon={E.wallet} size={16} color={c.warning} />
        <Text style={[styles.stripText, { color: c.text }]}>
          {name
            ? `${name} 的服务商余额已用完。充值或换一个模型后继续。`
            : '模型服务商的余额已用完。充值后继续。'}
        </Text>
      </View>
      <View style={styles.actions}>
        <CardButton
          label="重试"
          busy={sender.busy !== null || sent}
          disabled={sender.busy !== null || sent}
          onPress={() =>
            void sender
              .send('retry', () => call(link, 'sessions.retry', { sessionId: props.sessionId }))
              .then(setSent)
          }
        />
        {option && props.onSwitchModel ? (
          <CardButton label="切换模型" onPress={props.onSwitchModel} />
        ) : null}
      </View>
      <SendState sender={sender} />
    </View>
  )
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    gap: 9,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  title: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  text: { fontSize: 13, lineHeight: 18 },
  details: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  detailsText: { fontSize: 13 },
  raw: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    paddingRight: 34,
    marginTop: 4,
  },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  copy: { position: 'absolute', top: 8, right: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  strip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 14 },
  stripHead: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  stripText: { flex: 1, fontSize: 14, lineHeight: 20 },
})

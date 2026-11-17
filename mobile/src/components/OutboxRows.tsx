// The messages waiting on the phone for the computer (outbox.ts), where they will show once sent:
// a session's as its newest messages, each with 等连上电脑后发送 · 撤回 under it, or 发送失败 · 重试 ·
// 撤回 once the computer refused it; and New session's as cards of the sessions to be made.

import { memo, useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { Attachment, UserContent } from '@shared/thread'
import { useComputerId } from '../host'
import { retryItem, useOutbox, useOutboxSending, type OutboxItem } from '../outbox'
import { haptic } from '../ui/session/feedback'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { UserMessage } from './UserMessage'

/** What a waiting message shows as, its kept files as attachments of their own. */
function contentOf(item: OutboxItem): UserContent[] {
  const content: UserContent[] = item.text ? [{ type: 'text', text: item.text }] : []
  for (const kept of item.attachments) {
    const attachment: Attachment =
      kept.kind === 'held'
        ? kept.attachment
        : {
            id: `${item.id}:${kept.kind === 'file' ? kept.file : kept.path}`,
            type: kept.kind === 'file' && kept.mimeType.startsWith('image/') ? 'image' : 'file',
            name: kept.name,
            uri: null,
            mimeType: kept.kind === 'file' ? kept.mimeType : null,
            size: kept.kind === 'file' ? kept.size : null,
            sent: null,
            thumb: kept.kind === 'file' ? kept.thumb : null,
            blob: null,
          }
    content.push({ type: 'ref', ref: { kind: 'attachment', attachment } })
  }
  return content
}

/** Under a waiting message: how it stands, and what can be done with it. */
function Status(props: {
  item: OutboxItem
  sending: boolean
  onWithdraw(id: string): void
  /** In a card: from the left, as its text reads. */
  start?: boolean
}) {
  const { c } = useSessionTokens()
  const computer = useComputerId()
  const { item } = props
  const failed = item.failed !== undefined
  if (props.sending) {
    return (
      <View style={[styles.status, props.start && styles.start]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={c.textTertiary} style={styles.spinner} />
        <Text style={[styles.meta, { color: c.textTertiary }]}>正在发送…</Text>
      </View>
    )
  }
  const action = (label: string, onPress: () => void) => (
    <Pressable
      onPress={() => {
        haptic.tap()
        onPress()
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.meta, styles.action, { color: c.accent }]}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={[styles.statusBox, props.start && styles.start]}>
      <View style={[styles.status, props.start && styles.start]}>
        <Icon
          icon={failed ? G.warning : G.wifiOff}
          size={11}
          color={failed ? c.danger : c.textTertiary}
        />
        <Text style={[styles.meta, { color: failed ? c.danger : c.textTertiary }]}>
          {failed ? '发送失败' : item.sessionId === null ? '等连上电脑后新建' : '等连上电脑后发送'}
        </Text>
        {failed && computer ? (
          <>
            <Text style={[styles.meta, { color: c.textTertiary }]}>·</Text>
            {action('重试', () => retryItem(computer, item.id))}
          </>
        ) : null}
        <Text style={[styles.meta, { color: c.textTertiary }]}>·</Text>
        {action('撤回', () => props.onWithdraw(item.id))}
      </View>
      {failed && item.failed ? (
        <Text
          style={[styles.meta, !props.start && styles.reason, { color: c.textTertiary }]}
          numberOfLines={2}
        >
          {item.failed}
        </Text>
      ) : null}
    </View>
  )
}

const PendingMessage = memo(function PendingMessage(props: {
  item: OutboxItem
  sending: boolean
  onWithdraw(id: string): void
}) {
  const content = useMemo(() => contentOf(props.item), [props.item])
  return (
    <View style={[styles.message, { opacity: props.item.failed ? 1 : 0.72 }]}>
      <UserMessage content={content} />
      <Status item={props.item} sending={props.sending} onWithdraw={props.onWithdraw} />
    </View>
  )
})

/** A session's waiting messages, oldest first; nothing when none waits. */
export function OutboxRows(props: { sessionId: string; onWithdraw(id: string): void }) {
  const computer = useComputerId()
  const items = useOutbox(computer, props.sessionId)
  const sending = useOutboxSending()
  if (items.length === 0) return null
  return (
    <View style={styles.rows}>
      {items.map((item) => (
        <PendingMessage
          key={item.id}
          item={item}
          sending={sending.has(item.id)}
          onWithdraw={props.onWithdraw}
        />
      ))}
    </View>
  )
}

/** Whether a session has messages waiting on the phone. */
export function useHasOutbox(sessionId: string): boolean {
  return useOutbox(useComputerId(), sessionId).length > 0
}

/** New session's waiting sessions, each a card with its first message. */
export function PendingSessions(props: {
  parentId?: string
  agentName(agentId: string): string
  onWithdraw(id: string): void
}) {
  const { c, s } = useSessionTokens()
  const computer = useComputerId()
  const items = useOutbox(computer, null, props.parentId)
  const sending = useOutboxSending()
  if (items.length === 0) return null
  return (
    <View style={styles.cards}>
      {items.map((item) => {
        const attachments = item.attachments.length
        const words = item.text.trim().split('\n')[0] ?? ''
        return (
          <View
            key={item.id}
            style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.border }]}
          >
            <Text style={[styles.cardTitle, { color: c.text }]} numberOfLines={1}>
              新会话 · {props.agentName(item.create?.agentId ?? '')}
            </Text>
            {words || attachments > 0 ? (
              <Text style={[styles.cardText, { color: c.textSecondary }]} numberOfLines={2}>
                {words}
                {attachments > 0 ? `${words ? ' · ' : ''}${attachments} 个附件` : ''}
              </Text>
            ) : null}
            <Status
              item={item}
              sending={sending.has(item.id)}
              onWithdraw={props.onWithdraw}
              start
            />
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  rows: { gap: 14, paddingTop: 14 },
  message: { gap: 4 },
  statusBox: { alignItems: 'flex-end', gap: 2, marginRight: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'flex-end' },
  spinner: { transform: [{ scale: 0.7 }] },
  meta: { fontSize: 12, lineHeight: 16 },
  action: { fontWeight: '600' },
  reason: { textAlign: 'right', paddingLeft: 48 },
  start: { alignItems: 'flex-start', justifyContent: 'flex-start', marginRight: 0 },
  cards: { gap: 8, paddingBottom: 6 },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  cardTitle: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  cardText: { fontSize: 13, lineHeight: 18 },
})

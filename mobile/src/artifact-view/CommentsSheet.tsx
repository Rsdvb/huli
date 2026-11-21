// An artifact's comments on the phone: its threads, open ones first by default, each with its
// anchor as the page reported it (shown only as plain text), its comments, a reply and resolve; and
// a new comment on the page shown, or on an element picked in it.

import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  COMMENT_CHARS,
  isAnswered,
  type CommentAnchor,
  type CommentThread,
} from '@shared/artifact-comments'
import { useHost } from '../host'
import { LockLayer } from '../lock'
import { errorText, momentText, sessionTitle } from '../sessions'
import { haptic } from '../ui/haptics'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale, RoundButton } from '../ui/session/Press'
import { anchorLabel } from './comments'

export interface CommentTarget {
  anchor: CommentAnchor
  /** Picked in the page, rather than the page itself. */
  picked: boolean
}

export function CommentsSheet(props: {
  visible: boolean
  artifactId: string
  threads: CommentThread[] | null
  error: string | null
  /** What a new comment is on. */
  target: CommentTarget
  /** Picking an element works on this page; null where it cannot, as on a typed artifact. */
  onPickElement: (() => void) | null
  /** Back to a comment on the page itself. */
  onClearPick(): void
  onChanged(thread: CommentThread): void
  onRetry(): void
  onClose(): void
}) {
  const { c, s } = useSessionTokens()
  const host = useHost()
  const insets = useSafeAreaInsets()
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState('')
  const [replying, setReplying] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const connected = host.state.kind === 'connected'

  useEffect(() => {
    if (!props.visible) {
      setReplying(null)
      setReply('')
    }
  }, [props.visible])

  const threads = props.threads
  const open = useMemo(() => threads?.filter((t) => t.resolvedAt === null) ?? [], [threads])
  const resolved = useMemo(() => threads?.filter((t) => t.resolvedAt !== null) ?? [], [threads])
  const shown = showResolved ? resolved : open

  const author = (session: string | null) =>
    session === null ? '你' : sessionTitle(host.sessions.get(session))

  const run = async (task: () => Promise<unknown>, failed: string) => {
    if (!host.link || busy) return false
    setBusy(true)
    try {
      const thread = (await task()) as CommentThread
      props.onChanged(thread)
      haptic.success()
      return true
    } catch (failure) {
      haptic.warning()
      Alert.alert(failed, errorText(failure))
      return false
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const body = draft.trim()
    if (!body) return
    const ok = await run(
      () =>
        host.link!.request('artifacts.comment', {
          id: props.artifactId,
          anchor: props.target.anchor,
          body,
        }),
      '没能发表评论',
    )
    if (ok) {
      setDraft('')
      props.onClearPick()
      setShowResolved(false)
    }
  }

  const sendReply = async (thread: CommentThread) => {
    const body = reply.trim()
    if (!body) return
    const ok = await run(
      () =>
        host.link!.request('artifacts.reply', { id: props.artifactId, threadId: thread.id, body }),
      '没能回复',
    )
    if (ok) {
      setReply('')
      setReplying(null)
    }
  }

  const resolve = (thread: CommentThread) =>
    void run(
      () =>
        host.link!.request('artifacts.resolve', {
          id: props.artifactId,
          threadId: thread.id,
          resolved: thread.resolvedAt === null,
        }),
      thread.resolvedAt === null ? '没能标为已解决' : '没能重新打开',
    )

  const tab = (label: string, on: boolean, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={[styles.tab, on ? { backgroundColor: c.fillStrong } : null]}
    >
      <Text style={[styles.tabText, { color: on ? c.text : c.textSecondary }]}>{label}</Text>
    </Pressable>
  )

  let list
  if (!threads) {
    list = props.error ? (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: c.danger }]}>没能读到评论：{props.error}</Text>
        <PressScale
          onPress={props.onRetry}
          style={[styles.retry, { backgroundColor: c.fillStrong }]}
        >
          <Text style={{ color: c.text, fontWeight: '600' }}>重试</Text>
        </PressScale>
      </View>
    ) : (
      <View style={styles.empty}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    )
  } else if (shown.length === 0) {
    list = (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: c.textSecondary }]}>
          {showResolved ? '没有已解决的评论。' : '还没有评论。写下你的想法，Agent 下次会看到。'}
        </Text>
      </View>
    )
  } else {
    list = shown.map((thread) => {
      const number = open.indexOf(thread) + 1
      return (
        <View
          key={thread.id}
          style={[styles.thread, { backgroundColor: s.dockCard, borderColor: c.border }]}
        >
          <View style={styles.threadHead}>
            {thread.resolvedAt === null ? (
              <View
                style={[
                  styles.badge,
                  { backgroundColor: isAnswered(thread) ? c.textTertiary : c.accent },
                ]}
              >
                <Text style={[styles.badgeText, { color: c.onAccent }]}>{number}</Text>
              </View>
            ) : (
              <Icon icon={G.done} size={16} color={c.success} />
            )}
            <Text style={[styles.anchor, { color: c.textSecondary }]} numberOfLines={2}>
              {anchorLabel(thread.anchor)}
              {thread.anchor.missing ? '（元素已不在）' : ''}
            </Text>
          </View>
          {thread.comments.map((comment, i) => (
            <View key={i} style={styles.comment}>
              <Text style={[styles.meta, { color: c.textTertiary }]}>
                {author(comment.author.session)} · {momentText(comment.createdAt)}
              </Text>
              <Text style={[styles.body, { color: c.text }]} selectable>
                {comment.body}
              </Text>
            </View>
          ))}
          {thread.sentAt !== null && (
            <Text style={[styles.meta, { color: c.textTertiary }]}>
              已发给 {thread.sentTo ? sessionTitle(host.sessions.get(thread.sentTo)) : '会话'}
            </Text>
          )}
          {replying === thread.id ? (
            <View style={styles.replyRow}>
              <TextInput
                value={reply}
                onChangeText={setReply}
                autoFocus
                multiline
                maxLength={COMMENT_CHARS}
                placeholder="回复…"
                placeholderTextColor={c.textTertiary}
                style={[styles.input, { color: c.text, backgroundColor: c.fill }]}
              />
              <RoundButton
                tone="accent"
                size={36}
                disabled={!reply.trim() || busy || !connected}
                onPress={() => void sendReply(thread)}
                accessibilityLabel="发送回复"
              >
                <Icon icon={G.send} size={16} color={c.onAccent} weight="bold" />
              </RoundButton>
            </View>
          ) : (
            <View style={styles.actions}>
              <Pressable
                onPress={() => {
                  setReplying(thread.id)
                  setReply('')
                }}
                disabled={!connected}
                hitSlop={8}
              >
                <Text style={[styles.action, { color: connected ? c.tint : c.textTertiary }]}>
                  回复
                </Text>
              </Pressable>
              <Pressable onPress={() => resolve(thread)} disabled={!connected || busy} hitSlop={8}>
                <Text style={[styles.action, { color: connected ? c.tint : c.textTertiary }]}>
                  {thread.resolvedAt === null ? '标为已解决' : '重新打开'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )
    })
  }

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        style={[styles.fill, { backgroundColor: c.bg }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.head, { paddingTop: Platform.OS === 'ios' ? 14 : insets.top + 8 }]}>
          <Text style={[styles.title, { color: c.text }]}>评论</Text>
          <RoundButton onPress={props.onClose} size={34} accessibilityLabel="关闭">
            <Icon icon={G.close} size={15} color={c.text} weight="semibold" />
          </RoundButton>
        </View>
        <View style={[styles.tabs, { backgroundColor: c.fill }]} accessibilityRole="tablist">
          {tab(`未解决 ${open.length}`, !showResolved, () => setShowResolved(false))}
          {tab(`已解决 ${resolved.length}`, showResolved, () => setShowResolved(true))}
        </View>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {list}
        </ScrollView>
        <View
          style={[
            styles.composer,
            { borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, 12) },
          ]}
        >
          <View style={styles.targetRow}>
            <Text style={[styles.meta, styles.fill, { color: c.textSecondary }]} numberOfLines={1}>
              评论在：{anchorLabel(props.target.anchor)}
            </Text>
            {props.target.picked ? (
              <Pressable onPress={props.onClearPick} hitSlop={8}>
                <Text style={[styles.action, { color: c.tint }]}>改为整页</Text>
              </Pressable>
            ) : props.onPickElement ? (
              <Pressable onPress={props.onPickElement} hitSlop={8} disabled={!connected}>
                <Text style={[styles.action, { color: c.tint }]}>点选页面元素</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.replyRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={COMMENT_CHARS}
              placeholder={connected ? '写评论…' : '连上电脑后才能评论'}
              editable={connected}
              placeholderTextColor={c.textTertiary}
              style={[styles.input, { color: c.text, backgroundColor: c.fill }]}
            />
            <RoundButton
              tone="accent"
              size={38}
              disabled={!draft.trim() || busy || !connected}
              onPress={() => void send()}
              accessibilityLabel="发表评论"
            >
              {busy ? (
                <ActivityIndicator color={c.onAccent} />
              ) : (
                <Icon icon={G.send} size={17} color={c.onAccent} weight="bold" />
              )}
            </RoundButton>
          </View>
        </View>
      </KeyboardAvoidingView>
      <LockLayer />
    </Modal>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  title: { fontSize: 20, fontWeight: '700' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, borderRadius: 10, padding: 3 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  tabText: { fontSize: 14, fontWeight: '600' },
  list: { padding: 16, gap: 12 },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  emptyText: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  retry: { borderRadius: 999, paddingHorizontal: 20, height: 36, justifyContent: 'center' },
  thread: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  anchor: { flex: 1, fontSize: 13 },
  comment: { gap: 2 },
  meta: { fontSize: 12.5 },
  body: { fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 20 },
  action: { fontSize: 14, fontWeight: '600' },
  replyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    borderRadius: 19,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 15,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 8,
  },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
})

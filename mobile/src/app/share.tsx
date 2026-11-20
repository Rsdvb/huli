// The share sheet: what another app shared to Huli, a line to go with it if the user wants, and
// where it goes, a recent session or a new one. Photos and files take the composer's path
// (prepare, then attachments.add); the message goes with them by sessions.queue, or by
// sessions.create for a new session, which then opens. Out of the computer's reach it says so,
// with a retry, and can leave the message in the outbox (outbox.ts) to go once the computer is back.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Image } from 'expo-image'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { UserContent } from '@shared/thread'
import {
  ATTACHMENT_LIMIT,
  isPhoto,
  messageContent,
  prepare,
  preparedSize,
  sendBlock,
  tooLarge,
  upload,
  type PendingAttachment,
  type PickedSource,
} from '../attachments'
import { useComputerId, useHost } from '../host'
import { LockLayer } from '../lock'
import { keepFile, queueMessage, type NewSessionPlan, type OutboxAttachment } from '../outbox'
import { computerName } from '../store'
import { errorText, folder, listTime, sessionTitle } from '../sessions'
import { discardShared, loadShared, type SharedBundle, type SharedItem } from '../share/inbox'
import { haptic } from '../ui/session/feedback'
import { GlassHeader } from '../ui/session/GlassHeader'
import { AgentMark, FileMark, G, Icon, TOOL_ICONS } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'

const NEW = '__new'
const MAX_ROWS = 30
const HINT_SLOP = { top: 14, bottom: 14, left: 10, right: 10 }

type FileItem = Extract<SharedItem, { kind: 'image' | 'file' }>

const isFile = (item: SharedItem): item is FileItem => item.kind === 'image' || item.kind === 'file'

/** The shared text and links, after the user's own line. */
function messageOf(typed: string, items: SharedItem[]): string {
  const shared = items.flatMap((item) =>
    item.kind === 'text' ? [item.text.trim()] : item.kind === 'url' ? [item.url] : [],
  )
  return [typed.trim(), ...shared].filter(Boolean).join('\n\n')
}

/** A shared file as the composer would have picked it: a photo scaled and re-encoded, a GIF not. */
function sourceOf(item: FileItem): PickedSource {
  const photo = item.kind === 'image' && isPhoto(item.mimeType)
  return {
    kind: photo ? 'image' : 'file',
    uri: item.uri,
    name: item.name,
    mimeType: item.mimeType,
    size: photo ? null : item.size,
  }
}

/**
 * Keeps the shared files on the phone and the message in the outbox, to go to the computer once it
 * is reachable, as a message written while it was away does.
 */
async function keep(
  computer: string,
  items: SharedItem[],
  text: string,
  target: { sessionId: string } | { create: NewSessionPlan },
): Promise<void> {
  const attachments: OutboxAttachment[] = []
  for (const item of items.filter(isFile).slice(0, ATTACHMENT_LIMIT)) {
    const source = sourceOf(item)
    const refused = tooLarge(source.name, source.size)
    if (refused) throw new Error(refused)
    const prepared = await prepare(source)
    const { body } = prepared
    const kept = await keepFile(
      computer,
      body instanceof Uint8Array ? body : { uri: body.uri },
      prepared.name,
    )
    attachments.push({
      kind: 'file',
      file: kept.file,
      name: prepared.name,
      mimeType: prepared.mimeType,
      thumb: prepared.thumb,
      size: preparedSize(prepared),
    })
  }
  if (!text && attachments.length === 0) throw new Error('没有可以发送的内容。')
  queueMessage(computer, target, { text, attachments })
}

/** Uploads the files one at a time, as the composer does, and sends the message with them. */
async function send(
  link: HostLink,
  items: SharedItem[],
  text: string,
  target: { sessionId: string } | { agentId: string; projectPath: string | null },
  progress: (line: string) => void,
): Promise<string> {
  const files = items.filter(isFile).slice(0, ATTACHMENT_LIMIT)
  const ready: PendingAttachment[] = []
  try {
    for (const [index, item] of files.entries()) {
      const which = files.length > 1 ? ` ${index + 1}/${files.length}` : ''
      progress(`正在上传${which}…`)
      const source = sourceOf(item)
      const refused = tooLarge(source.name, source.size)
      if (refused) throw new Error(refused)
      const prepared = await prepare(source)
      const size = preparedSize(prepared)
      let shown = -1
      const attachment = await upload(link, prepared, {
        // A file read from disk as it goes says how far it got, a whole percent at a time.
        progress: (sent) => {
          const percent = Math.floor((sent / size) * 100)
          if (percent === shown) return
          shown = percent
          progress(`正在上传${which} ${percent}%…`)
        },
      })
      ready.push({
        key: attachment.id,
        source,
        status: 'ready',
        thumb: prepared.thumb,
        size,
        attachment,
        error: null,
      })
    }
    const blocked = sendBlock(ready, text)
    if (blocked) throw new Error(blocked)
    progress('正在发送…')
    const content: UserContent[] = messageContent(text, ready)
    if ('sessionId' in target) {
      await link.request('sessions.queue', { sessionId: target.sessionId, content })
      return target.sessionId
    }
    const summary = (await link.request('sessions.create', {
      agentId: target.agentId,
      projectPath: target.projectPath,
      ...(content.length > 0 ? { prompt: content } : {}),
    })) as SessionSummary
    return summary.id
  } catch (error) {
    for (const item of ready) {
      void link.request('attachments.remove', { id: item.attachment!.id }).catch(() => {})
    }
    throw error
  }
}

export default function Share() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const host = useHost()
  const { c, s } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const [bundle, setBundle] = useState<SharedBundle | null | undefined>(undefined)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setBundle(undefined)
    if (!id) {
      setBundle(null)
      return
    }
    void loadShared(id).then((loaded) => {
      if (live) setBundle(loaded)
    })
    return () => {
      live = false
    }
  }, [id])

  const sessions = useMemo(
    () =>
      [...host.sessions.values()]
        .filter((session) => session.parentId === null && session.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [host.sessions],
  )
  // A session's project by the computer's name for it, its folder's otherwise.
  const projectNames = useMemo(
    () => new Map(host.projects.map((p) => [p.path, p.name])),
    [host.projects],
  )
  const placeOf = useCallback(
    (session: SessionSummary) =>
      session.scratch
        ? '无项目'
        : (projectNames.get(session.projectPath) ?? folder(session.projectPath)),
    [projectNames],
  )
  const words = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (words
        ? sessions.filter(
            (session) =>
              sessionTitle(session).toLowerCase().includes(words) ||
              placeOf(session).toLowerCase().includes(words),
          )
        : sessions
      ).slice(0, MAX_ROWS),
    [sessions, words, placeOf],
  )
  const agent = useMemo(() => {
    const usable = [...host.agents.values()].filter(
      (a) => !a.hidden && !a.disabled && !a.uninstalled && a.registered !== false,
    )
    return usable.find((a) => a.isDefault) ?? usable[0] ?? null
  }, [host.agents])
  const project = useMemo(
    () =>
      host.projects.filter((p) => !p.missing).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ??
      null,
    [host.projects],
  )

  const computer = useComputerId()
  const connected = host.state.kind === 'connected'
  const sending = progress !== null
  // Away from the computer, the message can wait in the outbox instead; a new session needs an
  // agent to start with, known from the cache.
  const canKeep = !connected && !!computer && (target !== NEW || !!agent)
  const canSend = Boolean(bundle && target && !sending && (connected ? host.link : canKeep))

  const keepForLater = async () => {
    if (!bundle || !target || !computer) return
    const chosen =
      target === NEW
        ? agent
          ? { create: { agentId: agent.id, projectPath: project?.path ?? null } }
          : null
        : { sessionId: target }
    if (!chosen) return
    haptic.pick()
    setProgress('正在保存…')
    try {
      await keep(computer, bundle.items, messageOf(typed, bundle.items), chosen)
      discardShared(bundle.id)
      haptic.success()
      // A session's message waits at its end; a new session waits as a card on New session.
      if ('sessionId' in chosen) {
        router.replace({ pathname: '/session/[id]', params: { id: chosen.sessionId } })
      } else {
        router.replace('/new')
      }
    } catch (error) {
      Alert.alert('没能保存', errorText(error))
    } finally {
      setProgress(null)
    }
  }

  const submit = async () => {
    const link = host.link
    if (!connected) return keepForLater()
    if (!bundle || !link || !target) return
    const chosen =
      target === NEW
        ? agent
          ? { agentId: agent.id, projectPath: project?.path ?? null }
          : null
        : { sessionId: target }
    if (!chosen) return
    haptic.pick()
    try {
      const sessionId = await send(
        link,
        bundle.items,
        messageOf(typed, bundle.items),
        chosen,
        (line) => setProgress(line),
      )
      discardShared(bundle.id)
      haptic.success()
      router.replace({ pathname: '/session/[id]', params: { id: sessionId } })
    } catch (error) {
      Alert.alert('没有发出去', errorText(error))
    } finally {
      setProgress(null)
    }
  }

  const header = <GlassHeader modal title="分享到纸鸢" />

  if (host.phase === 'loading' || bundle === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ headerShown: false }} />
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={c.textSecondary} />
        </View>
        <LockLayer />
      </View>
    )
  }

  if (host.phase === 'pair' || bundle === null) {
    const [title, detail] =
      host.phase === 'pair'
        ? ['还没有配对电脑', '先在纸鸢里配对电脑，再来分享。']
        : ['没有找到要分享的内容', '可能已经发出去了，或者已经过期。请重新分享一次。']
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ headerShown: false }} />
        {header}
        <View style={[styles.center, { paddingHorizontal: 32 }]}>
          <Text style={[styles.emptyTitle, { color: c.text }]}>{title}</Text>
          <Text style={[styles.emptyDetail, { color: c.textSecondary }]}>{detail}</Text>
        </View>
        <LockLayer />
      </View>
    )
  }

  const rows: { key: string; title: string; detail: string; session?: SessionSummary }[] = [
    ...(agent && !words
      ? [
          {
            key: NEW,
            title: '新会话',
            detail: `用 ${agent.name}，在${project ? ` ${project.name} ` : '临时文件夹'}里`,
          },
        ]
      : []),
    ...shown.map((session) => ({
      key: session.id,
      title: sessionTitle(session),
      detail: `${placeOf(session)} · ${listTime(session.updatedAt)}`,
      session,
    })),
  ]

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.bleed}
            contentContainerStyle={styles.items}
          >
            {bundle.items.map((item, index) => (
              <SharedPreview key={index} item={item} />
            ))}
          </ScrollView>

          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder="附一句话（可以不写）"
            placeholderTextColor={c.textTertiary}
            selectionColor={c.accent}
            multiline
            editable={!sending}
            style={[
              styles.message,
              { color: c.text, backgroundColor: s.dockCard, borderColor: c.border },
            ]}
          />

          <Text style={[styles.label, { color: c.textSecondary }]}>发到</Text>
          <View style={[styles.search, { backgroundColor: c.fill, borderColor: c.border }]}>
            <Icon icon={TOOL_ICONS.search} size={15} color={c.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索会话"
              placeholderTextColor={c.textTertiary}
              selectionColor={c.accent}
              autoCorrect={false}
              returnKeyType="search"
              style={[styles.searchInput, { color: c.text }]}
            />
          </View>
          <View style={[styles.group, { backgroundColor: s.dockCard, borderColor: c.border }]}>
            {rows.length === 0 ? (
              <Text style={[styles.none, { color: c.textTertiary }]}>
                {words ? '没有找到这个会话' : '还没有会话'}
              </Text>
            ) : (
              rows.map((row, index) => {
                const on = row.key === target
                return (
                  <Pressable
                    key={row.key}
                    disabled={sending}
                    onPress={() => {
                      haptic.pick()
                      setTarget(row.key)
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && { backgroundColor: c.fill },
                      index > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: c.border,
                      },
                    ]}
                  >
                    {row.key === NEW ? (
                      <Icon icon={G.plus} size={17} color={c.tint} />
                    ) : (
                      <AgentMark
                        harness={host.agents.get(row.session!.agentId)?.harnessId}
                        size={17}
                      />
                    )}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.rowTitle, { color: c.text }]} numberOfLines={1}>
                        {row.title}
                      </Text>
                      <Text style={[styles.rowDetail, { color: c.textTertiary }]} numberOfLines={1}>
                        {row.detail}
                      </Text>
                    </View>
                    {on && <Icon icon={G.copied} size={16} color={c.accent} weight="semibold" />}
                  </Pressable>
                )
              })
            )}
          </View>
        </ScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: c.border },
          ]}
        >
          {!connected ? (
            <View style={styles.away}>
              <Text style={[styles.hint, { color: c.textTertiary }]}>
                {host.unreachable
                  ? `连不上「${computerName(host.host)}」，可以先存着，连上后自动发出`
                  : '正在连接电脑…'}
              </Text>
              {host.unreachable && host.state.kind !== 'stopped' ? (
                <Pressable
                  onPress={() => {
                    haptic.pick()
                    host.retry()
                  }}
                  hitSlop={HINT_SLOP}
                  accessibilityRole="button"
                  accessibilityLabel="重试连接"
                >
                  <Text style={[styles.hint, styles.retry, { color: c.accent }]}>重试</Text>
                </Pressable>
              ) : null}
            </View>
          ) : !target ? (
            <Text style={[styles.hint, { color: c.textTertiary }]}>选一个会话，或者新会话</Text>
          ) : null}
          <PressScale
            scale={0.97}
            disabled={!canSend}
            onPress={() => void submit()}
            accessibilityRole="button"
            style={[
              styles.send,
              { backgroundColor: c.accent, opacity: canSend || sending ? 1 : 0.45 },
            ]}
          >
            {sending ? <ActivityIndicator color={c.onAccent} /> : null}
            <Text style={[styles.sendText, { color: c.onAccent }]}>
              {progress ?? (connected ? '发送' : '连上后发送')}
            </Text>
          </PressScale>
        </View>
      </KeyboardAvoidingView>
      <LockLayer />
    </View>
  )
}

function SharedPreview(props: { item: SharedItem }) {
  const { c, s } = useSessionTokens()
  const { item } = props
  const card = [styles.preview, { backgroundColor: s.dockCard, borderColor: c.border }]
  switch (item.kind) {
    case 'image':
      return (
        <View style={card}>
          <Image
            source={{ uri: item.uri }}
            style={styles.image}
            contentFit="cover"
            cachePolicy="memory"
          />
        </View>
      )
    case 'file':
      return (
        <View style={[card, styles.padded]}>
          <FileMark path={item.name} size={26} />
          <Text style={[styles.previewText, { color: c.text }]} numberOfLines={2}>
            {item.name}
          </Text>
        </View>
      )
    case 'url':
      return (
        <View style={[card, styles.padded]}>
          <Icon icon={G.link} size={20} color={c.tint} />
          <Text style={[styles.previewText, { color: c.text }]} numberOfLines={3}>
            {item.url}
          </Text>
        </View>
      )
    case 'text':
      return (
        <View style={[card, styles.padded, styles.wide]}>
          <Text style={[styles.previewText, { color: c.text }]} numberOfLines={5}>
            {item.text}
          </Text>
        </View>
      )
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  emptyDetail: { fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  bleed: { marginHorizontal: -16, marginTop: 12 },
  items: { gap: 10, paddingHorizontal: 16 },
  preview: {
    width: 104,
    height: 104,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  padded: { padding: 10, gap: 8 },
  wide: { width: 200 },
  image: { width: '100%', height: '100%' },
  previewText: { fontSize: 12, lineHeight: 16 },
  message: {
    marginTop: 14,
    minHeight: 72,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  label: { fontSize: 13, fontWeight: '600', marginTop: 18, marginBottom: 8, marginLeft: 4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    height: 38,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  group: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  none: { fontSize: 14, padding: 16, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    minHeight: 56,
  },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  rowDetail: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  hint: { fontSize: 13, textAlign: 'center', flexShrink: 1 },
  away: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  retry: { fontWeight: '600' },
  send: {
    height: 48,
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { fontSize: 16, fontWeight: '600' },
})

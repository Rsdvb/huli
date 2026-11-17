// The message box of a session and of a new one: a rounded card with the text, which the
// keyboard's dictation fills too, and a row of controls under it; photos and files are uploaded
// as each is added so the message itself goes at once. While a turn runs, a round stop button
// sits at the row's end, and once there is something to send, a button that queues it beside it.
// The screen opens the add menu and reaches the box through its handle: to pick, to mention a
// project's file and to put a slash command in.

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import type { UserContent } from '@shared/thread'
import {
  ATTACHMENT_LIMIT,
  attachProjectFile,
  formatBytes,
  isPhoto,
  messageContent,
  prepare,
  sendBlock,
  tooLarge,
  upload,
  type PendingAttachment,
  type PickedSource,
} from '../attachments'
import { useHost, useLink } from '../host'
import { haptic, showMenu } from '../ui/session/feedback'
import { extensionOf } from '../ui/session/format'
import { FileMark, G, Icon } from '../ui/session/icons'
import { useKeyboardShown } from '../ui/session/keyboard'
import { useSessionTokens } from '../ui/session/palette'
import type { ViewHandle } from '../ui/session/Popover'
import { PressScale, RoundButton } from '../ui/session/Press'

export interface ComposerProps {
  placeholder: string
  /** Sends the message; the composer empties once it resolves. */
  onSend(content: UserContent[]): Promise<unknown>
  /** The alert's title when sending fails. */
  failTitle: string
  /** Whether a message without text or attachments may go, as a new session's may. */
  allowEmpty?: boolean
  disabled?: boolean
  bottomInset: number
  /** A turn runs: an empty box offers to stop it. */
  running?: boolean
  onStop?: () => void
  /** Controls after the attach button, such as the permission mode. */
  left?: ReactNode
  /** Controls before the send button, such as the model. */
  right?: ReactNode
  /** Under the card: the status line. */
  footer?: ReactNode
  autoFocus?: boolean
  /** Opens the screen's add menu from the add button; without it the system's menu opens. */
  onAttach?: (anchor: RefObject<ViewHandle | null>) => void
  ref?: Ref<ComposerHandle>
}

export interface ComposerHandle {
  pickPhotos(): void
  takePhoto(): void
  pickFiles(): void
  /** Mentions a file of the project: `@name` at the caret, and the file attached. */
  mention(projectPath: string, path: string): void
  /** Puts `/name ` at the start of the text, in place of a command already there. */
  command(name: string, names: readonly string[]): void
  focus(): void
}

let nextKey = 1

/** The text with `/name ` in front, any command that led it before taken out. */
function withCommand(text: string, name: string, names: readonly string[]): string {
  const led = /^\/(\S+)(?=[ \n]|$)/.exec(text)
  const rest = led && names.includes(led[1]!) ? text.slice(led[0].length).replace(/^ /, '') : text
  return `/${name} ${rest.trimStart()}`
}

export function Composer(props: ComposerProps) {
  const { placeholder, onSend, failTitle, allowEmpty = false, disabled = false } = props
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const keyboard = useKeyboardShown()
  const [text, setText] = useState('')
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [sending, setSending] = useState(false)
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const attachAnchor = useRef<ViewHandle>(null)
  const caret = useRef<number | null>(null)
  const latestText = useRef('')
  latestText.current = text
  const latest = useRef<PendingAttachment[]>([])
  const mounted = useRef(true)
  /** The keys of attachments a message is carrying, which leaving the screen must not remove. */
  const carried = useRef(new Set<string>())
  // One at a time, so a photo is read and scaled while nothing else holds its memory.
  const queue = useRef<Promise<void>>(Promise.resolve())

  const forget = (id: string) => {
    void link.request('attachments.remove', { id }).catch(() => {})
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const item of latest.current) {
        if (item.attachment && !carried.current.has(item.key)) forget(item.attachment.id)
      }
      latest.current = []
    }
  }, [])

  /** Changes the list here at once, for the uploads to read, and in the state alike. */
  const change = (next: (list: PendingAttachment[]) => PendingAttachment[]) => {
    latest.current = next(latest.current)
    setItems(next)
  }

  const held = (key: string) => mounted.current && latest.current.some((item) => item.key === key)

  const patch = (key: string, changes: Partial<PendingAttachment>) => {
    change((list) => list.map((item) => (item.key === key ? { ...item, ...changes } : item)))
  }

  const run = async (key: string, source: PickedSource) => {
    if (!held(key)) return
    patch(key, { status: 'preparing', error: null })
    try {
      if (source.kind === 'project') {
        patch(key, { status: 'uploading' })
        const attachment = await attachProjectFile(link, source.projectPath ?? '', source.uri)
        if (!held(key)) return forget(attachment.id)
        patch(key, { status: 'ready', attachment, size: attachment.size, thumb: attachment.thumb })
        return
      }
      const prepared = await prepare(source)
      if (!held(key)) return
      patch(key, { status: 'uploading', thumb: prepared.thumb, size: prepared.bytes.byteLength })
      const attachment = await upload(link, prepared)
      // Removed while it went: the host's record goes too.
      if (!held(key)) return forget(attachment.id)
      patch(key, { status: 'ready', attachment })
    } catch (error) {
      if (held(key)) patch(key, { status: 'failed', error: (error as Error).message })
    }
  }

  const enqueue = (key: string, source: PickedSource) => {
    queue.current = queue.current.then(() => run(key, source))
  }

  const add = (sources: PickedSource[]) => {
    const room = ATTACHMENT_LIMIT - latest.current.length
    const refused = sources.flatMap((source) => tooLarge(source.name, source.size) ?? [])
    const fitting = sources.filter((source) => !tooLarge(source.name, source.size))
    if (refused.length > 0) Alert.alert('文件太大', refused.join('\n'))
    if (fitting.length > room) {
      Alert.alert('附件太多', `一条消息最多带 ${ATTACHMENT_LIMIT} 个附件。`)
    }
    const added = fitting.slice(0, Math.max(0, room)).map((source): PendingAttachment => ({
      key: `a${nextKey++}`,
      source,
      status: 'waiting',
      thumb: null,
      size: source.size,
      attachment: null,
      error: null,
    }))
    if (added.length === 0) return
    change((list) => [...list, ...added])
    for (const item of added) enqueue(item.key, item.source)
  }

  const remove = (key: string) => {
    const item = latest.current.find((each) => each.key === key)
    change((list) => list.filter((each) => each.key !== key))
    if (item?.attachment) forget(item.attachment.id)
  }

  const retry = (key: string) => {
    const item = latest.current.find((each) => each.key === key)
    if (!item) return
    patch(key, { status: 'waiting', error: null })
    enqueue(key, item.source)
  }

  const pressItem = (item: PendingAttachment) => {
    if (item.status !== 'failed') return
    Alert.alert('附件没传上去', item.error ?? '', [
      { text: '移除', style: 'destructive', onPress: () => remove(item.key) },
      { text: '重试', onPress: () => retry(item.key) },
      { text: '取消', style: 'cancel' },
    ])
  }

  const room = () => {
    const left = ATTACHMENT_LIMIT - latest.current.length
    if (left <= 0) Alert.alert('附件太多', `一条消息最多带 ${ATTACHMENT_LIMIT} 个附件。`)
    return left
  }

  const photoSources = (assets: ImagePicker.ImagePickerAsset[]): PickedSource[] =>
    assets.map((asset, index) => {
      const name = asset.fileName || `图片 ${latest.current.length + index + 1}.jpg`
      // An animated GIF keeps its frames; any other picture is scaled and re-encoded.
      const photo = asset.mimeType ? isPhoto(asset.mimeType) : true
      return {
        kind: photo ? 'image' : 'file',
        uri: asset.uri,
        name,
        mimeType: asset.mimeType ?? null,
        size: photo ? null : (asset.fileSize ?? null),
      }
    })

  const takePhoto = async () => {
    if (room() <= 0) return
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) {
      Alert.alert('不能使用相机', '请在系统设置里允许 Huli 使用相机。', [
        { text: '取消', style: 'cancel' },
        { text: '去设置', onPress: () => void Linking.openSettings() },
      ])
      return
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 1 })
    if (!result.canceled) add(photoSources(result.assets))
  }

  const pickPhotos = async () => {
    const left = room()
    if (left <= 0) return
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: true,
      selectionLimit: left,
      quality: 1,
    })
    if (!result.canceled) add(photoSources(result.assets))
  }

  const pickFiles = async () => {
    if (room() <= 0) return
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    })
    if (result.canceled) return
    add(
      result.assets.map((asset) => {
        const photo = isPhoto(asset.mimeType)
        return {
          kind: photo ? 'image' : 'file',
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? null,
          size: photo ? null : (asset.size ?? null),
        }
      }),
    )
  }

  const choose = (action: () => Promise<void>) => {
    action().catch((error: unknown) => {
      console.warn('Could not pick an attachment', error)
      Alert.alert('没能打开', '请稍后再试。')
    })
  }

  const mention = (projectPath: string, path: string) => {
    if (room() <= 0) return
    const name = path.slice(path.lastIndexOf('/') + 1)
    const current = latestText.current
    const at = caret.current ?? current.length
    const before = current.slice(0, at)
    const lead = before === '' || /\s$/.test(before) ? '' : ' '
    const after = current.slice(at)
    const typed = `${lead}@${name}${after.startsWith(' ') ? '' : ' '}`
    setText(`${before}${typed}${after}`)
    caret.current = at + typed.length
    add([{ kind: 'project', uri: path, name, mimeType: null, size: null, projectPath }])
  }

  useImperativeHandle(props.ref, () => ({
    pickPhotos: () => choose(pickPhotos),
    takePhoto: () => choose(takePhoto),
    pickFiles: () => choose(pickFiles),
    mention,
    command: (name, names) => {
      setText((current) => withCommand(current, name, names))
      setTimeout(() => input.current?.focus(), 50)
    },
    focus: () => input.current?.focus(),
  }))

  const openMenu = () => {
    if (props.onAttach) return props.onAttach(attachAnchor)
    showMenu('添加附件', [
      { label: '拍照', onPress: () => choose(takePhoto) },
      { label: '从相册选', onPress: () => choose(pickPhotos) },
      { label: '选文件', onPress: () => choose(pickFiles) },
    ])
  }

  const connected = host.state.kind === 'connected'
  const busy = items.filter((item) => item.status !== 'ready' && item.status !== 'failed')
  const block = sendBlock(items, text)
  const empty = !text.trim() && items.length === 0
  const canSend =
    connected && !sending && !disabled && busy.length === 0 && !block && (allowEmpty || !empty)
  const stoppable = !!props.running && !!props.onStop

  const send = async () => {
    if (!canSend) return
    haptic.tap()
    const sent = latest.current
    const content = messageContent(text, sent)
    for (const item of sent) carried.current.add(item.key)
    setSending(true)
    try {
      await onSend(content)
      if (!mounted.current) return
      setText('')
      change((list) => list.filter((item) => !carried.current.has(item.key)))
    } catch (error) {
      for (const item of sent) carried.current.delete(item.key)
      Alert.alert(failTitle, (error as { message?: string }).message || '请稍后再试。')
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  // Offline the screen may show the cache's copy of the conversation; nothing goes until connected.
  const status = !connected
    ? host.state.kind === 'connecting'
      ? '正在连接电脑…连上后才能发送。'
      : host.state.kind === 'reconnecting'
        ? '和电脑的连接断了，正在重连。连上后才能发送。'
        : '没有连上电脑，暂时不能发送。'
    : busy.length > 0
      ? `正在处理附件，还剩 ${busy.length} 个…`
      : block

  return (
    <View style={[styles.outer, { paddingBottom: keyboard ? 8 : Math.max(props.bottomInset, 8) }]}>
      <View style={[styles.tray, { backgroundColor: s.dock, borderColor: c.border }]}>
        <View style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.border }]}>
          {items.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tiles}
              keyboardShouldPersistTaps="handled"
            >
              {items.map((item) => (
                <Tile
                  key={item.key}
                  item={item}
                  onPress={() => pressItem(item)}
                  onRemove={() => remove(item.key)}
                />
              ))}
            </ScrollView>
          )}
          {status ? (
            <Text
              style={[styles.status, { color: status === block ? c.danger : c.textSecondary }]}
              numberOfLines={2}
            >
              {status}
            </Text>
          ) : null}
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            onSelectionChange={(event) => {
              caret.current = event.nativeEvent.selection.end
            }}
            accessibilityLabel="消息"
            placeholder={placeholder}
            placeholderTextColor={c.textTertiary}
            selectionColor={c.accent}
            cursorColor={c.accent}
            multiline
            autoFocus={props.autoFocus}
            style={[styles.input, { color: c.text }]}
          />
          <View style={styles.row}>
            <View ref={attachAnchor} collapsable={false}>
              <RoundButton
                onPress={openMenu}
                disabled={sending}
                accessibilityLabel="添加照片、文件或命令"
              >
                <Icon icon={G.plus} size={19} color={c.text} weight="medium" />
              </RoundButton>
            </View>
            {props.left}
            <View style={styles.right}>{props.right}</View>
            {(!stoppable || !empty || sending) && (
              <RoundButton
                tone="accent"
                onPress={() => void send()}
                disabled={!canSend}
                accessibilityLabel={props.running ? '加入队列' : '发送'}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={c.onAccent} />
                ) : props.running ? (
                  <Icon icon={G.queue} size={18} color={c.onAccent} weight="bold" />
                ) : (
                  <Icon
                    icon={G.send}
                    size={18}
                    color={c.onAccent}
                    weight="bold"
                    strokeWidth={2.4}
                  />
                )}
              </RoundButton>
            )}
            {stoppable && (
              <RoundButton
                onPress={() => {
                  haptic.firm()
                  props.onStop!()
                }}
                accessibilityLabel="停止这一轮"
                style={{ backgroundColor: s.stop }}
              >
                <Icon icon={G.stop} size={13} color={s.onStop} weight="bold" />
              </RoundButton>
            )}
          </View>
        </View>
        {props.footer}
      </View>
    </View>
  )
}

function Tile(props: { item: PendingAttachment; onPress(): void; onRemove(): void }) {
  const { c, s } = useSessionTokens()
  const { item } = props
  const preview = item.thumb ?? (item.source.kind === 'image' ? item.source.uri : null)
  const working = item.status !== 'ready' && item.status !== 'failed'
  const label =
    item.status === 'preparing'
      ? '处理中'
      : item.status === 'waiting'
        ? '等待中'
        : item.status === 'uploading'
          ? item.size
            ? formatBytes(item.size)
            : '上传中'
          : null
  return (
    <PressScale
      scale={0.97}
      onPress={props.onPress}
      accessibilityLabel={item.source.name}
      style={[styles.tile, { borderColor: c.border, backgroundColor: c.fill }]}
    >
      {preview ? (
        <Image source={{ uri: preview }} style={styles.preview} resizeMode="cover" />
      ) : (
        <View style={styles.file}>
          <FileMark path={item.source.name} size={18} />
          <Text style={[styles.fileExt, { color: c.textSecondary }]} numberOfLines={1}>
            {extensionOf(item.source.name).toUpperCase() || '文件'}
          </Text>
          <Text style={[styles.fileName, { color: c.text }]} numberOfLines={1}>
            {item.source.name}
          </Text>
        </View>
      )}
      {working && (
        <View style={[styles.cover, { backgroundColor: s.veil }]}>
          <ActivityIndicator size="small" color={c.text} />
          {label && <Text style={[styles.coverText, { color: c.text }]}>{label}</Text>}
        </View>
      )}
      {item.status === 'failed' && (
        <View style={[styles.cover, { backgroundColor: s.dangerSoft }]}>
          <Icon icon={G.warning} size={18} color={c.danger} />
          <Text style={[styles.coverText, { color: c.danger }]}>点按查看</Text>
        </View>
      )}
      <Pressable
        onPress={props.onRemove}
        hitSlop={8}
        accessibilityLabel={`移除 ${item.source.name}`}
        style={[styles.remove, { backgroundColor: c.text, borderColor: s.dockCard }]}
      >
        <Icon icon={G.close} size={9} color={c.bg} weight="black" strokeWidth={3.2} />
      </Pressable>
    </PressScale>
  )
}

const TILE = 68

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingTop: 6 },
  tray: { borderRadius: 30, borderWidth: StyleSheet.hairlineWidth, padding: 4, paddingBottom: 6 },
  card: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    paddingBottom: 8,
  },
  tiles: { gap: 10, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  status: { fontSize: 12, lineHeight: 16, paddingHorizontal: 18, paddingTop: 6 },
  input: {
    minHeight: 48,
    maxHeight: 168,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  right: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', minWidth: 0 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 6,
  },
  preview: { width: TILE, height: TILE, borderRadius: 14 },
  file: { flex: 1, padding: 7, justifyContent: 'space-between' },
  fileExt: { fontSize: 10, fontWeight: '700' },
  fileName: { fontSize: 10 },
  cover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverText: { fontSize: 10, marginTop: 3, fontWeight: '500' },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

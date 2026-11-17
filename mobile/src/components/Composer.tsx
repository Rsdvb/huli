// The message box of a session and of a new one: text, which the keyboard's dictation fills too,
// and photos and files, each uploaded as it is added so the message itself goes at once.

import { useEffect, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
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
import { useTheme, type Theme } from '../theme'

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
}

let nextKey = 1

export function Composer(props: ComposerProps) {
  const { placeholder, onSend, failTitle, allowEmpty = false, disabled = false } = props
  const theme = useTheme()
  const host = useHost()
  const link = useLink()
  const [text, setText] = useState('')
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [sending, setSending] = useState(false)
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

  const choose = (index: number) => {
    const action = [takePhoto, pickPhotos, pickFiles][index]
    if (!action) return
    action().catch((error: unknown) => {
      console.warn('Could not pick an attachment', error)
      Alert.alert('没能打开', '请稍后再试。')
    })
  }

  const openMenu = () => {
    const options = ['拍照', '从相册选', '选文件']
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...options, '取消'], cancelButtonIndex: options.length },
        choose,
      )
    } else {
      Alert.alert(
        '添加附件',
        undefined,
        options.map((label, index) => ({ text: label, onPress: () => choose(index) })),
        { cancelable: true },
      )
    }
  }

  const connected = host.state.kind === 'connected'
  const busy = items.filter((item) => item.status !== 'ready' && item.status !== 'failed')
  const block = sendBlock(items, text)
  const empty = !text.trim() && items.length === 0
  const canSend =
    connected && !sending && !disabled && busy.length === 0 && !block && (allowEmpty || !empty)

  const send = async () => {
    if (!canSend) return
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

  const status = !connected
    ? '正在连接电脑…'
    : busy.length > 0
      ? `正在处理附件，还剩 ${busy.length} 个…`
      : block

  return (
    <View
      style={[
        styles.composer,
        { borderTopColor: theme.line, paddingBottom: Math.max(props.bottomInset, 8) },
      ]}
    >
      {items.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tray}
          keyboardShouldPersistTaps="handled"
        >
          {items.map((item) => (
            <Tile
              key={item.key}
              item={item}
              theme={theme}
              onPress={() => pressItem(item)}
              onRemove={() => remove(item.key)}
            />
          ))}
        </ScrollView>
      )}
      {status ? (
        <Text
          style={[styles.status, { color: status === block ? theme.danger : theme.muted }]}
          numberOfLines={2}
        >
          {status}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={openMenu}
          disabled={sending}
          hitSlop={6}
          accessibilityLabel="添加照片或文件"
          style={({ pressed }) => [
            styles.round,
            { borderColor: theme.line, backgroundColor: theme.card, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Text style={{ color: theme.accent, fontSize: 24, lineHeight: 26 }}>+</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.muted}
          multiline
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.line },
          ]}
        />
        <Pressable
          onPress={() => void send()}
          disabled={!canSend}
          accessibilityLabel="发送"
          style={({ pressed }) => [
            styles.round,
            {
              backgroundColor: theme.accent,
              borderColor: theme.accent,
              opacity: !canSend ? 0.4 : pressed ? 0.75 : 1,
            },
          ]}
        >
          {sending ? (
            <ActivityIndicator color={theme.accentText} />
          ) : (
            <Text style={{ color: theme.accentText, fontSize: 18, fontWeight: '700' }}>↑</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot > name.length - 7 ? name.slice(dot + 1).toUpperCase() : '文件'
}

function Tile(props: { item: PendingAttachment; theme: Theme; onPress(): void; onRemove(): void }) {
  const { item, theme } = props
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
    <Pressable
      onPress={props.onPress}
      accessibilityLabel={item.source.name}
      style={[styles.tile, { borderColor: theme.line, backgroundColor: theme.card }]}
    >
      {preview ? (
        <Image source={{ uri: preview }} style={styles.preview} resizeMode="cover" />
      ) : (
        <View style={styles.file}>
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
            {extension(item.source.name)}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 10, marginTop: 2 }} numberOfLines={2}>
            {item.source.name}
          </Text>
        </View>
      )}
      {working && (
        <View style={styles.cover}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg, opacity: 0.6 }]} />
          <ActivityIndicator color={theme.accent} />
          {label && <Text style={[styles.coverText, { color: theme.text }]}>{label}</Text>}
        </View>
      )}
      {item.status === 'failed' && (
        <View style={styles.cover}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg, opacity: 0.7 }]} />
          <Text style={{ color: theme.danger, fontSize: 20, fontWeight: '700' }}>!</Text>
          <Text style={[styles.coverText, { color: theme.danger }]}>点按查看</Text>
        </View>
      )}
      <Pressable
        onPress={props.onRemove}
        hitSlop={8}
        accessibilityLabel={`移除 ${item.source.name}`}
        style={[styles.remove, { backgroundColor: theme.text }]}
      >
        <Text style={{ color: theme.bg, fontSize: 12, fontWeight: '700', lineHeight: 14 }}>×</Text>
      </Pressable>
    </Pressable>
  )
}

const TILE = 64

const styles = StyleSheet.create({
  composer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tray: { gap: 8, paddingTop: 6, paddingRight: 6 },
  status: { fontSize: 12, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'visible',
  },
  preview: { width: TILE, height: TILE, borderRadius: 10 },
  file: { flex: 1, padding: 6, justifyContent: 'center' },
  cover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverText: { fontSize: 10, marginTop: 2 },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

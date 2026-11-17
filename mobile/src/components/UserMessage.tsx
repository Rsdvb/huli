// The user's message in a session: a soft bubble on the right with its text, and its pictures as
// thumbnails above it. A sent attachment carries its thumbnail and an inline image its bytes, so
// those show at once; a picture the host keeps only in its thread store is read with
// `sessions.blob` when it is tapped, as is the full size of any of them, since a phone should not
// download every picture it scrolls past. Holding the bubble offers to copy or select its text.

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { File, Paths } from 'expo-file-system'
import type { AttachmentBytes } from '@shared/agent-host'
import type { FromDevice, FromSession, UserContent } from '@shared/thread'
import { useLink } from '../host'
import { LockLayer } from '../lock'
import { useSessionRows } from '../ui/session/context'
import { copyText, showMenu } from '../ui/session/feedback'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'

/** A picture of the message: what shows in the bubble, and where its full size comes from. */
interface Picture {
  thumb: string | null
  full: { uri: string } | { hash: string } | null
}

function label(part: UserContent): string | null {
  if (part.type === 'text') return part.text
  const ref = part.ref
  switch (ref.kind) {
    case 'image':
      return null
    case 'attachment':
      return ref.attachment.type === 'image' && (ref.attachment.thumb || ref.attachment.blob)
        ? null
        : `［${ref.attachment.name}］`
    case 'link':
      return `［${ref.name}］`
    case 'audio':
      return '［音频］'
    case 'video':
      return '［视频］'
    default:
      return `［${ref.label}］`
  }
}

function picture(part: UserContent): Picture | null {
  if (part.type !== 'ref') return null
  const ref = part.ref
  if (ref.kind === 'image') {
    if ('data' in ref) {
      const uri = `data:${ref.mimeType};base64,${ref.data}`
      return { thumb: uri, full: { uri } }
    }
    return { thumb: null, full: { hash: ref.blob } }
  }
  if (ref.kind === 'attachment' && ref.attachment.type === 'image') {
    const { thumb, blob } = ref.attachment
    if (!thumb && !blob) return null
    return { thumb, full: blob ? { hash: blob } : thumb ? { uri: thumb } : null }
  }
  return null
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** The picture the thread store keeps under `hash`, read once and kept in the cache folder. */
async function stored(
  link: ReturnType<typeof useLink>,
  sessionId: string,
  hash: string,
): Promise<string> {
  for (const extension of Object.values(EXTENSIONS)) {
    const kept = new File(Paths.cache, `huli-${hash}.${extension}`)
    if (kept.exists) return kept.uri
  }
  const { mimeType, bytes } = (await link.request('sessions.blob', {
    sessionId,
    hash,
  })) as AttachmentBytes
  const file = new File(Paths.cache, `huli-${hash}.${EXTENSIONS[mimeType] ?? 'png'}`)
  try {
    file.create({ overwrite: true })
    await file.write(new Uint8Array(bytes))
  } catch (error) {
    if (file.exists) file.delete()
    throw error
  }
  return file.uri
}

export function UserMessage(props: {
  content: UserContent[]
  steered?: boolean
  device?: FromDevice
  from?: FromSession
}) {
  const { content } = props
  const { c, s } = useSessionTokens()
  const { selectText } = useSessionRows()
  const [open, setOpen] = useState<Picture | null>(null)
  const text = content
    .map(label)
    .filter((line): line is string => line !== null)
    .join('\n')
  const pictures = content.map(picture).filter((each): each is Picture => each !== null)
  const note = props.from
    ? `来自「${props.from.title}」`
    : props.steered
      ? '插话'
      : props.device
        ? `从 ${props.device.name} 发送`
        : null

  const menu = () =>
    showMenu(undefined, [
      { label: '复制', onPress: () => void copyText(text) },
      { label: '选择文本', onPress: () => selectText(text) },
    ])

  return (
    <View style={styles.root}>
      {pictures.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.strip}
          contentContainerStyle={styles.pictures}
        >
          {pictures.map((each, index) => {
            const side = pictures.length > 1 ? THUMB_SMALL : THUMB
            return (
              <PressScale
                key={index}
                scale={0.97}
                onPress={() => setOpen(each)}
                accessibilityRole="imagebutton"
                accessibilityLabel={pictures.length > 1 ? `查看第 ${index + 1} 张图片` : '查看图片'}
              >
                {each.thumb ? (
                  <Image
                    source={{ uri: each.thumb }}
                    style={[styles.thumb, { width: side, height: side, borderColor: c.border }]}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={[
                      styles.thumb,
                      styles.placeholder,
                      {
                        width: side,
                        height: side,
                        backgroundColor: s.bubble,
                        borderColor: c.border,
                      },
                    ]}
                  >
                    <Icon icon={G.photos} size={20} color={c.textSecondary} />
                    <Text style={{ color: c.textSecondary, fontSize: 11, marginTop: 4 }}>
                      点按查看
                    </Text>
                  </View>
                )}
              </PressScale>
            )
          })}
        </ScrollView>
      )}
      {text ? (
        <PressScale
          scale={0.98}
          onLongPress={text ? menu : undefined}
          delayLongPress={350}
          style={[styles.bubble, { backgroundColor: s.bubble }]}
        >
          <Text style={[styles.text, { color: c.text }]}>{text}</Text>
        </PressScale>
      ) : null}
      {note && <Text style={[styles.note, { color: c.textTertiary }]}>{note}</Text>}
      {open && <Viewer picture={open} onClose={() => setOpen(null)} />}
    </View>
  )
}

function Viewer(props: { picture: Picture; onClose(): void }) {
  const { picture, onClose } = props
  const { sessionId } = useSessionRows()
  const { s } = useSessionTokens()
  const link = useLink()
  const insets = useSafeAreaInsets()
  const full = picture.full
  const [uri, setUri] = useState<string | null>(full && 'uri' in full ? full.uri : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!full || !('hash' in full)) return
    let live = true
    stored(link, sessionId, full.hash).then(
      (next) => live && setUri(next),
      (failed: unknown) => {
        console.warn('Could not read a picture', failed)
        const ended = (failed as { code?: string }).code === 'host_restarted'
        if (live) setError(ended ? '和电脑的连接断开了，请稍后再试。' : '没能取到这张图片。')
      },
    )
    return () => {
      live = false
    }
  }, [full, link, sessionId])

  const shown = uri ?? picture.thumb
  const light = s.onScrim
  const window = useWindowDimensions()
  const share = async () => {
    if (!uri) return
    try {
      await Share.share({ url: await shareable(uri) })
    } catch (failed) {
      console.warn('Could not share a picture', failed)
    }
  }
  const image = shown ? (
    <Image
      source={{ uri: shown }}
      style={{ width: window.width, height: window.height }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  ) : null
  return (
    <Modal
      visible
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={['portrait']}
    >
      <View style={[styles.viewer, { backgroundColor: s.scrim }]}>
        {Platform.OS === 'ios' ? (
          // Pinching zooms in a scroll view on iOS; Android's has no zoom, so it shows the fit.
          <ScrollView
            maximumZoomScale={5}
            minimumZoomScale={1}
            centerContent
            bouncesZoom
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ flexGrow: 1 }}
          >
            <Pressable onPress={onClose} accessibilityLabel="关闭图片">
              {image}
            </Pressable>
          </ScrollView>
        ) : (
          <Pressable onPress={onClose} accessibilityLabel="关闭图片">
            {image}
          </Pressable>
        )}
        {!uri && !error && (
          <ActivityIndicator style={StyleSheet.absoluteFill} color={light} pointerEvents="none" />
        )}
        {error && (
          <Text style={[styles.error, { bottom: insets.bottom + 24, color: light }]}>{error}</Text>
        )}
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          style={[styles.close, { top: insets.top + 10, right: 16, backgroundColor: s.scrimFill }]}
        >
          <Icon icon={G.close} size={18} color={light} weight="semibold" />
        </Pressable>
        {Platform.OS === 'ios' && uri && (
          <Pressable
            onPress={() => void share()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="分享图片"
            style={[styles.close, { top: insets.top + 10, left: 16, backgroundColor: s.scrimFill }]}
          >
            <Icon icon={G.share} size={17} color={light} weight="semibold" />
          </Pressable>
        )}
      </View>
      <LockLayer />
    </Modal>
  )
}

/** A file to share: a picture held as a data URL is written to the cache first. */
async function shareable(uri: string): Promise<string> {
  const match = /^data:([^;]+);base64,(.*)$/.exec(uri)
  if (!match) return uri
  const file = new File(Paths.cache, `huli-share.${EXTENSIONS[match[1]!] ?? 'png'}`)
  const binary = atob(match[2]!)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  file.create({ overwrite: true })
  await file.write(bytes)
  return file.uri
}

const THUMB = 112
const THUMB_SMALL = 76

const styles = StyleSheet.create({
  root: { alignItems: 'flex-end', gap: 6, paddingLeft: 48 },
  strip: { flexGrow: 0, alignSelf: 'stretch', marginLeft: -48 },
  pictures: { flexDirection: 'row', gap: 8, flexGrow: 1, justifyContent: 'flex-end' },
  thumb: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  bubble: {
    borderRadius: 20,
    borderBottomRightRadius: 6,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  text: { fontSize: 16, lineHeight: 23 },
  note: { fontSize: 12, lineHeight: 16, marginRight: 4 },
  viewer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  close: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { position: 'absolute', left: 24, right: 24, textAlign: 'center' },
})

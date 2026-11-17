// The user's message in a session: its text, and its pictures as thumbnails. A sent attachment
// carries its thumbnail and an inline image its bytes, so those show at once; a picture the host
// keeps only in its thread store is read with `sessions.blob` when it is tapped, as is the full
// size of any of them, since a phone should not download every picture it scrolls past.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { File, Paths } from 'expo-file-system'
import type { AttachmentBytes } from '@shared/agent-host'
import type { UserContent } from '@shared/thread'
import { useLink } from '../host'
import type { Theme } from '../theme'

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

export function UserMessage(props: { content: UserContent[]; theme: Theme }) {
  const { content, theme } = props
  const [open, setOpen] = useState<Picture | null>(null)
  const text = content
    .map(label)
    .filter((line): line is string => line !== null)
    .join('\n')
  const pictures = content.map(picture).filter((each): each is Picture => each !== null)
  return (
    <View style={{ gap: 6 }}>
      {pictures.length > 0 && (
        <View style={styles.pictures}>
          {pictures.map((each, index) => (
            <Pressable key={index} onPress={() => setOpen(each)} accessibilityLabel="查看图片">
              {each.thumb ? (
                <Image source={{ uri: each.thumb }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.placeholder, { backgroundColor: theme.card }]}>
                  <Text style={{ color: theme.muted, fontSize: 12 }}>图片</Text>
                  <Text style={{ color: theme.muted, fontSize: 10, marginTop: 2 }}>点按查看</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      )}
      {text ? (
        <Text selectable style={{ color: theme.accentText, fontSize: 15, lineHeight: 21 }}>
          {text}
        </Text>
      ) : null}
      {open && <Viewer picture={open} onClose={() => setOpen(null)} />}
    </View>
  )
}

function Viewer(props: { picture: Picture; onClose(): void }) {
  const { picture, onClose } = props
  const { id: sessionId } = useLocalSearchParams<{ id: string }>()
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
  return (
    <Modal
      visible
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={['portrait']}
    >
      <Pressable style={styles.viewer} onPress={onClose} accessibilityLabel="关闭图片">
        {shown && <Image source={{ uri: shown }} style={styles.full} resizeMode="contain" />}
        {!uri && !error && <ActivityIndicator style={StyleSheet.absoluteFill} color="#FFFFFF" />}
        {error && <Text style={[styles.error, { bottom: insets.bottom + 24 }]}>{error}</Text>}
        <Text style={[styles.close, { top: insets.top + 12 }]}>关闭</Text>
      </Pressable>
    </Modal>
  )
}

const THUMB = 96

const styles = StyleSheet.create({
  pictures: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: THUMB, height: THUMB, borderRadius: 10 },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  viewer: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '100%' },
  close: { position: 'absolute', right: 20, color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  error: { position: 'absolute', left: 24, right: 24, color: '#FFFFFF', textAlign: 'center' },
})

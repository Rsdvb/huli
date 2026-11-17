// The pictures a conversation carries, the user's and the agent's: a thumbnail strip, and a full
// screen viewer that zooms on iOS and shares. An inline image carries its bytes and shows at once;
// a picture the host keeps only in its thread store is read with `sessions.blob` when it is tapped,
// as is the full size of an attachment, since a phone should not download every picture it
// scrolls past.

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
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
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { File, Paths } from 'expo-file-system'
import type { AttachmentBytes } from '@shared/agent-host'
import type { ContentRef } from '@shared/thread'
import { useLink } from '../host'
import { LockLayer } from '../lock'
import { cacheFor } from '../ui/memory'
import { useSessionRows } from '../ui/session/context'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'

/** A picture: what shows as its thumbnail, and where its full size comes from. */
export interface Picture {
  thumb: string | null
  full: { uri: string } | { hash: string } | null
}

/** The picture a carried reference holds, or null for anything else. */
export function pictureOf(ref: ContentRef): Picture | null {
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

const THUMB = 112
const THUMB_SMALL = 76

/** A row of thumbnails that open the viewer, on the right for the user's, the left for a reply. */
export function PictureStrip(props: { pictures: Picture[]; align: 'start' | 'end' }) {
  const { c, s } = useSessionTokens()
  const [open, setOpen] = useState<Picture | null>(null)
  const { pictures } = props
  if (pictures.length === 0) return null
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.strip}
        contentContainerStyle={[
          styles.pictures,
          { justifyContent: props.align === 'end' ? 'flex-end' : 'flex-start' },
        ]}
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
                  contentFit="cover"
                  cachePolicy={cacheFor(each.thumb)}
                  recyclingKey={each.thumb}
                  transition={120}
                />
              ) : (
                <View
                  style={[
                    styles.thumb,
                    styles.placeholder,
                    { width: side, height: side, backgroundColor: s.bubble, borderColor: c.border },
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
      {open && <PictureViewer picture={open} onClose={() => setOpen(null)} />}
    </>
  )
}

export function PictureViewer(props: { picture: Picture; onClose(): void }) {
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
      contentFit="contain"
      // The full picture is large: kept on disk only, so closing the viewer frees its memory.
      cachePolicy="disk"
      {...(picture.thumb && shown !== picture.thumb
        ? { placeholder: { uri: picture.thumb }, placeholderContentFit: 'contain' as const }
        : {})}
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

const styles = StyleSheet.create({
  strip: { flexGrow: 0, alignSelf: 'stretch' },
  pictures: { flexDirection: 'row', gap: 8, flexGrow: 1 },
  thumb: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
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

// What a message carries besides its text, as tiles that open: a file of the session's folder on
// the file screen, a folder in the file list, a pasted text in a sheet, a link in the browser, and
// pictures in the viewer. The user's attachments sit above their bubble; what a reply carries sits
// under it.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { readTextThumb } from '@shared/attachments'
import type { AttachmentBytes } from '@shared/agent-host'
import type { Attachment, ContentRef } from '@shared/thread'
import { formatBytes } from '../attachments'
import { useLink } from '../host'
import { BottomSheet } from '../ui/BottomSheet'
import { useSessionRows } from '../ui/session/context'
import { openFile, parseFileRef } from '../ui/session/fileRefs'
import { FileMark, G, Icon, type IconSpec } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { PictureStrip, pictureOf, type Picture } from './Pictures'
import { openUrl } from '../system/openUrl'

type Tiled = Exclude<ContentRef, { kind: 'image' }>

/** What a tile says under an attachment's name: its lines, its size, or that it is a folder. */
function detailOf(attachment: Attachment): string | null {
  if (attachment.type === 'folder') return '文件夹'
  const preview = attachment.type === 'text' ? readTextThumb(attachment.thumb) : null
  if (preview) return `${preview.count} 行`
  return attachment.size !== null ? formatBytes(attachment.size) : null
}

/** How an attachment went, in the desktop's words. */
function sentAs(attachment: Attachment): string | null {
  switch (attachment.sent) {
    case 'image':
      return '以图片发送'
    case 'embedded':
      return '连同内容发送'
    case 'inline':
      return '作为文本接在消息之后发送'
    case 'linked':
      return attachment.type === 'folder' ? '以文件夹链接发送' : '以文件链接发送'
    default:
      return null
  }
}

/** A file URI's path, as the host wrote it. */
function uriPath(uri: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/i.exec(uri)
  if (!match) return null
  try {
    const path = decodeURIComponent(match[1]!)
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

function Tile(props: {
  icon: IconSpec | null
  path?: string
  name: string
  detail: string | null
  onPress: (() => void) | null
  label?: string
}) {
  const { c, s } = useSessionTokens()
  return (
    <PressScale
      scale={0.97}
      disabled={!props.onPress}
      onPress={props.onPress ?? undefined}
      accessibilityRole={props.onPress ? 'button' : undefined}
      accessibilityLabel={props.label ?? props.name}
      style={[styles.tile, { backgroundColor: s.bubble, borderColor: c.border }]}
    >
      {props.icon ? (
        <Icon icon={props.icon} size={16} color={c.textSecondary} />
      ) : (
        <FileMark path={props.path ?? props.name} size={16} />
      )}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1} ellipsizeMode="middle">
          {props.name}
        </Text>
        {props.detail ? (
          <Text style={[styles.detail, { color: c.textTertiary }]} numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
    </PressScale>
  )
}

/** A pasted text, read from the thread store when opened. */
function TextSheet(props: { target: { name: string; hash: string } | null; onClose(): void }) {
  const { c } = useSessionTokens()
  const { sessionId } = useSessionRows()
  const link = useLink()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hash = props.target?.hash ?? null
  useEffect(() => {
    if (!hash) return
    let live = true
    setText(null)
    setError(null)
    ;(link.request('sessions.blob', { sessionId, hash }) as Promise<AttachmentBytes>).then(
      (read) => live && setText(new TextDecoder().decode(new Uint8Array(read.bytes))),
      () => live && setError('没能读取这段文本。'),
    )
    return () => {
      live = false
    }
  }, [hash, link, sessionId])
  return (
    <BottomSheet visible={props.target !== null} onClose={props.onClose} title={props.target?.name}>
      {error ? (
        <Text style={{ color: c.danger, fontSize: 14 }}>{error}</Text>
      ) : text === null ? (
        <ActivityIndicator color={c.textSecondary} />
      ) : (
        <ScrollView horizontal bounces={false}>
          <Text selectable style={[styles.mono, { color: c.text }]}>
            {text.length > 60_000 ? `${text.slice(0, 60_000)}\n…` : text}
          </Text>
        </ScrollView>
      )}
    </BottomSheet>
  )
}

/** Opens what a tile stands for, where the phone can: a file or folder of the session's folder. */
function useOpener() {
  const { sessionId, root } = useSessionRows()
  const [reading, setReading] = useState<{ name: string; hash: string } | null>(null)
  const openPath = (path: string, folder: boolean) => {
    const ref = root ? parseFileRef(path, root) : null
    if (!ref) {
      Alert.alert('打不开', '它不在这个会话的文件夹里，请在电脑上查看。')
      return
    }
    if (folder) router.push({ pathname: '/files/[id]', params: { id: sessionId, dir: ref.path } })
    else openFile(sessionId, ref.path, ref.line)
  }
  const open = (ref: Tiled): (() => void) | null => {
    switch (ref.kind) {
      case 'attachment': {
        const attachment = ref.attachment
        if (attachment.type === 'text') {
          return attachment.blob
            ? () => setReading({ name: attachment.name, hash: attachment.blob! })
            : null
        }
        const path = attachment.uri ? uriPath(attachment.uri) : null
        return path ? () => openPath(path, attachment.type === 'folder') : null
      }
      case 'link': {
        if (/^https?:/i.test(ref.uri)) {
          return () => openUrl(ref.uri)
        }
        const path = uriPath(ref.uri)
        return path ? () => openPath(path, false) : null
      }
      default:
        return null
    }
  }
  const sheet = <TextSheet target={reading} onClose={() => setReading(null)} />
  return { open, sheet }
}

/** Tiles for what a message carries that is no picture shown in its strip. */
export function RefTiles(props: { refs: Tiled[]; align: 'start' | 'end' }) {
  const { open, sheet } = useOpener()
  if (props.refs.length === 0) return null
  return (
    <View
      style={[styles.tiles, { justifyContent: props.align === 'end' ? 'flex-end' : 'flex-start' }]}
    >
      {props.refs.map((ref, i) => {
        switch (ref.kind) {
          case 'attachment': {
            const a = ref.attachment
            const note = sentAs(a)
            return (
              <Tile
                key={i}
                icon={a.type === 'folder' ? G.folder : a.type === 'text' ? G.file : null}
                name={a.name}
                detail={detailOf(a)}
                onPress={open(ref)}
                label={[a.name, detailOf(a), note].filter(Boolean).join('，')}
              />
            )
          }
          case 'link':
            return (
              <Tile
                key={i}
                icon={ref.uri.startsWith('file:') ? null : G.link}
                path={ref.uri}
                name={ref.name || ref.uri}
                detail={null}
                onPress={open(ref)}
              />
            )
          case 'audio':
          case 'video':
            return (
              <Tile
                key={i}
                icon={G.file}
                name={ref.name ?? (ref.kind === 'audio' ? '音频' : '视频')}
                detail={`${ref.kind === 'audio' ? '音频' : '视频'} · ${formatBytes(ref.size)}`}
                onPress={null}
              />
            )
          // A terminal, tab or device of the computer the user named, which its agent may use.
          case 'terminal':
            return <Tile key={i} icon={G.terminal} name={ref.name} detail="终端" onPress={null} />
          case 'page':
            return <Tile key={i} icon={G.link} name={ref.name} detail="网页" onPress={null} />
          case 'device':
            return <Tile key={i} icon={G.info} name={ref.name} detail="设备" onPress={null} />
          // Huli: another session the user referenced, which opens it.
          case 'session':
            return (
              <Tile
                key={i}
                icon={G.subagent}
                name={ref.name}
                detail="会话"
                onPress={() => router.push(`/session/${ref.sessionId}`)}
              />
            )
          // An item a plugin of the computer's added to the message.
          case 'plugin':
            return <Tile key={i} icon={G.info} name={ref.name} detail="插件" onPress={null} />
          default:
            return <Tile key={i} icon={G.info} name={ref.label} detail={null} onPress={null} />
        }
      })}
      {sheet}
    </View>
  )
}

/** What a reply carries, under it: its pictures in a strip, the rest as tiles. */
export function CarriedRefs(props: { refs: ContentRef[] }) {
  const pictures = props.refs.map(pictureOf).filter((p): p is Picture => p !== null)
  const rest = props.refs.filter(
    (ref): ref is Tiled => ref.kind !== 'image' && pictureOf(ref) === null,
  )
  return (
    <View style={{ gap: 8 }}>
      <PictureStrip pictures={pictures} align="start" />
      <RefTiles refs={rest} align="start" />
    </View>
  )
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 11,
    paddingVertical: 8,
    maxWidth: 240,
  },
  name: { fontSize: 13.5, fontWeight: '500' },
  detail: { fontSize: 11.5, marginTop: 1 },
  mono: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
})

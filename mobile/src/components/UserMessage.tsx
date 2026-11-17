// The user's message in a session, as the desktop's: a soft bubble on the right with its text as
// Markdown, its command, mentions and links as chips that open what they name, cut short past 300
// points with 展开; its pictures as thumbnails and its other attachments as tiles above it; and
// under it when it was sent, whether it was steered into a running turn, and who sent it. Holding
// the bubble offers to copy or select its text.

import { memo, useMemo } from 'react'
import { Alert, Linking, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { Attachment, ContentRef, FromDevice, FromSession, UserContent } from '@shared/thread'
import { leadingCommand, mentionResolver, type Chip } from '../ui/session/chips'
import { Clamp } from '../ui/session/Clamp'
import { useSessionRows } from '../ui/session/context'
import { copyText, showMenu } from '../ui/session/feedback'
import { foldersOf, openFile, parseFileRef, useFileRefs } from '../ui/session/fileRefs'
import { G, Icon } from '../ui/session/icons'
import { useMinute } from '../ui/session/now'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { selectText } from '../ui/session/SelectText'
import { agoText } from '../ui/session/work'
import { RefTiles } from './CarriedRefs'
import { Markdown, type MarkdownChips } from './Markdown'
import { PictureStrip, pictureOf, type Picture } from './Pictures'

/** Taller than this, a message is cut short behind 展开. */
const COLLAPSED_HEIGHT = 300

function textOf(content: readonly UserContent[]): string {
  return content
    .filter((c): c is Extract<UserContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
}

/** The words a copy takes: the text, and a link's address. */
function copiedText(content: readonly UserContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .filter(Boolean)
    .join('\n')
}

function Ago(props: { at: number; color: string }) {
  const now = useMinute()
  return <Text style={[styles.meta, { color: props.color }]}>{agoText(props.at, now)}</Text>
}

export const UserMessage = memo(function UserMessage(props: {
  content: UserContent[]
  at?: number
  steered?: boolean
  device?: FromDevice
  from?: FromSession
}) {
  const { content } = props
  const { c, s } = useSessionTokens()
  const { sessionId, commands, command } = useSessionRows()
  const refs = useFileRefs()
  const text = textOf(content)
  const carried = content.flatMap((part): ContentRef[] => (part.type === 'ref' ? [part.ref] : []))
  const attachments = carried.flatMap((ref): Attachment[] =>
    ref.kind === 'attachment' ? [ref.attachment] : [],
  )
  const pictures = carried.map(pictureOf).filter((each): each is Picture => each !== null)

  // Mentions resolve against what the message carried, then the project's files.
  const mentions = /[@＠]/.test(text)
  const resolve = useMemo(
    () =>
      mentionResolver(
        attachments,
        mentions && refs?.known ? { files: refs.known, folders: foldersOf(refs.known) } : null,
      ),
    // The attachments change only with the content.
    [content, mentions, refs?.known],
  )
  const chips = useMemo<MarkdownChips>(
    () => ({
      resolve,
      onOpen: (chip: Chip) => {
        if (chip.kind === 'link') {
          void Linking.openURL(chip.url).catch(() => {})
          return
        }
        const attachment = chip.attachmentId
          ? attachments.find((a) => a.id === chip.attachmentId)
          : undefined
        let path = chip.path ?? null
        if (attachment?.uri && refs?.root) {
          const inside = parseFileRef(attachment.uri, refs.root)
          path = inside?.path ?? null
        }
        if (!path) {
          if (attachment?.type !== 'image') {
            Alert.alert('打不开', '它不在这个会话的文件夹里，请在电脑上查看。')
          }
          return
        }
        if (chip.kind === 'folder') {
          router.push({ pathname: '/files/[id]', params: { id: sessionId, dir: path } })
        } else {
          const line = chip.lines ? Number(chip.lines.split('–')[0]) : null
          openFile(sessionId, path, line)
        }
      },
    }),
    [resolve, sessionId, refs?.root],
  )

  // A file a mention names is its chip in the text; pictures stay above as thumbnails.
  const named = useMemo(() => {
    const ids = new Set<string>()
    if (!mentions) return ids
    for (const chip of [...text.matchAll(/[@＠](\S+)/g)]) {
      const target = resolve(chip[1]!.replace(/[.,;:!?)\]}>'"。，；：！？）、]+$/, ''))
      if (target?.attachmentId) ids.add(target.attachmentId)
    }
    return ids
  }, [text, mentions, resolve])
  const tiles = carried.filter(
    (ref): ref is Exclude<ContentRef, { kind: 'image' }> =>
      ref.kind !== 'image' &&
      pictureOf(ref) === null &&
      !(ref.kind === 'attachment' && named.has(ref.attachment.id)),
  )

  // The command the text starts with reads as the composer's: colored, and tapped, it goes into
  // the composer to be sent again.
  const lead = leadingCommand(text, commands ?? [])
  const name = lead ? text.slice(1, lead) : null
  const body = name ? text.slice(lead).replace(/^ /, '') : text
  const head = name ? (
    <Text
      style={{ color: c.tint, fontWeight: '600' }}
      {...(command ? { onPress: () => command(name) } : {})}
      accessibilityRole={command ? 'button' : undefined}
    >
      <Text style={{ opacity: 0.55 }}>/</Text>
      {name}
      {body ? ' ' : ''}
    </Text>
  ) : undefined

  const note = props.from
    ? `来自 ${props.from.title}`
    : props.device
      ? `从 ${props.device.name} 发送`
      : null

  const menu = () =>
    showMenu(undefined, [
      { label: '复制', onPress: () => void copyText(copiedText(content)) },
      { label: '选择文本', onPress: () => selectText({ text }) },
    ])

  return (
    <View style={styles.root}>
      {pictures.length > 0 && (
        <View style={styles.wide}>
          <PictureStrip pictures={pictures} align="end" />
        </View>
      )}
      {tiles.length > 0 && <RefTiles refs={tiles} align="end" />}
      {text ? (
        <PressScale
          scale={0.98}
          onLongPress={menu}
          delayLongPress={350}
          style={[styles.bubble, { backgroundColor: s.bubble }]}
        >
          <Clamp maxHeight={COLLAPSED_HEIGHT} align="end">
            <Markdown markdown={body} chips={chips} head={head} />
          </Clamp>
        </PressScale>
      ) : null}
      {(props.steered || props.at !== undefined) && (
        <View style={styles.metaRow}>
          {props.steered && (
            <View style={styles.steered}>
              <Icon
                icon={G.child}
                size={11}
                color={c.textTertiary}
                style={{ transform: [{ scaleX: -1 }] }}
              />
              <Text style={[styles.meta, { color: c.textTertiary }]}>已插入当前对话</Text>
            </View>
          )}
          {props.at !== undefined && <Ago at={props.at} color={c.textTertiary} />}
        </View>
      )}
      {note && <Text style={[styles.meta, { color: c.textTertiary }]}>{note}</Text>}
    </View>
  )
})

const styles = StyleSheet.create({
  root: { alignItems: 'flex-end', gap: 6, paddingLeft: 48 },
  wide: { alignSelf: 'stretch', marginLeft: -48 },
  bubble: {
    borderRadius: 20,
    borderBottomRightRadius: 6,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 4 },
  steered: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
})

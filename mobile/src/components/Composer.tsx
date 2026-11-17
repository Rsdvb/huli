// The message box of a session and of a new one: a rounded card with the text, which the
// keyboard's dictation fills too, and a row of controls under it; photos and files are uploaded
// as each is added so the message itself goes at once. While a turn runs, a round stop button
// sits at the row's end, and once there is something to send, a button that queues it beside it,
// which held offers to send it into the turn now.
//
// It keeps the desktop composer's ways (features/session/composer): the text and attachments are
// the session's draft, kept across screens and restarts; `/` at the start lists the agent's
// commands and `@` the project's files, right above the box, and a file picked so is one piece of
// the text that is also its attachment; a long paste becomes an attachment; and Send empties the
// box at once, giving the message back if it could not go.

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { PASTED_TEXT_CHARS, readTextThumb } from '@shared/attachments'
import type { Attachment, SlashCommand, UserContent } from '@shared/thread'
import {
  ATTACHMENT_LIMIT,
  attachProjectFile,
  formatBytes,
  isPhoto,
  messageContent,
  nextNumber,
  prepare,
  sendBlock,
  sentNote,
  tooLarge,
  upload,
  type PendingAttachment,
  type PickedSource,
  type Takes,
} from '../attachments'
import {
  editText,
  leadingCommand,
  mentionAt,
  replaceRange,
  slashAt,
  type Mention,
  type MentionQuery,
} from '../composerText'
import { readDraft, useDraftsReady, writeDraft, type SavedAttachment } from '../drafts'
import { matchFiles, useProjectFiles } from '../files'
import { useHost, useLink } from '../host'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic, showMenu } from '../ui/session/feedback'
import { openFile } from '../ui/session/fileRefs'
import { extensionOf } from '../ui/session/format'
import { FileMark, G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { Glass, useGlassMode } from '../ui/Glass'
import { NativeMenu } from '../ui/session/NativeMenu'
import { useMenuEdge, type MenuSource, type ViewHandle } from '../ui/session/Popover'
import { PressScale, RoundButton } from '../ui/session/Press'
import { PictureViewer, type Picture } from './Pictures'

export interface ComposerProps {
  placeholder: string
  /** The agent the message goes to, for the field's label and the attachments' notes. */
  agentName: string | null
  /** Sends the message; the box empties at once and takes the message back if this fails. */
  onSend(content: UserContent[]): Promise<unknown>
  /** While a turn runs: sends the message into it now, from the held queue button. */
  onSendNow?: (content: UserContent[]) => Promise<unknown>
  /** The agent takes a message into a running turn; without it Send now stops the turn first. */
  steering?: boolean
  /** The alert's title when sending fails. */
  failTitle: string
  /** Whether a message without text or attachments may go, as a new session's may. */
  allowEmpty?: boolean
  disabled?: boolean
  /** Why nothing can go now, said over the text; Send stays off while it holds. */
  blocked?: string | null
  /** Why nothing can be added now, as while the agent starts. */
  addBlocked?: string | null
  /** The draft the box keeps: a session's id, or New session's. */
  draft: string | null
  /** The agent's slash commands, listed as `/` is typed at the start. */
  commands?: readonly SlashCommand[]
  /** The project `@` mentions name files of; null without one. */
  folder?: string | null
  /** The files the session read or edited, newest first, listed on a bare `@`. */
  usedFiles?: readonly string[]
  /** The session whose files a mentioned file's tile opens. */
  sessionId?: string
  /** What the agent's prompts take, for how each attachment goes. */
  takes?: Takes | null
  /** Hears how many attachments the box holds, for the add menu's limit. */
  onCountChange?: (count: number) => void
  bottomInset: number
  /** A turn runs: an empty box offers to stop it. */
  running?: boolean
  onStop?: () => void
  /**
   * Over the card, such as the switch's strip or the prompt cache's notice; as a function it is
   * told whether the box holds a message, so typing never renders the screen around it.
   */
  top?: ReactNode | ((holds: boolean) => ReactNode)
  /** Controls after the attach button, such as the permission mode. */
  left?: ReactNode
  /** Controls before the send button, such as the model. */
  right?: ReactNode
  /** Under the card: the status line. */
  footer?: ReactNode
  autoFocus?: boolean
  /** Opens the screen's add menu from the add button; without it the system's menu opens. */
  onAttach?: (anchor: RefObject<ViewHandle | null>) => void
  /** The add menu as the system's menu where there is one; its search pages open over the button. */
  attachMenu?: (anchor: RefObject<ViewHandle | null>) => MenuSource
  ref?: Ref<ComposerHandle>
}

export interface ComposerHandle {
  pickPhotos(): void
  takePhoto(): void
  pickFiles(): void
  /** Puts the clipboard's picture in as an attachment. */
  pasteImage(): void
  /** Mentions a file of the project: `@name` at the caret, and the file attached. */
  mention(projectPath: string, path: string): void
  /** Puts `/name ` at the start of the text, in place of a command already there. */
  command(name: string, names: readonly string[]): void
  /** Puts a message back to edit, as a queued one taken back; its attachments come as tiles. */
  restore(content: readonly UserContent[]): void
  focus(): void
}

/**
 * The room under the box: the home indicator's, which the keyboard covers once it is up. Screens
 * move the box up by the keyboard less `keyboardOverlap`, so 8 pt stay above the keyboard without
 * the box changing its layout as the keyboard comes and goes.
 */
export function composerBottom(inset: number): number {
  return Math.max(inset, 8)
}

/** How far the box's bottom room may sit under the keyboard. */
export function keyboardOverlap(inset: number): number {
  return composerBottom(inset) - 8
}

/** Thrown by a send the user called off, as at a confirmation: the message comes back unsaid. */
export class SendCancelled extends Error {}

let nextKey = 1
const newKey = () => `a${nextKey++}`

/** How long after the focus the clipboard is asked for a picture: past the keyboard's rise. */
const CLIPBOARD_DELAY = 600

const LIMIT_TEXT = `一条消息最多带 ${ATTACHMENT_LIMIT} 个附件`

function announce(text: string): void {
  AccessibilityInfo.announceForAccessibility(text)
}

/** A tile for an attachment the computer already holds, as a draft or a taken-back message has. */
function heldItem(
  attachment: Attachment,
  saved?: Omit<SavedAttachment, 'attachment'>,
): PendingAttachment {
  const kind =
    saved?.kind ??
    (attachment.type === 'image' ? 'image' : attachment.type === 'text' ? 'text' : 'file')
  return {
    key: newKey(),
    source: {
      kind,
      uri: saved?.uri ?? attachment.uri ?? '',
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(saved?.projectPath ? { projectPath: saved.projectPath } : {}),
    },
    status: 'ready',
    thumb: attachment.thumb,
    size: attachment.size,
    attachment,
    error: null,
  }
}

/** The commands whose name holds the query, those that start with it first. */
function slashMatches(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const needle = query.toLowerCase()
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) starts.push(command)
    else if (name.includes(needle)) contains.push(command)
  }
  return [...starts, ...contains]
}

export function Composer(props: ComposerProps) {
  const { placeholder, onSend, failTitle, allowEmpty = false, disabled = false } = props
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const liquid = useGlassMode() === 'liquid'
  const tray = useRef<ViewHandle>(null)
  useMenuEdge(tray)
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<Mention[]>([])
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Picture | null>(null)
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const attachAnchor = useRef<ViewHandle>(null)
  const caretRef = useRef<number | null>(null)
  const latestText = useRef('')
  const latestMentions = useRef<Mention[]>([])
  const latest = useRef<PendingAttachment[]>([])
  const mounted = useRef(true)
  /** The keys of attachments a message is carrying, which leaving the screen must not remove. */
  const carried = useRef(new Set<string>())
  // One at a time, so a photo is read and scaled while nothing else holds its memory.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const agent = props.agentName ?? 'Agent'
  const computer = host.host?.id ?? null
  const draftKey = props.draft
  const draftsReady = useDraftsReady(draftKey ? computer : null)
  /** The draft has been read into the box, so changes from now on are written back. */
  const [restored, setRestored] = useState(!draftKey)
  /** A restored draft's attachments to ask the computer about, once connected. */
  const unchecked = useRef<Map<string, string> | null>(null)
  const connected = host.state.kind === 'connected'

  const forget = (id: string) => {
    void link.request('attachments.remove', { id }).catch(() => {})
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // A draft keeps what the computer holds for it; without one, the computer forgets it.
      for (const item of latest.current) {
        if (!item.attachment || carried.current.has(item.key)) continue
        if (draftKey && item.status === 'ready') continue
        forget(item.attachment.id)
      }
      latest.current = []
    }
    // The draft key is fixed for the composer's life: screens key the composer by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Changes the list here at once, for the uploads to read, and in the state alike. */
  const change = (next: (list: PendingAttachment[]) => PendingAttachment[]) => {
    latest.current = next(latest.current)
    setItems(latest.current)
  }

  /** Sets the text and its mentions together. */
  const setBox = (next: { text: string; mentions: Mention[] }) => {
    latestText.current = next.text
    latestMentions.current = next.mentions
    setText(next.text)
    setMentions(next.mentions)
  }

  const placeCaret = (at: number) => {
    caretRef.current = at
    setCaret(at)
    requestAnimationFrame(() => input.current?.setSelection(at, at))
  }

  // The draft is read into the box once the computer's drafts are, unless the user began first.
  useEffect(() => {
    if (restored || !draftKey) return
    if (!computer) {
      setRestored(true)
      return
    }
    if (!draftsReady) return
    setRestored(true)
    const draft = readDraft(computer, draftKey)
    if (!draft || latestText.current || latest.current.length > 0) return
    const byId = new Map<string, string>()
    const restoredItems = draft.attachments.map((saved) => {
      const item = heldItem(saved.attachment, saved)
      byId.set(saved.attachment.id, item.key)
      return item
    })
    const restoredMentions = draft.mentions.flatMap((m) => {
      const key = byId.get(m.attachmentId)
      return key ? [{ key, from: m.from, to: m.to }] : []
    })
    change(() => restoredItems)
    setBox({ text: draft.text, mentions: restoredMentions })
    if (byId.size > 0) unchecked.current = byId
  }, [restored, draftKey, computer, draftsReady])

  // A draft's attachments the computer no longer holds can only be removed and added again.
  useEffect(() => {
    const byId = unchecked.current
    if (!restored || !connected || !byId) return
    unchecked.current = null
    void (link.request('attachments.held', { ids: [...byId.keys()] }) as Promise<string[]>)
      .then((held) => {
        const kept = new Set(held)
        const gone = new Set([...byId].filter(([id]) => !kept.has(id)).map(([, key]) => key))
        if (gone.size === 0 || !mounted.current) return
        change((list) =>
          list.map((item) =>
            gone.has(item.key)
              ? { ...item, status: 'failed', attachment: null, gone: true, error: '已不可用' }
              : item,
          ),
        )
      })
      .catch(() => {})
  }, [restored, connected, link])

  // Every change goes to the draft: the text, the attachments the computer holds, their mentions.
  useEffect(() => {
    if (!restored || !draftKey || !computer) return
    const ready = items.filter((item) => item.status === 'ready' && item.attachment)
    const ids = new Map(ready.map((item) => [item.key, item.attachment!.id]))
    writeDraft(computer, draftKey, {
      text,
      attachments: ready.map((item) => ({
        attachment: item.attachment!,
        kind: item.source.kind,
        uri: item.source.uri,
        ...(item.source.projectPath ? { projectPath: item.source.projectPath } : {}),
      })),
      mentions: mentions.flatMap((m) => {
        const attachmentId = ids.get(m.key)
        return attachmentId ? [{ from: m.from, to: m.to, attachmentId }] : []
      }),
    })
  }, [restored, draftKey, computer, text, items, mentions])

  const holds = text.trim().length > 0 || items.length > 0
  const { onCountChange } = props
  useEffect(() => onCountChange?.(items.length), [items.length, onCountChange])

  const held = (key: string) => mounted.current && latest.current.some((item) => item.key === key)

  const patch = (key: string, changes: Partial<PendingAttachment>) => {
    change((list) => list.map((item) => (item.key === key ? { ...item, ...changes } : item)))
  }

  const run = async (key: string, source: PickedSource) => {
    if (!held(key)) return
    patch(key, { status: 'preparing', error: null, gone: false })
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
      patch(key, {
        status: 'ready',
        attachment,
        ...(attachment.thumb && !prepared.thumb ? { thumb: attachment.thumb } : {}),
      })
    } catch (error) {
      if (held(key)) patch(key, { status: 'failed', error: (error as Error).message })
    }
  }

  const enqueue = (key: string, source: PickedSource) => {
    queue.current = queue.current.then(() => run(key, source))
  }

  /** Adds what was picked, as many as there is room for; the keys name mention's items. */
  const add = (sources: PickedSource[], keys?: string[]): string[] => {
    const room = ATTACHMENT_LIMIT - latest.current.length
    const refused = sources.flatMap((source) => tooLarge(source.name, source.size) ?? [])
    const fitting = sources.filter((source) => !tooLarge(source.name, source.size))
    if (refused.length > 0) Alert.alert('文件太大', refused.join('\n'))
    if (fitting.length > room) Alert.alert('附件太多', `${LIMIT_TEXT}。`)
    const added = fitting.slice(0, Math.max(0, room)).map((source, index): PendingAttachment => ({
      key: keys?.[index] ?? newKey(),
      source,
      status: 'waiting',
      thumb: null,
      size: source.size,
      attachment: null,
      error: null,
    }))
    if (added.length === 0) return []
    change((list) => [...list, ...added])
    announce(added.map((item) => `已添加 ${item.source.name}`).join('，'))
    for (const item of added) enqueue(item.key, item.source)
    return added.map((item) => item.key)
  }

  /** Removes a tile, and its `@name` from the text unless the text already lost it. */
  const remove = (key: string, fromText = true) => {
    const item = latest.current.find((each) => each.key === key)
    change((list) => list.filter((each) => each.key !== key))
    if (item?.attachment) forget(item.attachment.id)
    const mention = latestMentions.current.find((m) => m.key === key)
    if (mention) {
      const current = latestText.current
      if (fromText) {
        const end = current[mention.to] === ' ' ? mention.to + 1 : mention.to
        setBox(replaceRange(current, latestMentions.current, mention.from, end, ''))
      } else {
        setBox({ text: current, mentions: latestMentions.current.filter((m) => m.key !== key) })
      }
    }
    if (item) announce(`已移除 ${item.source.name}`)
  }

  const retry = (key: string) => {
    const item = latest.current.find((each) => each.key === key)
    if (!item) return
    patch(key, { status: 'waiting', error: null })
    enqueue(key, item.source)
  }

  const pressItem = (item: PendingAttachment) => {
    if (item.status === 'failed' && !item.gone) {
      Alert.alert('附件没传上去', item.error ?? '', [
        { text: '移除', style: 'destructive', onPress: () => remove(item.key) },
        { text: '重试', onPress: () => retry(item.key) },
        { text: '取消', style: 'cancel' },
      ])
      return
    }
    setOpened(item.key)
  }

  const room = () => {
    const left = ATTACHMENT_LIMIT - latest.current.length
    if (left <= 0) Alert.alert('附件太多', `${LIMIT_TEXT}。`)
    return left
  }

  const photoSources = (assets: ImagePicker.ImagePickerAsset[]): PickedSource[] =>
    assets.map((asset, index) => {
      const name = asset.fileName || `图片 ${nextNumber(latest.current, '图片') + index}.jpg`
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

  /** A pasted picture, from its data URL: written to the cache, then added like a photo. */
  const addPastedImage = async (data: string) => {
    if (room() <= 0) return
    const match = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(data)
    if (!match) return
    const mimeType = match[1]!
    const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png'
    const file = new File(Paths.cache, `huli-paste-${Date.now()}.${extension}`)
    file.create({ overwrite: true })
    await file.write(match[2]!, { encoding: 'base64' })
    add([
      {
        kind: 'image',
        uri: file.uri,
        name: `图片 ${nextNumber(latest.current, '图片')}.${extension}`,
        mimeType,
        size: null,
      },
    ])
    setClipboardImage(false)
  }

  const pasteImage = async () => {
    const image = await Clipboard.getImageAsync({ format: 'png' })
    if (!image) {
      Alert.alert('剪贴板里没有图片', '复制一张图片后再试。')
      return
    }
    await addPastedImage(image.data)
  }

  const addPastedText = (pasted: string) => {
    if (room() <= 0) return
    add([
      {
        kind: 'text',
        uri: '',
        name: `粘贴的文本 ${nextNumber(latest.current, '粘贴的文本')}`,
        mimeType: 'text/plain',
        size: new TextEncoder().encode(pasted).byteLength,
        text: pasted,
      },
    ])
  }

  const choose = (action: () => Promise<void>) => {
    action().catch((error: unknown) => {
      console.warn('Could not pick an attachment', error)
      Alert.alert('没能打开', '请稍后再试。')
    })
  }

  // A picture on the clipboard is offered while the box has the focus: a text field cannot take
  // one, and asking the clipboard for it would ask the user's leave each time.
  const [clipboardImage, setClipboardImage] = useState(false)
  useEffect(() => {
    if (!focused) return
    let live = true
    const check = () =>
      void Clipboard.hasImageAsync().then(
        (has) => live && setClipboardImage(has),
        () => {},
      )
    // Asked once the keyboard is up, so nothing else runs while it comes.
    const first = setTimeout(check, CLIPBOARD_DELAY)
    const app = AppState.addEventListener('change', (state) => state === 'active' && check())
    const clip = Clipboard.addClipboardListener(check)
    return () => {
      live = false
      clearTimeout(first)
      app.remove()
      Clipboard.removeClipboardListener(clip)
    }
  }, [focused])

  const onChangeText = (after: string) => {
    const edit = editText(latestText.current, after, latestMentions.current)
    // A long paste goes as an attachment, as the desktop sends it, rather than as typed text.
    if (edit.inserted.length > PASTED_TEXT_CHARS) {
      setBox(replaceRange(edit.text, edit.mentions, edit.at, edit.at + edit.inserted.length, ''))
      addPastedText(edit.inserted)
      placeCaret(edit.at)
      return
    }
    setBox(edit)
    for (const key of edit.dropped) remove(key, false)
    if (edit.caret !== null) placeCaret(edit.caret)
  }

  /** Puts a file of the project in as a mention, in place of `range` or at the caret. */
  const mention = (projectPath: string, path: string, range?: MentionQuery) => {
    if (room() <= 0) return
    const name = path.slice(path.lastIndexOf('/') + 1)
    const current = latestText.current
    const at = Math.min(caretRef.current ?? current.length, current.length)
    const from = range ? range.start : at
    const to = range ? range.end : at
    const before = current.slice(0, from)
    const after = current.slice(to)
    const lead = before === '' || /\s$/.test(before) ? '' : ' '
    const token = `@${name}`
    const put = `${lead}${token}${after.startsWith(' ') ? '' : ' '}`
    const key = newKey()
    const next = replaceRange(current, latestMentions.current, from, to, put)
    const start = from + lead.length
    setBox({
      text: next.text,
      mentions: [...next.mentions, { key, from: start, to: start + token.length }].sort(
        (a, b) => a.from - b.from,
      ),
    })
    add([{ kind: 'project', uri: path, name, mimeType: null, size: null, projectPath }], [key])
    placeCaret(from + put.length + (after.startsWith(' ') ? 1 : 0))
  }

  const command = (name: string, names: readonly string[]) => {
    const current = latestText.current
    const typed = /^\/\S*/.exec(current)?.[0].length ?? leadingCommand(current, names)
    const cut = typed + (current[typed] === ' ' ? 1 : 0)
    const put = `/${name} `
    setBox(replaceRange(current, latestMentions.current, 0, cut, put))
    placeCaret(put.length)
    setTimeout(() => input.current?.focus(), 50)
  }

  /** Gives a message back to the box, after what it holds. */
  const restoreMessage = (
    message: { text: string; items: PendingAttachment[]; mentions: Mention[] },
    front: boolean,
  ) => {
    const current = latestText.current
    const join = (a: string, b: string) => (a && b ? `${a}\n${b}` : a || b)
    if (front) {
      const shift = message.text && current ? message.text.length + 1 : message.text.length
      setBox({
        text: join(message.text, current),
        mentions: [
          ...message.mentions,
          ...latestMentions.current.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift })),
        ],
      })
    } else {
      const shift = message.text && current ? current.length + 1 : current.length
      setBox({
        text: join(current, message.text),
        mentions: [
          ...latestMentions.current,
          ...message.mentions.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift })),
        ],
      })
    }
    change((list) => (front ? [...message.items, ...list] : [...list, ...message.items]))
  }

  const restore = (content: readonly UserContent[]) => {
    const words = content
      .map((part) =>
        part.type === 'text' ? part.text : part.ref.kind === 'link' ? part.ref.uri : '',
      )
      .filter(Boolean)
      .join('\n')
    const attachments = content.flatMap((part) =>
      part.type === 'ref' && part.ref.kind === 'attachment' ? [part.ref.attachment] : [],
    )
    const left = Math.max(0, ATTACHMENT_LIMIT - latest.current.length)
    for (const extra of attachments.slice(left)) forget(extra.id)
    if (attachments.length > left) Alert.alert('附件太多', `${LIMIT_TEXT}。`)
    restoreMessage(
      { text: words, items: attachments.slice(0, left).map((a) => heldItem(a)), mentions: [] },
      false,
    )
    setTimeout(() => input.current?.focus(), 50)
  }

  useImperativeHandle(props.ref, () => ({
    pickPhotos: () => choose(pickPhotos),
    takePhoto: () => choose(takePhoto),
    pickFiles: () => choose(pickFiles),
    pasteImage: () => choose(pasteImage),
    mention: (projectPath, path) => mention(projectPath, path),
    command,
    restore,
    focus: () => input.current?.focus(),
  }))

  // The add button and its system menu render again only when the screen gives a new menu, not on
  // each keystroke or focus of the box.
  const { attachMenu } = props
  const attachSource = useMemo(() => attachMenu?.(attachAnchor) ?? null, [attachMenu])
  const openRef = useRef<() => void>(() => {})
  const pressAttach = useCallback(() => openRef.current(), [])

  const openMenu = () => {
    if (props.onAttach) return props.onAttach(attachAnchor)
    showMenu('添加附件', [
      { label: '拍照', onPress: () => choose(takePhoto) },
      { label: '从相册选', onPress: () => choose(pickPhotos) },
      { label: '选文件', onPress: () => choose(pickFiles) },
    ])
  }

  const busy = items.filter((item) => item.status !== 'ready' && item.status !== 'failed')
  const block = sendBlock(items, text)
  const blocked = props.blocked ?? null
  const canSend =
    connected &&
    !sending &&
    !disabled &&
    !blocked &&
    busy.length === 0 &&
    !block &&
    (allowEmpty || holds)
  const stoppable = !!props.running && !!props.onStop
  const addBlocked = props.addBlocked ?? null
  openRef.current = () => (addBlocked ? Alert.alert(addBlocked) : openMenu())

  const send = async (now = false) => {
    if (!canSend) return
    haptic.tap()
    const taken = {
      text: latestText.current,
      items: latest.current,
      mentions: latestMentions.current,
    }
    const content = messageContent(taken.text, taken.items)
    for (const item of taken.items) carried.current.add(item.key)
    // The box empties at once; the message comes back if it could not go.
    setBox({ text: '', mentions: [] })
    change(() => [])
    setSending(true)
    try {
      await (now && props.onSendNow ? props.onSendNow(content) : onSend(content))
    } catch (error) {
      for (const item of taken.items) carried.current.delete(item.key)
      if (mounted.current) restoreMessage(taken, true)
      if (!(error instanceof SendCancelled)) {
        Alert.alert(failTitle, (error as { message?: string }).message || '请稍后再试。')
      }
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  const sendNow = () => {
    if (!canSend) return
    if (props.steering) return void send(true)
    Alert.alert('立即发送？', '停止本轮，接着发送这条消息', [
      { text: '取消', style: 'cancel' },
      { text: '停止并发送', style: 'destructive', onPress: () => void send(true) },
    ])
  }

  const holdQueue = () => {
    if (!canSend || !props.onSendNow) return
    showMenu(undefined, [
      { label: '加入队列 · 本轮结束后发送', onPress: () => void send() },
      {
        label: props.steering ? '立即发送 · 立即插入当前这一轮' : '立即发送 · 停止本轮后发送',
        onPress: sendNow,
      },
    ])
  }

  // Offline the screen may show the cache's copy of the conversation; nothing goes until connected.
  const status = !connected
    ? host.state.kind === 'connecting'
      ? '正在连接电脑…连上后才能发送。'
      : host.state.kind === 'reconnecting'
        ? '和电脑的连接断了，正在重连。连上后才能发送。'
        : '没有连上电脑，暂时不能发送。'
    : blocked && (holds || allowEmpty)
      ? blocked
      : busy.length > 0
        ? `正在处理附件，还剩 ${busy.length} 个…`
        : block

  // What `/` or `@` at the caret asks for, listed over the box.
  const commands = props.commands ?? []
  const slash = focused && commands.length > 0 ? slashAt(text, caret) : null
  const mentionQuery = focused && slash === null ? mentionAt(text, caret, mentions) : null

  const opened_ = opened ? (items.find((item) => item.key === opened) ?? null) : null

  // With Liquid Glass the tray and its card are one slab of glass; elsewhere a card in a tray.
  const Tray = liquid ? GlassTray : View
  return (
    <View style={[styles.outer, { paddingBottom: composerBottom(props.bottomInset) }]}>
      {typeof props.top === 'function' ? props.top(holds) : props.top}
      <Tray
        ref={tray}
        collapsable={false}
        style={[styles.tray, !liquid && { backgroundColor: s.dock, borderColor: c.border }]}
      >
        {slash !== null && (
          <SlashList
            commands={slashMatches(commands, slash)}
            onPick={(name) =>
              command(
                name,
                commands.map((each) => each.name),
              )
            }
          />
        )}
        {mentionQuery !== null && (
          <MentionList
            folder={props.folder ?? null}
            query={mentionQuery.query}
            used={props.usedFiles ?? []}
            onPick={(path) => props.folder && mention(props.folder, path, mentionQuery)}
          />
        )}
        <View
          style={[
            styles.card,
            liquid ? styles.glassCard : { backgroundColor: s.dockCard, borderColor: c.border },
          ]}
        >
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
                  note={sentNote(item, props.takes ?? null, agent)}
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
              accessibilityLiveRegion="polite"
            >
              {status}
            </Text>
          ) : null}
          {focused && clipboardImage && !addBlocked && (
            <PasteRow
              onPaste={(data) => choose(() => addPastedImage(data))}
              onPress={() => choose(pasteImage)}
            />
          )}
          <TextInput
            ref={input}
            onChangeText={onChangeText}
            onSelectionChange={(event) => {
              const end = event.nativeEvent.selection.end
              caretRef.current = end
              // The caret renders the box only where a `/` or `@` list could show, so moving it
              // or typing plain text costs no render of its own.
              const lists = latestText.current.startsWith('/') || latestText.current.includes('@')
              setCaret(lists ? end : null)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel={`给 ${agent} 发消息`}
            placeholder={placeholder}
            placeholderTextColor={c.textTertiary}
            selectionColor={c.accent}
            cursorColor={c.accent}
            multiline
            autoFocus={props.autoFocus}
            style={[styles.input, { color: c.text }]}
          >
            <Spans text={text} mentions={mentions} color={c.accent} fill={s.accentSoft} />
          </TextInput>
          <View style={styles.row}>
            <AttachButton
              anchor={attachAnchor}
              source={attachSource}
              blocked={addBlocked}
              onPress={pressAttach}
            />
            {props.left}
            <View style={styles.right}>{props.right}</View>
            {(!stoppable || holds || sending) && (
              <RoundButton
                tone="accent"
                // Held, the queue button offers Send now; the system's own button takes no hold.
                {...(sending || props.running ? {} : { systemImage: G.send.sf })}
                onPress={() => void send()}
                {...(props.running && props.onSendNow
                  ? { onLongPress: holdQueue, delayLongPress: 450 }
                  : {})}
                disabled={!canSend}
                accessibilityLabel={props.running ? '加入队列' : '发送'}
                {...(props.running && props.onSendNow
                  ? { accessibilityHint: '本轮结束后发送 · 按住可立即发送' }
                  : {})}
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
                tone="glass"
                systemImage={G.stop.sf}
              >
                <Icon icon={G.stop} size={13} color={c.text} weight="bold" />
              </RoundButton>
            )}
          </View>
        </View>
        {props.footer}
      </Tray>
      <TileSheet
        item={opened_}
        note={opened_ ? sentNote(opened_, props.takes ?? null, agent) : ''}
        onClose={() => setOpened(null)}
        onRemove={(key) => {
          setOpened(null)
          remove(key)
        }}
        onView={(picture) => {
          setOpened(null)
          setViewing(picture)
        }}
        onOpenFile={
          props.sessionId
            ? (path) => {
                setOpened(null)
                openFile(props.sessionId!, path)
              }
            : null
        }
      />
      {viewing && <PictureViewer picture={viewing} onClose={() => setViewing(null)} />}
    </View>
  )
}

const AttachButton = memo(function AttachButton(props: {
  anchor: RefObject<ViewHandle | null>
  source: MenuSource | null
  blocked: string | null
  onPress(): void
}) {
  const { c } = useSessionTokens()
  return (
    <View ref={props.anchor} collapsable={false}>
      <NativeMenu source={props.source} disabled={!!props.blocked}>
        <RoundButton
          onPress={props.onPress}
          disabled={!!props.blocked}
          accessibilityLabel="添加照片、文件或命令"
          {...(props.blocked ? { accessibilityHint: props.blocked } : {})}
        >
          <Icon icon={G.plus} size={19} color={c.text} weight="medium" />
        </RoundButton>
      </NativeMenu>
    </View>
  )
})

/** The text as the field draws it: each mention a piece of its own, tinted as a chip. */
function Spans(props: { text: string; mentions: readonly Mention[]; color: string; fill: string }) {
  const { text, mentions } = props
  const parts = useMemo(() => {
    const out: { key: string; text: string; chip: boolean }[] = []
    let at = 0
    for (const m of [...mentions].sort((a, b) => a.from - b.from)) {
      if (m.from < at || m.to > text.length) continue
      if (m.from > at) out.push({ key: `t${at}`, text: text.slice(at, m.from), chip: false })
      out.push({ key: m.key, text: text.slice(m.from, m.to), chip: true })
      at = m.to
    }
    if (at < text.length) out.push({ key: `t${at}`, text: text.slice(at), chip: false })
    return out
  }, [text, mentions])
  return (
    <>
      {parts.map((part) =>
        part.chip ? (
          <Text
            key={part.key}
            style={{ color: props.color, backgroundColor: props.fill, fontWeight: '600' }}
          >
            {part.text}
          </Text>
        ) : (
          <Text key={part.key}>{part.text}</Text>
        ),
      )}
    </>
  )
}

function GlassTray(props: {
  ref?: Ref<ViewHandle>
  style?: StyleProp<ViewStyle>
  collapsable?: false
  children?: ReactNode
}) {
  return <Glass {...props} radius={TRAY_RADIUS} />
}

/** The list over the box while `/` or `@` is typed. */
function Picker(props: { children: ReactNode; label: string }) {
  const { c, s } = useSessionTokens()
  return (
    <View
      style={[styles.picker, { backgroundColor: s.dockCard, borderColor: c.border }]}
      accessibilityLabel={props.label}
    >
      <ScrollView keyboardShouldPersistTaps="always" style={styles.pickerScroll}>
        {props.children}
      </ScrollView>
    </View>
  )
}

function PickerRow(props: {
  lead: ReactNode
  label: string
  subtitle?: string | undefined
  onPress(): void
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={() => {
        haptic.pick()
        props.onPress()
      }}
      accessibilityRole="button"
      accessibilityLabel={props.subtitle ? `${props.label}，${props.subtitle}` : props.label}
      style={({ pressed }) => [styles.pickerRow, pressed && { backgroundColor: c.fill }]}
    >
      {props.lead}
      <View style={styles.pickerText}>
        <Text style={[styles.pickerLabel, { color: c.text }]} numberOfLines={1}>
          {props.label}
        </Text>
        {props.subtitle ? (
          <Text style={[styles.pickerSub, { color: c.textSecondary }]} numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

function PickerNote(props: { text: string; onRetry?: () => void }) {
  const { c } = useSessionTokens()
  return (
    <View style={styles.pickerNote}>
      <Text style={[styles.pickerSub, { color: c.textSecondary, flex: 1 }]}>{props.text}</Text>
      {props.onRetry && (
        <Pressable onPress={props.onRetry} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.pickerLabel, { color: c.accent }]}>重试</Text>
        </Pressable>
      )}
    </View>
  )
}

function SlashList(props: { commands: SlashCommand[]; onPick(name: string): void }) {
  const { c } = useSessionTokens()
  return (
    <Picker label="命令">
      {props.commands.length === 0 ? (
        <PickerNote text="没有匹配的命令" />
      ) : (
        props.commands.map((command) => (
          <PickerRow
            key={command.name}
            lead={<Icon icon={G.slash} size={16} color={c.textSecondary} />}
            label={`/${command.name}`}
            subtitle={command.description || command.inputHint}
            onPress={() => props.onPick(command.name)}
          />
        ))
      )}
    </Picker>
  )
}

function MentionList(props: {
  folder: string | null
  query: string
  used: readonly string[]
  onPick(path: string): void
}) {
  const link = useLink()
  const { c } = useSessionTokens()
  const files = useProjectFiles(link, props.folder, props.folder !== null)
  let body: ReactNode
  if (!props.folder) {
    body = <PickerNote text="选择一个项目后才能提及其中的文件" />
  } else if (files.error && !files.list) {
    body = <PickerNote text={files.error} onRetry={files.reload} />
  } else if (!files.list) {
    body = (
      <View style={styles.pickerNote}>
        <ActivityIndicator size="small" color={c.textTertiary} />
        <Text style={[styles.pickerSub, { color: c.textSecondary }]}>正在列出项目文件…</Text>
      </View>
    )
  } else {
    const paths = files.list.paths
    const query = props.query.trim()
    const used = query ? [] : props.used.slice(0, 12)
    const found = query
      ? matchFiles(paths, query, 40)
      : used.length > 0
        ? used
        : [...paths].sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 30)
    body =
      found.length === 0 ? (
        <PickerNote text={query ? '没有匹配的文件' : '项目里没有文件'} />
      ) : (
        <>
          <Text style={[styles.pickerHead, { color: c.textTertiary }]}>
            {used.length > 0 ? '本会话用过' : '文件'}
          </Text>
          {found.map((path) => (
            <PickerRow
              key={path}
              lead={<FileMark path={path} size={16} />}
              label={path.slice(path.lastIndexOf('/') + 1)}
              subtitle={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined}
              onPress={() => props.onPick(path)}
            />
          ))}
        </>
      )
  }
  return <Picker label="提及文件">{body}</Picker>
}

/** Offers the clipboard's picture: the system's paste button where there is one. */
function PasteRow(props: { onPaste(data: string): void; onPress(): void }) {
  const { c } = useSessionTokens()
  return (
    <View style={styles.paste}>
      {Platform.OS === 'ios' && Clipboard.isPasteButtonAvailable ? (
        <Clipboard.ClipboardPasteButton
          acceptedContentTypes={['image']}
          displayMode="iconAndLabel"
          backgroundColor={c.fill as string}
          foregroundColor={c.text as string}
          cornerStyle="capsule"
          style={styles.pasteButton}
          onPress={(data) => {
            if (data.type === 'image') props.onPaste(data.data)
          }}
        />
      ) : (
        <PressScale
          onPress={props.onPress}
          accessibilityRole="button"
          accessibilityLabel="粘贴剪贴板里的图片"
          style={[styles.pastePill, { backgroundColor: c.fill }]}
        >
          <Icon icon={G.paste} size={14} color={c.text} />
          <Text style={[styles.pasteText, { color: c.text }]}>粘贴图片</Text>
        </PressScale>
      )}
    </View>
  )
}

function Tile(props: { item: PendingAttachment; note: string; onPress(): void; onRemove(): void }) {
  const { c, s } = useSessionTokens()
  const { item } = props
  const textThumb = readTextThumb(item.thumb ?? item.attachment?.thumb ?? null)
  const preview = textThumb
    ? null
    : (item.thumb ?? (item.source.kind === 'image' ? item.source.uri : null))
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
      accessibilityRole="button"
      accessibilityLabel={item.source.name}
      accessibilityHint={props.note}
      style={[styles.tile, { borderColor: c.border, backgroundColor: c.fill }]}
    >
      {preview ? (
        <Image source={{ uri: preview }} style={styles.preview} resizeMode="cover" />
      ) : textThumb ? (
        <View style={styles.file}>
          <Text style={[styles.textLines, { color: c.textSecondary }]} numberOfLines={3}>
            {textThumb.lines.join('\n')}
          </Text>
          <Text style={[styles.fileExt, { color: c.text }]} numberOfLines={1}>
            {textThumb.count} 行
          </Text>
        </View>
      ) : (
        <View style={styles.file}>
          <FileMark path={item.source.name} size={18} />
          <Text style={[styles.fileExt, { color: c.textSecondary }]} numberOfLines={1}>
            {item.source.kind === 'text'
              ? '文本'
              : extensionOf(item.source.name).toUpperCase() || '文件'}
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
          <Text style={[styles.coverText, { color: c.danger }]}>
            {item.gone ? '已不可用' : '点按查看'}
          </Text>
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

/** A tile opened: what it is, how it goes to the agent, and a way to look at it or remove it. */
function TileSheet(props: {
  item: PendingAttachment | null
  note: string
  onClose(): void
  onRemove(key: string): void
  onView(picture: Picture): void
  onOpenFile: ((path: string) => void) | null
}) {
  const { c } = useSessionTokens()
  const [shown, setShown] = useState<PendingAttachment | null>(props.item)
  if (props.item && props.item !== shown) setShown(props.item)
  const item = props.item ?? shown
  const size = item?.attachment?.size ?? item?.size ?? null
  const textThumb = item ? readTextThumb(item.attachment?.thumb ?? item.thumb) : null
  const facts = item
    ? [textThumb ? `${textThumb.count} 行` : null, size !== null ? formatBytes(size) : null]
        .filter(Boolean)
        .join(' · ')
    : ''
  const image =
    item && (item.attachment?.type ?? item.source.kind) === 'image'
      ? (item.thumb ?? item.attachment?.thumb ?? (item.source.uri || null))
      : null
  const full = item?.source.kind === 'image' && item.source.uri ? item.source.uri : image
  const pastedText = item?.source.text
  return (
    <BottomSheet
      visible={props.item !== null}
      onClose={props.onClose}
      title={item?.source.name ?? ''}
      message={[facts, props.note].filter(Boolean).join('\n')}
    >
      {image ? (
        <Pressable
          onPress={() => full && props.onView({ thumb: image, full: { uri: full } })}
          accessibilityRole="imagebutton"
          accessibilityLabel={`查看 ${item?.source.name ?? ''}`}
        >
          <Image source={{ uri: image }} style={styles.sheetImage} resizeMode="contain" />
        </Pressable>
      ) : pastedText || textThumb ? (
        <View style={[styles.sheetText, { backgroundColor: c.fill }]}>
          <Text style={[styles.pickerSub, { color: c.text }]} numberOfLines={12}>
            {pastedText ? pastedText.slice(0, 2000) : textThumb!.lines.join('\n')}
          </Text>
        </View>
      ) : null}
      {item?.source.kind === 'project' && props.onOpenFile && (
        <SheetButton
          label="打开文件"
          icon={G.file}
          color={c.text}
          onPress={() => props.onOpenFile!(item.source.uri)}
        />
      )}
      {item && (
        <SheetButton
          label="移除"
          icon={G.trash}
          color={c.danger}
          onPress={() => props.onRemove(item.key)}
        />
      )}
    </BottomSheet>
  )
}

function SheetButton(props: {
  label: string
  icon: (typeof G)[keyof typeof G]
  color: string
  onPress(): void
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.sheetButton,
        { backgroundColor: pressed ? c.fillStrong : c.fill },
      ]}
    >
      <Icon icon={props.icon} size={16} color={props.color} />
      <Text style={[styles.pickerLabel, { color: props.color }]}>{props.label}</Text>
    </Pressable>
  )
}

const TILE = 68
const TRAY_RADIUS = 30

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingTop: 6, gap: 6 },
  tray: {
    borderRadius: TRAY_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    paddingBottom: 6,
  },
  card: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    paddingBottom: 8,
  },
  glassCard: { borderColor: 'transparent', backgroundColor: 'transparent' },
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
  picker: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
    overflow: 'hidden',
  },
  pickerScroll: { maxHeight: 232, paddingVertical: 6 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  pickerText: { flex: 1, minWidth: 0 },
  pickerLabel: { fontSize: 15, fontWeight: '500' },
  pickerSub: { fontSize: 13, lineHeight: 18 },
  pickerHead: { fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 4 },
  pickerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  paste: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 8 },
  pasteButton: { width: 120, height: 32 },
  pastePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 12,
  },
  pasteText: { fontSize: 14, fontWeight: '500' },
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
  textLines: { fontSize: 8, lineHeight: 10 },
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
  sheetImage: { width: '100%', height: 220, borderRadius: 14 },
  sheetText: { borderRadius: 14, padding: 12 },
  sheetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 16,
  },
})

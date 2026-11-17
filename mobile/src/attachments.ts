// What the phone attaches to a message: photos and files read here, photos scaled and re-encoded
// first, then handed to the computer with `attachments.add`. The link sends their bytes ahead as
// a byte stream of their own, and the host keeps each until a message names it.

import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator'
import type { HostLink } from '@shared/remote/link'
import {
  ATTACHMENT_BYTES,
  ATTACHMENT_LIMIT,
  IMAGE_BYTES,
  IMAGE_SIDE,
  PROMPT_BYTES,
  THUMB_SIDE,
  embedsText,
  promptShare,
} from '@shared/attachments'
import type { Attachment, UserContent } from '@shared/thread'

export { ATTACHMENT_LIMIT }

/**
 * Something picked: a photo to re-encode, or a file sent as it is; or a file of the project an `@`
 * mention named, which the host reads itself (`uri` is its path relative to the project then).
 */
export interface PickedSource {
  kind: 'image' | 'file' | 'project' | 'text'
  /** The file's URI; for a pasted text, nothing. */
  uri: string
  name: string
  mimeType: string | null
  size: number | null
  /** For a mention: the project its path is relative to. */
  projectPath?: string
  /** A long paste's text. */
  text?: string
}

/** Has the host attach a file of the project by its path, as the desktop's `@` mention does. */
export async function attachProjectFile(
  link: HostLink,
  projectPath: string,
  path: string,
): Promise<Attachment> {
  try {
    return (await link.request('attachments.add', {
      source: { projectPath, path },
      thumb: null,
    })) as Attachment
  } catch (error) {
    throw new Error(uploadError(error), { cause: error })
  }
}

/** An attachment prepared while the computer was out of reach, kept in the outbox's files. */
export interface LocalCopy {
  /** Its name among the outbox's files, and where it is now. */
  file: string
  uri: string
  mimeType: string
  name: string
  thumb: string | null
  size: number
}

export interface PendingAttachment {
  key: string
  source: PickedSource
  /** `local`: kept on the phone, to go with the message once the computer is reachable. */
  status: 'preparing' | 'waiting' | 'uploading' | 'ready' | 'local' | 'failed'
  /** The prepared bytes kept on the phone, for a `local` file; a project's file needs none. */
  local?: LocalCopy | null
  /** A JPEG data URL for a photo, once it is made. */
  thumb: string | null
  /** The bytes that go, once known. */
  size: number | null
  attachment: Attachment | null
  error: string | null
  /** A draft's attachment the computer no longer holds. */
  gone?: boolean
}

const JPEG_QUALITY = 0.8
const SMALLER_QUALITY = 0.6

// Pictures scaled and re-encoded; a GIF goes as it is, to keep its frames.
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif|avif|bmp|tiff)$/i

/** Whether a picked file is a photo to re-encode rather than send as it is. */
export function isPhoto(mimeType: string | null | undefined): boolean {
  return !!mimeType && IMAGE_TYPES.test(mimeType)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const LIMIT_TEXT = formatBytes(ATTACHMENT_BYTES)

/** A reason to show as it is. */
class Refused extends Error {}

/** Why a file cannot go before it is read, or null. */
export function tooLarge(name: string, size: number | null): string | null {
  if (size === null || size <= ATTACHMENT_BYTES) return null
  return `「${name}」有 ${formatBytes(size)}，超过了单个附件 ${LIMIT_TEXT} 的上限。`
}

interface Prepared {
  bytes: Uint8Array
  mimeType: string
  name: string
  thumb: string | null
}

/** `image` scaled down to fit `side` on its longer edge, or itself when it fits. */
async function fit(image: ImageRef, side: number): Promise<ImageRef> {
  if (Math.max(image.width, image.height) <= side) return image
  const size = image.width >= image.height ? { width: side } : { height: side }
  return ImageManipulator.manipulate(image).resize(size).renderAsync()
}

async function save(image: ImageRef, format: SaveFormat, compress = 1): Promise<Uint8Array> {
  const saved = await image.saveAsync({ format, compress })
  const file = new File(saved.uri)
  try {
    return await file.bytes()
  } finally {
    file.delete()
  }
}

function renamed(name: string, extension: string): string {
  const base = name.replace(/\.[^./]*$/, '')
  return `${base || '图片'}.${extension}`
}

/**
 * A photo fit within the host's side, and its thumbnail. A PNG, such as a screenshot, stays one
 * while it is small enough, so its text stays sharp; anything else becomes JPEG.
 */
async function preparePhoto(source: PickedSource): Promise<Prepared> {
  // Decoded at most this large, so a camera's full resolution never sits in memory.
  const loaded = await ImageManipulator.manipulate(source.uri, {
    maxWidth: IMAGE_SIDE,
    maxHeight: IMAGE_SIDE,
  }).renderAsync()
  const image = await fit(loaded, IMAGE_SIDE)
  const thumbImage = await fit(image, THUMB_SIDE)
  try {
    let bytes: Uint8Array | null = null
    let png = source.mimeType === 'image/png'
    if (png) {
      bytes = await save(image, SaveFormat.PNG)
      if (bytes.byteLength > IMAGE_BYTES) png = false
    }
    if (!png) {
      bytes = await save(image, SaveFormat.JPEG, JPEG_QUALITY)
      if (bytes.byteLength > IMAGE_BYTES)
        bytes = await save(image, SaveFormat.JPEG, SMALLER_QUALITY)
    }
    const thumb = await thumbImage.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.7,
      base64: true,
    })
    new File(thumb.uri).delete()
    return {
      bytes: bytes!,
      mimeType: png ? 'image/png' : 'image/jpeg',
      name: renamed(source.name, png ? 'png' : 'jpg'),
      thumb: thumb.base64 ? `data:image/jpeg;base64,${thumb.base64}` : null,
    }
  } finally {
    for (const ref of new Set([loaded, image, thumbImage])) ref.release()
  }
}

async function prepareText(source: PickedSource): Promise<Prepared> {
  return {
    bytes: new TextEncoder().encode(source.text ?? ''),
    mimeType: 'text/plain',
    name: source.name,
    thumb: null,
  }
}

async function prepareFile(source: PickedSource): Promise<Prepared> {
  const file = new File(source.uri)
  const refused = tooLarge(source.name, file.size ?? source.size)
  if (refused) throw new Refused(refused)
  return {
    bytes: await file.bytes(),
    mimeType: source.mimeType || 'application/octet-stream',
    name: source.name,
    thumb: null,
  }
}

/** Reads and, for a photo, re-encodes what was picked; throws with a message to show. */
export async function prepare(source: PickedSource): Promise<Prepared> {
  let prepared: Prepared
  try {
    prepared =
      source.kind === 'image'
        ? await preparePhoto(source)
        : source.kind === 'text'
          ? await prepareText(source)
          : await prepareFile(source)
  } catch (error) {
    if (error instanceof Refused) throw error
    console.warn(`Could not read ${source.name}`, error)
    const what = source.kind === 'image' ? '这张图片' : '这个文件'
    throw new Error(`没能读取「${source.name}」${what}。`, { cause: error })
  }
  const refused = tooLarge(prepared.name, prepared.bytes.byteLength)
  if (refused) throw new Refused(refused)
  return prepared
}

/** Hands the prepared bytes to the host, which answers with its record of them. */
export async function upload(link: HostLink, prepared: Prepared): Promise<Attachment> {
  try {
    return (await link.request('attachments.add', {
      source: { bytes: prepared.bytes, mimeType: prepared.mimeType, name: prepared.name },
      thumb: prepared.thumb,
    })) as Attachment
  } catch (error) {
    throw new Error(uploadError(error), { cause: error })
  }
}

/** A failed request's reason in words a person reads. */
export function uploadError(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  if (code === 'host_restarted' || message?.includes('connection ended')) {
    return '和电脑的连接断开了，请重试。'
  }
  if (code === 'busy') return '电脑正忙，请稍后重试。'
  if (message?.includes('at most')) return `附件太大了，单个最多 ${LIMIT_TEXT}。`
  if (message?.includes('UTF-8')) return '这个文本文件不是 UTF-8 编码，没法发送。'
  return message ? `上传失败：${message}` : '上传失败，请重试。'
}

/** Why the attachments keep a message from going, or null. */
export function sendBlock(items: readonly PendingAttachment[], text: string): string | null {
  if (items.some((item) => item.status === 'failed')) return '有附件没传上去，请重试或移除。'
  if (items.some((item) => item.status !== 'ready')) return null
  const bytes = items.reduce(
    (sum, item) => sum + (item.attachment ? promptShare(item.attachment) : 0),
    new TextEncoder().encode(text).byteLength,
  )
  if (bytes > PROMPT_BYTES) {
    return `附件加起来太大了，一条消息最多约 ${formatBytes(PROMPT_BYTES)}，请移除一些。`
  }
  return null
}

/** What the agent's prompts take, as its capabilities say; unknown until it has started. */
export interface Takes {
  images: boolean
  text: boolean
}

/** How an attachment goes to the agent, as the desktop's tile says it. */
export function sentNote(item: PendingAttachment, takes: Takes | null, agent: string): string {
  if (item.status === 'failed') {
    return item.gone ? '为这份草稿保存的副本已不在，请移除后重新添加。' : (item.error ?? '无法读取')
  }
  if (item.status === 'local') return '已存在手机上，连上电脑后随消息发送'
  if (item.status !== 'ready') return '正在添加…'
  const kind = item.attachment?.type ?? (item.source.kind === 'image' ? 'image' : 'file')
  if (kind === 'text') return takes?.text === false ? '作为文本接在消息之后发送' : '连同内容发送'
  if (kind === 'image') {
    return takes?.images === false
      ? `${agent} 不接受图片，会收到文件链接，可用它自己的工具打开。`
      : '以图片发送'
  }
  if (item.attachment && embedsText(item.attachment) && takes?.text !== false) return '连同内容发送'
  return `以链接发送，${agent} 会用它自己的工具读取。`
}

/** The next free number of a pasted kind's names: 「粘贴的文本 2」「图片 3」. */
export function nextNumber(items: readonly PendingAttachment[], prefix: string): number {
  let most = 0
  for (const item of items) {
    const match = new RegExp(`^${prefix} (\\d+)`).exec(item.source.name)
    if (match) most = Math.max(most, Number(match[1]))
  }
  return most + 1
}

/** The message's content: the text, then the attachments in the order they were added. */
export function messageContent(text: string, items: readonly PendingAttachment[]): UserContent[] {
  return [
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
    ...items.flatMap((item): UserContent[] =>
      item.attachment
        ? [{ type: 'ref', ref: { kind: 'attachment', attachment: item.attachment } }]
        : [],
    ),
  ]
}

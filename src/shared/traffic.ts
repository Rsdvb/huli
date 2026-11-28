// Huli: the network traffic an agent's requests to its model make, estimated from the tokens it
// reports and the images its context holds. Every request uploads the whole context again (prompt
// caching saves money, not bytes), so a long session's traffic grows with its context times its
// requests. Neither the Claude Agent SDK nor Codex's app-server tells the sizes of the requests
// themselves, so this is an estimate: the clients show it as approximate.
//
// The model. A request uploads the context's text as JSON, about UPLOAD_BYTES_PER_TOKEN bytes a
// token, and every image the context still holds as base64. The agents count an image as about
// IMAGE_TOKENS tokens whatever its size, while a screenshot is hundreds of KB of base64, so the
// tokens alone miss most of such a request: measured through a proxy, hours with screenshots in
// context sent 20 to 47 bytes per input token, against 3 to 4 for text. So one request uploads
// about
//
//   max(0, tokens - images * IMAGE_TOKENS) * UPLOAD_BYTES_PER_TOKEN + the images' base64 bytes
//
// the images' tokens taken out of the text so they do not count twice. A session's upload is that
// summed over its requests: all its input tokens, cached or not, less IMAGE_TOKENS for each image a
// counted request carried, times four, plus those images' bytes (ContextImages.sent, sentBytes).
// An image stays in the context, and goes up with every request, until the agent's compaction
// drops it, or another agent takes the session over from its text.

import type {
  ContentRef,
  ContextImages,
  Patch,
  SessionUsage,
  ThreadEntry,
  TokenTotals,
} from './thread'
import type { TokenParts } from './usage'

/** A request body's bytes per input token: about four characters of text, sent as JSON. */
export const UPLOAD_BYTES_PER_TOKEN = 4
/**
 * A streamed reply's bytes per output token: its text and the events that frame it, each a few
 * tokens wrapped in about a hundred bytes of JSON.
 */
export const DOWNLOAD_BYTES_PER_TOKEN = 16
/**
 * The tokens a model counts for one image: about what Claude counts for a screenshot it scales
 * down to its limit, which most images an agent takes reach.
 */
export const IMAGE_TOKENS = 1600

/** Bytes sent to the model and received from it. */
export interface Traffic {
  up: number
  down: number
}

/** The size of `bytes` of data as base64. */
export function base64Size(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 3) * 4
}

export function tokenTraffic(input: number, output: number): Traffic {
  return {
    up: Math.max(0, input) * UPLOAD_BYTES_PER_TOKEN,
    down: Math.max(0, output) * DOWNLOAD_BYTES_PER_TOKEN,
  }
}

/**
 * A session's traffic so far, from its token totals and the images its counted requests carried:
 * all input of every request, cached or not, went up, and its output came down. Null for an agent
 * that reports no totals.
 */
export function sessionTraffic(
  tokens: TokenTotals | null | undefined,
  images?: Pick<ContextImages, 'sent' | 'sentBytes'> | null,
): Traffic | null {
  if (!tokens) return null
  const input = tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
  if (input <= 0 && tokens.output <= 0) return null
  const traffic = tokenTraffic(input - (images?.sent ?? 0) * IMAGE_TOKENS, tokens.output)
  return { up: traffic.up + Math.max(0, images?.sentBytes ?? 0), down: traffic.down }
}

/** The traffic of a sum of the usage page's rows, with the images rows of a newer host carry. */
export function partsTraffic(
  parts: Pick<
    TokenParts,
    'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'images' | 'imageBytes'
  >,
): Traffic {
  const input = parts.input + parts.cacheRead + parts.cacheWrite
  const traffic = tokenTraffic(input - (parts.images ?? 0) * IMAGE_TOKENS, parts.output)
  return { up: traffic.up + Math.max(0, parts.imageBytes ?? 0), down: traffic.down }
}

/** What one request uploads, by its parts. */
export interface RequestSize {
  /** The context's text, the images' tokens taken out. */
  text: number
  /** The images' base64. */
  images: number
  /** How many images. */
  count: number
}

/** What one request uploads with the context at `used` tokens and these images in it. */
export function requestSize(
  used: number,
  images?: Pick<ContextImages, 'count' | 'bytes'> | null,
): RequestSize {
  const count = Math.max(0, images?.count ?? 0)
  const text = Math.max(0, Math.max(0, used) - count * IMAGE_TOKENS) * UPLOAD_BYTES_PER_TOKEN
  return { text, images: Math.max(0, images?.bytes ?? 0), count }
}

/** What one request uploads with the context at `used` tokens, in all. */
export function requestUpload(
  used: number,
  images?: Pick<ContextImages, 'count' | 'bytes'> | null,
): number {
  const size = requestSize(used, images)
  return size.text + size.images
}

/** Whether the images are at least half of what each request uploads, so compacting saves most. */
export function imagesDominate(
  used: number,
  images: Pick<ContextImages, 'count' | 'bytes'> | null | undefined,
): boolean {
  const size = requestSize(used, images)
  return size.count > 0 && size.images > 0 && size.images >= size.text
}

/** A context this large is large whatever the window. */
export const LARGE_CONTEXT_TOKENS = 300_000
/** Or a context that fills this share of its window... */
export const LARGE_CONTEXT_SHARE = 0.6
/** ...once it holds this many tokens, so a small window's context does not count as large. */
export const LARGE_CONTEXT_FLOOR = 100_000
/** Or one whose images make each request upload this much, however few its tokens. */
export const LARGE_REQUEST_BYTES = 2_000_000

/** Whether the session's context is large enough that each request uploads a lot. */
export function largeContext(
  usage: Pick<SessionUsage, 'used' | 'size'> | null | undefined,
  images?: Pick<ContextImages, 'count' | 'bytes'> | null,
): boolean {
  if (images && images.count > 0 && requestUpload(usage?.used ?? 0, images) >= LARGE_REQUEST_BYTES)
    return true
  if (!usage || !(usage.used > 0)) return false
  if (usage.used >= LARGE_CONTEXT_TOKENS) return true
  return (
    usage.size > 0 &&
    usage.used >= LARGE_CONTEXT_FLOOR &&
    usage.used >= usage.size * LARGE_CONTEXT_SHARE
  )
}

// The images in the context, from the thread.

/** The bytes of an image the thread store keeps, as stored, by its hash; undefined when unknown. */
export type StoredSize = (hash: string) => number | undefined

/** What one ref uploads as an image: its base64 bytes, 0 when unknown, or null for no image. */
function refImage(ref: ContentRef, storedSize: StoredSize): number | null {
  if (ref.kind === 'image') {
    if ('data' in ref) return ref.data.length
    const size = storedSize(ref.blob)
    return size === undefined ? 0 : base64Size(size)
  }
  // What the user attached went as an image block, the bytes its record says were sent.
  if (ref.kind === 'attachment' && ref.attachment.sent === 'image') {
    return ref.attachment.size === null ? 0 : base64Size(ref.attachment.size)
  }
  return null
}

/** Calls `visit` with the base64 bytes of each image the entry holds, as `refImage` reads them. */
function eachImage(entry: ThreadEntry, storedSize: StoredSize, visit: (bytes: number) => void) {
  const look = (ref: ContentRef) => {
    const bytes = refImage(ref, storedSize)
    if (bytes !== null) visit(bytes)
  }
  switch (entry.kind) {
    case 'user':
    case 'session_message':
    case 'tool':
      for (const item of entry.content) if (item.type === 'ref') look(item.ref)
      break
    case 'agent':
      for (const ref of entry.attachments) look(ref)
      break
  }
}

const noSizes: StoredSize = () => undefined

function holdsImage(entry: ThreadEntry | undefined): boolean {
  if (!entry) return false
  let found = false
  eachImage(entry, noSizes, () => {
    found = true
  })
  return found
}

/** The thread as the host or a client holds it, in order. */
export interface ThreadOrder {
  order: readonly string[]
  byId: Readonly<Record<string, ThreadEntry>>
}

/**
 * The images the agent's context holds now: those of the prompts, tool results and replies since
 * its latest completed compaction, or since another agent took it over from the text.
 */
export function imagesInContext(
  thread: ThreadOrder,
  storedSize: StoredSize,
): Pick<ContextImages, 'count' | 'bytes'> {
  let count = 0
  let bytes = 0
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (!entry) continue
    if (entry.kind === 'compaction' && entry.status === 'completed') break
    if (entry.kind === 'takeover') break
    eachImage(entry, storedSize, (size) => {
      count++
      bytes += size
    })
  }
  return { count, bytes }
}

/**
 * Whether `patch` may change the images in the context, applied to `thread` as it stands before
 * it: one that adds or changes an image, a compaction, or takes entries away.
 */
export function touchesImages(thread: Pick<ThreadOrder, 'byId'>, patch: Patch): boolean {
  switch (patch.op) {
    case 'entry.add': {
      const { entry } = patch
      if (entry.kind === 'compaction' || entry.kind === 'takeover') return true
      return holdsImage(entry) || holdsImage(thread.byId[entry.id])
    }
    case 'entry.update': {
      const entry = thread.byId[patch.id]
      if (!entry) return false
      if (entry.kind === 'compaction') return 'status' in patch.changes
      if (!('content' in patch.changes) && !('attachments' in patch.changes)) return false
      return holdsImage(entry) || holdsImage({ ...entry, ...patch.changes } as ThreadEntry)
    }
    case 'entry.remove':
    case 'thread.truncate':
    case 'thread.reset':
      return true
    default:
      return false
  }
}

/** The images of a session with nothing counted yet. */
export const NO_IMAGES: ContextImages = { count: 0, bytes: 0, sent: 0, sentBytes: 0 }

/** The figures after one more request, which carried the images in the context now. */
export function imagesSent(images: ContextImages): ContextImages {
  if (images.count === 0) return images
  return {
    ...images,
    sent: images.sent + images.count,
    sentBytes: images.sentBytes + images.bytes,
  }
}

/** Whether a stored value is a session's images, as the host keeps them with its view. */
export function isContextImages(value: unknown): value is ContextImages {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return ['count', 'bytes', 'sent', 'sentBytes'].every(
    (key) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= 0,
  )
}

import { describe, expect, it } from 'vitest'
import type { Attachment, ContentRef, ThreadEntry } from './thread'
import {
  DOWNLOAD_BYTES_PER_TOKEN,
  IMAGE_TOKENS,
  imagesDominate,
  imagesInContext,
  imagesSent,
  isContextImages,
  largeContext,
  partsTraffic,
  requestSize,
  requestUpload,
  sessionTraffic,
  touchesImages,
  UPLOAD_BYTES_PER_TOKEN,
} from './traffic'

describe('traffic estimated from the tokens an agent reports', () => {
  it('counts every request’s whole input as uploaded, cached or not, and the output as downloaded', () => {
    // Fifty requests at 900K tokens of context, nearly all read from the cache.
    const traffic = sessionTraffic({
      total: 45_120_000,
      input: 50_000,
      cacheRead: 44_900_000,
      cacheWrite: 50_000,
      output: 120_000,
      thought: 30_000,
    })
    expect(traffic).toEqual({
      up: 45_000_000 * UPLOAD_BYTES_PER_TOKEN,
      down: 120_000 * DOWNLOAD_BYTES_PER_TOKEN,
    })
    // About 180 MB up for one long turn: the cache saves money, not bytes.
    expect(traffic!.up).toBe(180_000_000)
  })

  it('takes an agent that reports no cache, and none for one that reports no totals', () => {
    expect(
      sessionTraffic({
        total: 1_100,
        input: 1_000,
        cacheRead: null,
        cacheWrite: null,
        output: 100,
        thought: null,
      }),
    ).toEqual({ up: 4_000, down: 1_600 })
    expect(sessionTraffic(null)).toBeNull()
    expect(sessionTraffic(undefined)).toBeNull()
    expect(
      sessionTraffic({ total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thought: 0 }),
    ).toBeNull()
  })

  it('sums the usage page’s rows the same way', () => {
    expect(partsTraffic({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 })).toEqual({
      up: 400,
      down: 80,
    })
  })

  it('uploads the whole context with each request', () => {
    expect(requestUpload(900_000)).toBe(3_600_000)
    expect(requestUpload(-1)).toBe(0)
  })
})

describe('a large context', () => {
  it('is 300K tokens, or 60% of the window once it holds 100K', () => {
    expect(largeContext({ used: 300_000, size: 1_000_000 })).toBe(true)
    expect(largeContext({ used: 299_999, size: 1_000_000 })).toBe(false)
    expect(largeContext({ used: 160_000, size: 256_000 })).toBe(true)
    expect(largeContext({ used: 150_000, size: 256_000 })).toBe(false)
    // A small window's context is never large on its share alone.
    expect(largeContext({ used: 90_000, size: 128_000 })).toBe(false)
    expect(largeContext({ used: 120_000, size: 200_000 })).toBe(true)
  })

  it('is not one the agent has not reported', () => {
    expect(largeContext(null)).toBe(false)
    expect(largeContext({ used: 0, size: 0 })).toBe(false)
    expect(largeContext({ used: 400_000, size: 0 })).toBe(true)
    expect(largeContext({ used: 150_000, size: 0 })).toBe(false)
  })
})

describe('images in the context', () => {
  const thread = (...entries: ThreadEntry[]) => ({
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  })
  const shot = (id: string, ref: ContentRef): ThreadEntry => ({
    kind: 'tool',
    id,
    title: 'Take a screenshot',
    toolKind: 'other',
    status: 'completed',
    content: [
      { type: 'markdown', markdown: 'The page.' },
      { type: 'ref', ref },
    ],
    locations: [],
    permission: null,
    permissionResult: null,
  })
  const attached = (id: string, size: number, sent: Attachment['sent']): ThreadEntry => ({
    kind: 'user',
    id,
    content: [
      { type: 'text', text: 'Look at this' },
      {
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: {
            id: `a-${id}`,
            type: 'image',
            name: 'Image 1',
            uri: null,
            mimeType: 'image/png',
            size,
            sent,
            thumb: null,
            blob: null,
          },
        },
      },
    ],
  })
  const reply = (id: string): ThreadEntry => ({
    kind: 'agent',
    id,
    markdown: 'Done.',
    attachments: [],
    streaming: false,
  })
  const compaction = (id: string, status: 'completed' | 'failed'): ThreadEntry => ({
    kind: 'compaction',
    id,
    status,
    summary: 'We looked at the screens.',
  })
  const BLOB = 'a'.repeat(64)
  const sizes = (hash: string) => (hash === BLOB ? 600_000 : undefined)
  const png = (data: string): ContentRef => ({ kind: 'image', mimeType: 'image/png', data })

  it('counts the attached, read and stored images by their base64', () => {
    const images = imagesInContext(
      thread(
        attached('u1', 300_000, 'image'),
        shot('t1', png('A'.repeat(400_000))),
        shot('t2', { kind: 'image', mimeType: 'image/png', blob: BLOB }),
        reply('r1'),
      ),
      sizes,
    )
    expect(images).toEqual({ count: 3, bytes: 400_000 + 400_000 + 800_000 })
  })

  it('counts an image of unknown size without bytes, and none that went as a link', () => {
    const images = imagesInContext(
      thread(
        attached('u1', 300_000, 'linked'),
        shot('t1', { kind: 'image', mimeType: 'image/png', blob: 'b'.repeat(64) }),
      ),
      sizes,
    )
    expect(images).toEqual({ count: 1, bytes: 0 })
  })

  it('drops what a completed compaction or a takeover left behind', () => {
    const before = shot('t1', png('A'.repeat(1000)))
    const after = shot('t2', png('A'.repeat(200)))
    expect(imagesInContext(thread(before, compaction('c1', 'completed'), after), sizes)).toEqual({
      count: 1,
      bytes: 200,
    })
    // A compaction that did not finish dropped nothing.
    expect(imagesInContext(thread(before, compaction('c1', 'failed'), after), sizes)).toEqual({
      count: 2,
      bytes: 1200,
    })
    const takeover: ThreadEntry = {
      kind: 'takeover',
      id: 'k1',
      agentId: 'codex',
      turns: 1,
      omitted: 0,
      carried: 'the conversation as text',
      after: null,
    }
    expect(imagesInContext(thread(before, takeover), sizes)).toEqual({ count: 0, bytes: 0 })
  })

  it('finds none in a thread of text', () => {
    expect(imagesInContext(thread(attached('u1', 10, null), reply('r1')), sizes)).toEqual({
      count: 0,
      bytes: 0,
    })
    expect(imagesInContext(thread(), sizes)).toEqual({ count: 0, bytes: 0 })
  })

  it('looks again only for a patch that can change them', () => {
    const state = thread(reply('r1'), compaction('c1', 'completed'), attached('u1', 10, null))
    const image = shot('t1', png('AAAA'))
    const content = image.kind === 'tool' ? image.content : []
    expect(touchesImages(state, { op: 'entry.add', entry: image })).toBe(true)
    expect(touchesImages(state, { op: 'entry.add', entry: reply('r2') })).toBe(false)
    expect(touchesImages(state, { op: 'entry.add', entry: compaction('c2', 'failed') })).toBe(true)
    expect(touchesImages(state, { op: 'entry.appendText', id: 'r1', text: 'more' })).toBe(false)
    expect(
      touchesImages(state, { op: 'entry.update', id: 'c1', changes: { status: 'failed' } }),
    ).toBe(true)
    expect(touchesImages(state, { op: 'entry.update', id: 'u1', changes: { content } })).toBe(true)
    expect(touchesImages(state, { op: 'entry.update', id: 'u1', changes: { at: 1 } })).toBe(false)
    expect(touchesImages(state, { op: 'entry.remove', ids: ['r1'] })).toBe(true)
    expect(touchesImages(state, { op: 'session.update', changes: { title: 'x' } })).toBe(false)
  })
})

describe('traffic with images in the context', () => {
  // Seven screenshots of 400 KB of base64 each, in a context of 20K tokens.
  const images = { count: 7, bytes: 2_800_000, sent: 0, sentBytes: 0 }

  it('uploads the images with each request, their tokens out of the text', () => {
    expect(requestSize(20_000, images)).toEqual({
      text: (20_000 - 7 * IMAGE_TOKENS) * UPLOAD_BYTES_PER_TOKEN,
      images: 2_800_000,
      count: 7,
    })
    expect(requestUpload(20_000, images)).toBe(35_200 + 2_800_000)
    // Tokens below the images' share leave no text, never less.
    expect(requestSize(1_000, images).text).toBe(0)
    expect(imagesDominate(20_000, images)).toBe(true)
    expect(imagesDominate(800_000, { count: 1, bytes: 400_000 })).toBe(false)
  })

  it('is the tokens alone without images', () => {
    expect(requestSize(900_000, null)).toEqual({ text: 3_600_000, images: 0, count: 0 })
    expect(requestUpload(900_000, { count: 0, bytes: 0 })).toBe(requestUpload(900_000))
    expect(imagesDominate(900_000, null)).toBe(false)
  })

  it('makes a small context large once its images make each request large', () => {
    expect(largeContext({ used: 20_000, size: 200_000 }, images)).toBe(true)
    expect(largeContext({ used: 20_000, size: 200_000 }, { count: 2, bytes: 800_000 })).toBe(false)
    expect(largeContext({ used: 20_000, size: 200_000 })).toBe(false)
    // An agent that reports no context yet.
    expect(largeContext(null, images)).toBe(true)
  })

  it('adds what each counted request carried to the session, the tokens counted once', () => {
    let counted = { ...images }
    for (let i = 0; i < 10; i++) counted = imagesSent(counted)
    expect(counted).toMatchObject({ sent: 70, sentBytes: 28_000_000 })
    const tokens = {
      total: 300_000,
      input: 10_000,
      cacheRead: 280_000,
      cacheWrite: 5_000,
      output: 5_000,
      thought: null,
    }
    expect(sessionTraffic(tokens, counted)).toEqual({
      up: (295_000 - 70 * IMAGE_TOKENS) * UPLOAD_BYTES_PER_TOKEN + 28_000_000,
      down: 5_000 * DOWNLOAD_BYTES_PER_TOKEN,
    })
    // Images whose tokens the totals do not hold, as from before the counts began, take no text.
    expect(sessionTraffic({ ...tokens, cacheRead: 0, cacheWrite: 0 }, counted)!.up).toBe(28_000_000)
    expect(sessionTraffic(tokens, null)).toEqual(sessionTraffic(tokens))
  })

  it('keeps the counts after a compaction dropped the images', () => {
    const counted = imagesSent(images)
    const compacted = { ...counted, count: 0, bytes: 0 }
    expect(imagesSent(compacted)).toBe(compacted)
    expect(compacted).toMatchObject({ sent: 7, sentBytes: 2_800_000 })
    expect(requestUpload(4_000, compacted)).toBe(16_000)
  })

  it('sums the usage rows that carry images the same way', () => {
    expect(
      partsTraffic({
        input: 100,
        cacheRead: 9_900,
        cacheWrite: 0,
        output: 10,
        images: 3,
        imageBytes: 1_200_000,
      }),
    ).toEqual({ up: (10_000 - 3 * IMAGE_TOKENS) * 4 + 1_200_000, down: 160 })
  })

  it('takes only whole counts as a stored value', () => {
    expect(isContextImages({ count: 1, bytes: 2, sent: 3, sentBytes: 4 })).toBe(true)
    expect(isContextImages({ count: 1, bytes: 2, sent: 3 })).toBe(false)
    expect(isContextImages({ count: -1, bytes: 2, sent: 3, sentBytes: 4 })).toBe(false)
    expect(isContextImages(null)).toBe(false)
  })
})

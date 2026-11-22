// Huli: a window's screenshot that came back as one solid color, as a minimized, protected or
// elevated window's often does, and the picture that stands in for it, so neither the agent nor
// the thread shows an empty frame as if it were the window.

import { promisify } from 'node:util'
import { deflate, inflate } from 'node:zlib'

const inflateAsync = promisify(inflate)
const deflateAsync = promisify(deflate)

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Larger pictures are not checked: a window's screenshot is far smaller. */
const MAX_PIXELS = 40_000_000
/** How far a channel may stray from the first pixel's and still count as the same color. */
const TOLERANCE = 6

/**
 * Whether a PNG is one solid color, or wholly transparent: true or false, or null for a picture
 * this does not read (another format, depth or interlacing).
 */
export async function isBlankPng(data: Buffer): Promise<boolean | null> {
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE)) return null
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const parts: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (body.length !== length) return null
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const color = body[9]
      const interlace = body[12]
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null
      channels = color === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      parts.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!width || !height || !channels || width * height > MAX_PIXELS) return null
  let raw: Buffer
  try {
    raw = await inflateAsync(Buffer.concat(parts))
  } catch {
    return null
  }
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  let previous = Buffer.alloc(stride)
  let row = Buffer.alloc(stride)
  const first = Buffer.alloc(channels)
  let transparent = channels === 4
  let solid = true
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    const filter = raw[start]
    for (let x = 0; x < stride; x++) {
      const value = raw[start + 1 + x]!
      const left = x >= channels ? row[x - channels]! : 0
      const up = previous[x]!
      const corner = x >= channels ? previous[x - channels]! : 0
      row[x] = (value + predict(filter!, left, up, corner)) & 0xff
    }
    if (y === 0) row.copy(first, 0, 0, channels)
    for (let x = 0; x < stride; x += channels) {
      if (transparent && row[x + 3] !== 0) transparent = false
      if (solid) {
        for (let c = 0; c < channels; c++) {
          if (Math.abs(row[x + c]! - first[c]!) > TOLERANCE) {
            solid = false
            break
          }
        }
      }
      if (!solid && !transparent) return false
    }
    ;[previous, row] = [row, previous]
  }
  return true
}

function predict(filter: number, left: number, up: number, corner: number): number {
  switch (filter) {
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4: {
      const p = left + up - corner
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - corner)
      return pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
    }
    default:
      return 0
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

const PLACEHOLDER = { width: 320, height: 200 }
let placeholder: Promise<string> | null = null

/**
 * The picture that stands in for a screenshot that is blank or missing, as base64 PNG: a grey
 * frame with a picture crossed out, with no words, so it reads the same in every language.
 */
export function placeholderPng(): Promise<string> {
  placeholder ??= drawPlaceholder()
  return placeholder
}

async function drawPlaceholder(): Promise<string> {
  const { width, height } = PLACEHOLDER
  const background = 0xe4
  const ink = 0x8c
  const raw = Buffer.alloc((width * 3 + 1) * height, background)
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    raw.fill(ink, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 1 + x * 3 + 3)
  }
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0
  // A picture's frame, a hill and a sun, crossed out.
  const box = { left: 110, top: 60, right: 210, bottom: 140 }
  for (let t = 0; t < 4; t++) {
    for (let x = box.left; x <= box.right; x++) {
      set(x, box.top + t)
      set(x, box.bottom - t)
    }
    for (let y = box.top; y <= box.bottom; y++) {
      set(box.left + t, y)
      set(box.right - t, y)
    }
  }
  for (let x = box.left + 4; x <= box.right - 4; x++) {
    const hill = box.bottom - 6 - Math.round(28 * Math.max(0, 1 - Math.abs(x - 150) / 40))
    for (let y = hill; y < box.bottom - 3; y++) set(x, y)
  }
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 8; x++) if (x * x + y * y <= 64) set(185 + x, 85 + y)
  }
  for (let i = -6; i <= 6; i++) {
    for (let s = 0; s <= 120; s++) set(100 + s + i / 2, 50 + Math.round(s * 0.83) + i / 2)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', await deflateAsync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

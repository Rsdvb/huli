import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isBlankPng, placeholderPng } from './screenshot'

/** The rows of an 8-bit RGB or RGBA PNG's image data, each with its filter byte first. */
function idat(png: Buffer): { width: number; height: number; channels: number; raw: Buffer } {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const parts: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 6 ? 4 : 3
    }
    if (type === 'IDAT') parts.push(body)
    offset += 12 + length
  }
  return { width, height, channels, raw: inflateSync(Buffer.concat(parts)) }
}

function png(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    rows.push(0)
    for (let x = 0; x < width; x++) rows.push(...pixel(x, y))
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    // isBlankPng reads no CRC, so any will do here.
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('Huli: screenshots', () => {
  it('tells a one-color or transparent screenshot from a window', async () => {
    expect(await isBlankPng(png(8, 6, () => [0, 0, 0, 255]))).toBe(true)
    expect(await isBlankPng(png(8, 6, (x) => [x * 30, 0, 0, 0]))).toBe(true)
    expect(
      await isBlankPng(
        png(8, 6, (x, y) => (x === 7 && y === 5 ? [200, 0, 0, 255] : [0, 0, 0, 255])),
      ),
    ).toBe(false)
    expect(await isBlankPng(Buffer.from('not a picture'))).toBeNull()
  })

  it('stands in a well-formed picture for a blank one, which models take', async () => {
    const data = Buffer.from(await placeholderPng(), 'base64')
    const { width, height, channels, raw } = idat(data)
    expect(raw.length).toBe((width * channels + 1) * height)
    for (let y = 0; y < height; y++) expect(raw[y * (width * channels + 1)]).toBe(0)
    expect(await isBlankPng(data)).toBe(false)
  })
})

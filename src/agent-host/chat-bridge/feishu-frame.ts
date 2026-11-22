// Huli: the frames of Feishu's long connection, which no page of its documentation describes: the
// `pbbp2.Frame` protobuf its official SDKs speak (github.com/larksuite/node-sdk, MIT, and
// github.com/larksuite/oapi-sdk-go `ws`), encoded and decoded here by hand, since it is one small
// message. Fields 1 to 4 are proto2 `required` and always written, as the SDKs' decoders insist.

export interface FrameHeader {
  key: string
  value: string
}

export interface Frame {
  seqId: bigint
  logId: bigint
  service: number
  /** 0 for a control frame (ping, pong), 1 for data (an event or a callback). */
  method: number
  headers: FrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

export const METHOD_CONTROL = 0
export const METHOD_DATA = 1

const VARINT = 0
const LEN = 2

class Writer {
  private readonly bytes: number[] = []

  varint(value: bigint): void {
    let rest = BigInt.asUintN(64, value)
    while (rest > 0x7fn) {
      this.bytes.push(Number(rest & 0x7fn) | 0x80)
      rest >>= 7n
    }
    this.bytes.push(Number(rest))
  }

  tag(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire))
  }

  raw(data: Uint8Array): void {
    this.varint(BigInt(data.length))
    for (const byte of data) this.bytes.push(byte)
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function encodeHeader(header: FrameHeader): Uint8Array {
  const writer = new Writer()
  writer.tag(1, LEN)
  writer.raw(encoder.encode(header.key))
  writer.tag(2, LEN)
  writer.raw(encoder.encode(header.value))
  return writer.done()
}

export function encodeFrame(frame: Frame): Uint8Array {
  const writer = new Writer()
  writer.tag(1, VARINT)
  writer.varint(frame.seqId)
  writer.tag(2, VARINT)
  writer.varint(frame.logId)
  writer.tag(3, VARINT)
  // An int32 is written as its 64-bit two's complement when negative.
  writer.varint(BigInt(frame.service))
  writer.tag(4, VARINT)
  writer.varint(BigInt(frame.method))
  for (const header of frame.headers) {
    writer.tag(5, LEN)
    writer.raw(encodeHeader(header))
  }
  if (frame.payloadEncoding !== undefined) {
    writer.tag(6, LEN)
    writer.raw(encoder.encode(frame.payloadEncoding))
  }
  if (frame.payloadType !== undefined) {
    writer.tag(7, LEN)
    writer.raw(encoder.encode(frame.payloadType))
  }
  if (frame.payload !== undefined) {
    writer.tag(8, LEN)
    writer.raw(frame.payload)
  }
  if (frame.logIdNew !== undefined) {
    writer.tag(9, LEN)
    writer.raw(encoder.encode(frame.logIdNew))
  }
  return writer.done()
}

class Reader {
  private at = 0

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length
  }

  varint(): bigint {
    let value = 0n
    let shift = 0n
    for (;;) {
      if (this.at >= this.bytes.length) throw new Error('The frame ends inside a number')
      const byte = this.bytes[this.at++]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += 7n
      if (shift > 63n) throw new Error('A number in the frame is too long')
    }
  }

  slice(): Uint8Array {
    const length = Number(this.varint())
    if (length > this.bytes.length - this.at) throw new Error('The frame ends inside a field')
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }

  skip(wire: number): void {
    if (wire === VARINT) this.varint()
    else if (wire === LEN) this.slice()
    else if (wire === 1) this.at += 8
    else if (wire === 5) this.at += 4
    else throw new Error(`The frame has a field of wire type ${wire}`)
    if (this.at > this.bytes.length) throw new Error('The frame ends inside a field')
  }
}

function decodeHeader(bytes: Uint8Array): FrameHeader {
  const reader = new Reader(bytes)
  let key = ''
  let value = ''
  while (!reader.done) {
    const tag = Number(reader.varint())
    const field = tag >>> 3
    const wire = tag & 7
    if (field === 1 && wire === LEN) key = decoder.decode(reader.slice())
    else if (field === 2 && wire === LEN) value = decoder.decode(reader.slice())
    else reader.skip(wire)
  }
  return { key, value }
}

/** A frame from its bytes; throws for bytes that are not one. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const reader = new Reader(bytes)
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  const seen = new Set<number>()
  while (!reader.done) {
    const tag = Number(reader.varint())
    const field = tag >>> 3
    const wire = tag & 7
    seen.add(field)
    if (field >= 1 && field <= 4 && wire === VARINT) {
      const value = reader.varint()
      if (field === 1) frame.seqId = value
      else if (field === 2) frame.logId = value
      else if (field === 3) frame.service = Number(BigInt.asIntN(32, value))
      else frame.method = Number(BigInt.asIntN(32, value))
    } else if (field === 5 && wire === LEN) frame.headers.push(decodeHeader(reader.slice()))
    else if (field === 6 && wire === LEN) frame.payloadEncoding = decoder.decode(reader.slice())
    else if (field === 7 && wire === LEN) frame.payloadType = decoder.decode(reader.slice())
    else if (field === 8 && wire === LEN) frame.payload = reader.slice()
    else if (field === 9 && wire === LEN) frame.logIdNew = decoder.decode(reader.slice())
    else reader.skip(wire)
  }
  for (const required of [1, 2, 3, 4]) {
    if (!seen.has(required)) throw new Error(`The frame has no field ${required}`)
  }
  return frame
}

export function header(frame: Frame, key: string): string | undefined {
  return frame.headers.find((each) => each.key === key)?.value
}

/** Puts back together the parts of a payload Feishu sent in several frames, by message id. */
export class FrameParts {
  private readonly parts = new Map<string, { slots: (Uint8Array | null)[]; at: number }>()

  constructor(
    private readonly keepMs = 10_000,
    private readonly maxMessages = 100,
  ) {}

  /** The whole payload once every part is in; null while some are missing or for a bad part. */
  add(frame: Frame, now: number): Uint8Array | null {
    const payload = frame.payload ?? new Uint8Array()
    const sum = Number(header(frame, 'sum') ?? '1')
    const seq = Number(header(frame, 'seq') ?? '0')
    if (!Number.isInteger(sum) || sum < 1 || sum > 1000) return null
    if (sum === 1) return payload
    if (!Number.isInteger(seq) || seq < 0 || seq >= sum) return null
    const id = header(frame, 'message_id')
    if (!id) return null
    for (const [key, entry] of this.parts) {
      if (now - entry.at > this.keepMs) this.parts.delete(key)
    }
    let entry = this.parts.get(id)
    if (!entry || entry.slots.length !== sum) {
      entry = { slots: new Array<Uint8Array | null>(sum).fill(null), at: now }
      this.parts.set(id, entry)
      if (this.parts.size > this.maxMessages) this.parts.delete(this.parts.keys().next().value!)
    }
    entry.slots[seq] = payload
    if (entry.slots.some((slot) => slot === null)) return null
    this.parts.delete(id)
    const total = entry.slots.reduce((size, slot) => size + slot!.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const slot of entry.slots) {
      out.set(slot!, offset)
      offset += slot!.length
    }
    return out
  }
}

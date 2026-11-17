// What Kettu's shared code takes from a browser and React Native may lack: secure random values,
// DOMException, structuredClone, URL.parse and a UTF-8 TextDecoder that can be fatal. Each is set
// only when missing, so a newer React Native that has it keeps its own.

import { getRandomValues } from 'expo-crypto'

const g = globalThis as unknown as Record<string, unknown>

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(globalThis.crypto ?? {}), getRandomValues }
}

if (typeof g.DOMException === 'undefined') {
  class DOMExceptionShim extends Error {
    constructor(message = '', name = 'Error') {
      super(message)
      this.name = name
    }
  }
  g.DOMException = DOMExceptionShim
}

if (typeof g.structuredClone !== 'function') {
  g.structuredClone = (value: unknown) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const urlClass = URL as unknown as { parse?: (url: string, base?: string) => URL | null }
if (typeof urlClass.parse !== 'function') {
  urlClass.parse = (url, base) => {
    try {
      return new URL(url, base)
    } catch {
      return null
    }
  }
}

/** UTF-8 alone, as the channel decodes it; `fatal` throws on a malformed sequence. */
class Utf8Decoder {
  readonly encoding = 'utf-8'
  readonly fatal: boolean

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Only UTF-8 is decoded here, not ${label}`)
    this.fatal = options.fatal === true
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return ''
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    let out = ''
    let chunk: number[] = []
    const bad = (): void => {
      if (this.fatal) throw new TypeError('The bytes are not valid UTF-8')
      chunk.push(0xfffd)
    }
    for (let i = 0; i < bytes.length; ) {
      const b0 = bytes[i]!
      let code = -1
      let need = 0
      if (b0 < 0x80) {
        code = b0
      } else if (b0 >= 0xc2 && b0 <= 0xdf) {
        code = b0 & 0x1f
        need = 1
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        code = b0 & 0x0f
        need = 2
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        code = b0 & 0x07
        need = 3
      }
      // A lead byte that starts nothing, or a sequence cut off by the end.
      if (code < 0 || i + need >= bytes.length) {
        bad()
        i++
        continue
      }
      let ok = true
      for (let k = 1; k <= need; k++) {
        const b = bytes[i + k]
        if (b === undefined || (b & 0xc0) !== 0x80) {
          ok = false
          break
        }
        code = (code << 6) | (b & 0x3f)
      }
      const min = [0, 0x80, 0x800, 0x10000][need]!
      if (!ok || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        bad()
        i++
        continue
      }
      chunk.push(code)
      i += need + 1
      if (chunk.length >= 4096) {
        out += String.fromCodePoint(...chunk)
        chunk = []
      }
    }
    return out + String.fromCodePoint(...chunk)
  }
}

let decoderWorks = false
try {
  decoderWorks =
    typeof g.TextDecoder === 'function' &&
    new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xe7, 0x8b, 0x90])) === '狐'
} catch {
  decoderWorks = false
}
if (!decoderWorks) g.TextDecoder = Utf8Decoder

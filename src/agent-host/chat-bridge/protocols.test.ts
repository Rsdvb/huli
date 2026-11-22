import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseChatBridgeConfig } from '@shared/chat-bridge'
import { decodeFrame, encodeFrame, FrameParts, header, type Frame } from './feishu-frame'
import { decryptWeComFile } from './wecom'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('Feishu frames', () => {
  it('encodes a ping as the SDKs do', () => {
    const ping: Frame = {
      seqId: 0n,
      logId: 0n,
      service: 3,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    }
    // Fields 1 to 4 as varints, even when 0; the header as a nested message of two strings.
    expect(hex(encodeFrame(ping))).toBe('0800100018032000' + '2a0c0a0474797065120470696e67')
  })

  it('decodes what it encodes, payload and large ids included', () => {
    const frame: Frame = {
      seqId: 2n ** 63n + 5n,
      logId: 123456789012345n,
      service: 1234,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg-1' },
        { key: 'sum', value: '1' },
      ],
      payloadEncoding: 'json',
      payloadType: 'event',
      payload: new TextEncoder().encode('{"schema":"2.0","中":"文"}'),
      logIdNew: 'abc',
    }
    const decoded = decodeFrame(encodeFrame(frame))
    expect(decoded).toEqual(frame)
    expect(header(decoded, 'message_id')).toBe('msg-1')
  })

  it('reads a negative service as an int32', () => {
    const frame: Frame = { seqId: 1n, logId: 1n, service: -2, method: 1, headers: [] }
    expect(decodeFrame(encodeFrame(frame)).service).toBe(-2)
  })

  it('skips fields it does not know', () => {
    const known = encodeFrame({ seqId: 1n, logId: 2n, service: 3, method: 1, headers: [] })
    // Field 15 as a varint, and field 14 as bytes.
    const extra = Uint8Array.from([...known, 0x78, 0x05, 0x72, 0x02, 0x01, 0x02])
    expect(decodeFrame(extra).service).toBe(3)
  })

  it('refuses bytes that are not a frame', () => {
    expect(() => decodeFrame(Uint8Array.from([0x08]))).toThrow()
    expect(() => decodeFrame(Uint8Array.from([0x08, 0x01]))).toThrow(/field 2/)
    expect(() => decodeFrame(Uint8Array.from([0x42, 0x10, 0x01]))).toThrow()
  })

  it('puts a payload sent in parts back together, in any order', () => {
    const parts = new FrameParts()
    const part = (seq: number, text: string): Frame => ({
      seqId: 1n,
      logId: 1n,
      service: 1,
      method: 1,
      headers: [
        { key: 'message_id', value: 'm' },
        { key: 'sum', value: '3' },
        { key: 'seq', value: String(seq) },
      ],
      payload: new TextEncoder().encode(text),
    })
    expect(parts.add(part(2, 'c'), 0)).toBeNull()
    expect(parts.add(part(0, 'a'), 1)).toBeNull()
    expect(new TextDecoder().decode(parts.add(part(1, 'b'), 2)!)).toBe('abc')
    // A part out of range is no part.
    expect(parts.add(part(5, 'x'), 3)).toBeNull()
  })
})

describe('WeCom files', () => {
  function encrypt(plain: Buffer, key: Buffer): Buffer {
    const pad = 32 - (plain.length % 32)
    const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)])
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(padded), cipher.final()])
  }

  it('decrypts a file with its key, padded to 32 bytes', () => {
    const key = randomBytes(32)
    for (const size of [0, 1, 31, 32, 33, 1000]) {
      const plain = randomBytes(size)
      expect(decryptWeComFile(encrypt(plain, key), key.toString('base64'))).toEqual(plain)
    }
  })

  it('refuses a file the key does not open', () => {
    const plain = Buffer.from('a picture')
    const encrypted = encrypt(plain, randomBytes(32))
    expect(() => decryptWeComFile(encrypted, randomBytes(32).toString('base64'))).toThrow()
    expect(() => decryptWeComFile(encrypted, randomBytes(16).toString('base64'))).toThrow()
    expect(() =>
      decryptWeComFile(encrypted.subarray(1), randomBytes(32).toString('base64')),
    ).toThrow()
  })
})

describe('parseChatBridgeConfig', () => {
  const account = { id: '42', name: 'Owner', chatId: null, boundAt: 1 }

  it('keeps a valid configuration and only the credentials a platform has', () => {
    const config = parseChatBridgeConfig({
      platforms: {
        telegram: { enabled: true, credentials: { token: '1:a', extra: 'x' }, accounts: [account] },
      },
      binding: { platform: 'telegram', code: '123456', expiresAt: 5 },
    })
    expect(config).toEqual({
      platforms: {
        telegram: { enabled: true, credentials: { token: '1:a' }, accounts: [account] },
      },
      binding: { platform: 'telegram', code: '123456', expiresAt: 5 },
    })
  })

  it('refuses what is not one', () => {
    const base = { enabled: true, credentials: {}, accounts: [] }
    for (const value of [
      null,
      { platforms: [] },
      { platforms: { slack: base } },
      { platforms: { telegram: { ...base, enabled: 'yes' } } },
      { platforms: { telegram: { ...base, credentials: { token: 'has space' } } } },
      { platforms: { telegram: { ...base, accounts: [account, account] } } },
      { platforms: { telegram: { ...base, accounts: [{ ...account, id: '' }] } } },
      { platforms: {}, binding: { platform: 'telegram', code: '12345', expiresAt: 1 } },
    ]) {
      expect(parseChatBridgeConfig(value)).toBeNull()
    }
  })
})

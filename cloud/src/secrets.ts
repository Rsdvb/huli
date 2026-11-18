// Tokens, password hashes and one-time codes (RFC 6238), on node:crypto alone.

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )

/** A random token in base64url, `bytes` long before encoding. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// scrypt with N = 2^15, r = 8, p = 1: about 32 MiB and tens of milliseconds a guess.
const LOG_N = 15
const R = 8
const P = 1
const KEY_BYTES = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_BYTES, {
    N: 2 ** LOG_N,
    r: R,
    p: P,
    maxmem: 128 * 1024 * 1024,
  })
  return ['scrypt', LOG_N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, logN, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error('Not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const TOTP_PERIOD_S = 30

/** A new TOTP secret: 20 random bytes in base32, as authenticator apps take it. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The HOTP value of `counter` (RFC 4226) with `digits` digits, HMAC-SHA1. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(message).digest()
  const offset = mac[mac.length - 1]! & 15
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return code.toString().padStart(digits, '0')
}

/**
 * The time step `code` belongs to, one step either side of now allowed, or null. A step at or
 * before `lastStep` is refused, so a code works once.
 */
export function checkTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastStep: number,
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const now = Math.floor(nowMs / 1000 / TOTP_PERIOD_S)
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && sameText(hotp(key, step), code)) return step
  }
  return null
}

export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`Kite Cloud:${account}`)
  const params = new URLSearchParams({ secret, issuer: 'Kite Cloud', period: '30', digits: '6' })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** Ten one-time recovery codes, shown once; only their hashes are kept. */
export function newRecoveryCodes(): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 10 }, () => {
    let code = ''
    for (let i = 0; i < 10; i++) code += alphabet[randomInt(alphabet.length)]
    return `${code.slice(0, 5)}-${code.slice(5)}`
  })
}

export function normalizeRecovery(code: string): string {
  return code.trim().toLowerCase()
}

/** RFC 7636 S256: base64url of the verifier's SHA-256. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

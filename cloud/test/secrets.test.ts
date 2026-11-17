import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  checkTotp,
  hashPassword,
  hotp,
  pkceChallenge,
  verifyPassword,
} from '../src/secrets'

// RFC 6238 appendix B, SHA-1, with the last six of the eight digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('one-time codes', () => {
  it('match RFC 6238', () => {
    const key = base32Decode(RFC_SECRET)
    expect(hotp(key, 1, 8)).toBe('94287082')
    expect(hotp(key, 37037036, 8)).toBe('07081804')
    expect(hotp(key, 37037037, 8)).toBe('14050471')
  })

  it('take a code once, one step either side of now', () => {
    expect(checkTotp(RFC_SECRET, '287082', 59_000, -1)).toBe(1)
    expect(checkTotp(RFC_SECRET, '287082', 59_000, 1)).toBeNull()
    expect(checkTotp(RFC_SECRET, '287082', 200_000, -1)).toBeNull()
    expect(checkTotp(RFC_SECRET, '28708', 59_000, -1)).toBeNull()
  })
})

describe('passwords', () => {
  it('verify only the password they were made from', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$15$8$1$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false)
    expect(await verifyPassword('x', 'not a hash')).toBe(false)
  })
})

describe('PKCE', () => {
  it('matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})

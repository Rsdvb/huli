// Bytes as the viewer passes them into pages: base64 and data URLs, and UTF-8 text.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PAIRS: string[] = []
for (let i = 0; i < 4096; i++) PAIRS.push(ALPHABET[i >> 6]! + ALPHABET[i & 63]!)

/** Base64 of the bytes, built a chunk at a time so a large file never makes one huge array. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const whole = bytes.length - (bytes.length % 3)
  const CHUNK = 3 * 8192
  for (let start = 0; start < whole; start += CHUNK) {
    const end = Math.min(whole, start + CHUNK)
    let out = ''
    for (let i = start; i < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
      out += PAIRS[n >> 12]! + PAIRS[n & 4095]!
    }
    parts.push(out)
  }
  const rest = bytes.length - whole
  if (rest === 1) {
    const n = bytes[whole]! << 16
    parts.push(`${PAIRS[n >> 12]!}==`)
  } else if (rest === 2) {
    const n = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8)
    parts.push(`${PAIRS[n >> 12]!}${ALPHABET[(n >> 6) & 63]!}=`)
  }
  return parts.join('')
}

export function dataUrl(type: string, bytes: Uint8Array): string {
  // The charset parameter adds nothing to base64 and some parsers stumble on it.
  return `data:${type.split(';')[0]};base64,${toBase64(bytes)}`
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text)
}

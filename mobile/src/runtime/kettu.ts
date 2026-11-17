// Kettu's channel on React Native: the noble libraries for its cryptography, since there is no
// crypto.subtle, and fflate for the raw deflate its larger JSON messages travel in, since there
// are no compression streams. Both are the hooks the shared code keeps for such a runtime.

import { Deflate, Inflate } from 'fflate'
import { setCompression } from '@shared/remote/channel'
import { noblePrimitives } from '@shared/remote/noble-primitives'
import { setPrimitives } from '@shared/remote/primitives'

setPrimitives(noblePrimitives)

class TooLong extends Error {}

function join(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

setCompression({
  async deflate(body) {
    const parts: Uint8Array[] = []
    let length = 0
    const stream = new Deflate((chunk) => {
      parts.push(chunk)
      length += chunk.length
    })
    stream.push(body, true)
    return join(parts, length)
  },
  async inflate(body, limit) {
    const parts: Uint8Array[] = []
    let length = 0
    const stream = new Inflate((chunk) => {
      length += chunk.length
      if (length > limit) throw new TooLong()
      parts.push(chunk)
    })
    try {
      stream.push(body, true)
    } catch (error) {
      if (error instanceof TooLong) return null
      throw error
    }
    return join(parts, length)
  },
})
